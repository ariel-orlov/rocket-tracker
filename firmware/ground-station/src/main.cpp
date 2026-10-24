// =====================================================================
//  Rocket Tracker  -  GROUND STATION
//  Heltec Wireless Tracker V1.1 (ESP32-S3 + SX1262 + UC6580 GNSS + 0.96" TFT)
//
//  Listens for the flight unit, shows the rocket's position, distance and
//  bearing from you, and saves the last good fix so a reboot can't lose it.
//
//  Libraries: RadioLib, TinyGPSPlus, Adafruit GFX, Adafruit ST7735 and ST7789
// =====================================================================
#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>
#include <TinyGPSPlus.h>
#include <Preferences.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>

// ----------------------------- SETTINGS ------------------------------
// MUST match the flight unit exactly
#define TEAM_ID       0x2A
#define RF_FREQ_MHZ   915.0
#define RF_BW_KHZ     500.0
#define RF_SF         11
#define RF_CR         5
#define RF_SYNC       0x12
#define RF_PREAMBLE   8
#define TCXO_VOLTS    1.8

// ------------------------------- PINS --------------------------------
// From the Meshtastic heltec_wireless_tracker variant (V1.1 board)
#define LORA_SCK   9
#define LORA_MISO  11
#define LORA_MOSI  10
#define LORA_NSS   8
#define LORA_RST   12
#define LORA_BUSY  13
#define LORA_DIO1  14
#define GNSS_RX    33   // ESP32 receives GNSS data here
#define GNSS_TX    34
#define GNSS_RST   35   // LOW = reset, keep HIGH
#define GNSS_BAUD  115200
#define VEXT_PIN   3    // HIGH powers GNSS + TFT (V1.1)
#define TFT_CS     38
#define TFT_DC     40
#define TFT_RST    39
#define TFT_SCLK   41
#define TFT_MOSI   42
#define TFT_BL     21

// --------------------------- PACKET FORMAT ---------------------------
struct __attribute__((packed)) TrackerPacket {
  uint8_t  magic;
  uint8_t  teamId;
  uint16_t seq;
  int32_t  lat_e7;
  int32_t  lon_e7;
  int16_t  alt_m;
  uint8_t  sats;
  uint8_t  flags;
  uint16_t fixAge_ds;
  uint16_t batt_mV;
  uint16_t maxAgl_m;
};
static_assert(sizeof(TrackerPacket) == 22, "packet must be 22 bytes");

#define FLAG_FIX     0x01
#define FLAG_FRESH   0x02
#define FLAG_PADSET  0x04
#define FLAG_FLIGHT  0x08
#define FLAG_LANDED  0x10
#define FLAG_LOWBATT 0x20

// ------------------------------ GLOBALS ------------------------------
SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
TinyGPSPlus myGps;
Preferences prefs;
Adafruit_ST7735 tft(TFT_CS, TFT_DC, TFT_MOSI, TFT_SCLK, TFT_RST);   // software SPI

volatile bool rxFlag = false;
TrackerPacket last = {};
bool haveLast = false;         // any packet this session
float lastRssi = 0, lastSnr = 0;
uint32_t lastRxMs = 0, rxCount = 0;

int32_t savedLat = 0, savedLon = 0;   // last FIX'd position, survives reboot
bool haveSaved = false;
uint32_t lastSaveMs = 0, lastDraw = 0, lastMeMs = 0;

void IRAM_ATTR onRx() { rxFlag = true; }

// ------------------------------ HELPERS ------------------------------
const char *stateText(uint8_t f) {
  if (f & FLAG_LANDED) return "LANDED";
  if (f & FLAG_FLIGHT) return "FLIGHT";
  if (f & FLAG_PADSET) return "PAD-READY";
  return "PAD-NOFIX";
}

void saveFix(int32_t lat, int32_t lon) {
  savedLat = lat; savedLon = lon; haveSaved = true;
  if (millis() - lastSaveMs > 5000) {            // limit flash writes
    prefs.putInt("lat", lat);
    prefs.putInt("lon", lon);
    lastSaveMs = millis();
  }
}

void draw() {
  char line[32];
  tft.fillScreen(ST77XX_BLACK);
  tft.setCursor(0, 0);
  tft.setTextColor(ST77XX_WHITE);

  if (haveLast) {
    uint32_t ago = (millis() - lastRxMs) / 1000;
    tft.setTextColor(ago < 5 ? ST77XX_GREEN : ST77XX_RED);
    snprintf(line, sizeof(line), "RX#%u %lus ago %ddB\n", last.seq, (unsigned long)ago, (int)lastRssi);
    tft.print(line);
    tft.setTextColor(ST77XX_WHITE);
    snprintf(line, sizeof(line), "%s sats%u %umV\n", stateText(last.flags), last.sats, last.batt_mV);
    tft.print(line);
  } else {
    tft.print("Waiting for rocket...\n\n");
  }

  if (haveSaved) {
    double rLat = savedLat / 1e7, rLon = savedLon / 1e7;
    tft.setTextColor(ST77XX_YELLOW);
    snprintf(line, sizeof(line), "%.6f\n%.6f\n", rLat, rLon);
    tft.print(line);
    if (myGps.location.isValid() && myGps.location.age() < 5000) {
      double d = TinyGPSPlus::distanceBetween(myGps.location.lat(), myGps.location.lng(), rLat, rLon);
      double b = TinyGPSPlus::courseTo(myGps.location.lat(), myGps.location.lng(), rLat, rLon);
      tft.setTextColor(ST77XX_CYAN);
      tft.setTextSize(2);
      snprintf(line, sizeof(line), "%.0fm %03.0f%s\n", d, b, TinyGPSPlus::cardinal(b));
      tft.print(line);
      tft.setTextSize(1);
    } else {
      tft.setTextColor(ST77XX_RED);
      tft.print("No GPS here yet (go outside)\n");
    }
    if (haveLast) {
      tft.setTextColor(ST77XX_WHITE);
      snprintf(line, sizeof(line), "max %um AGL (GPS)\n", last.maxAgl_m);
      tft.print(line);
    }
  }
}

// ------------------------------ ARDUINO ------------------------------
void setup() {
  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);
#endif
  pinMode(VEXT_PIN, OUTPUT); digitalWrite(VEXT_PIN, HIGH);   // power GNSS + screen
  pinMode(GNSS_RST, OUTPUT); digitalWrite(GNSS_RST, HIGH);
  delay(200);
  pinMode(TFT_BL, OUTPUT); digitalWrite(TFT_BL, HIGH);
  tft.initR(INITR_MINI160x80);        // if colors look inverted: INITR_MINI160x80_PLUGIN
  tft.setRotation(1);
  tft.fillScreen(ST77XX_BLACK);

  Serial1.setRxBufferSize(1024);
  Serial1.begin(GNSS_BAUD, SERIAL_8N1, GNSS_RX, GNSS_TX);

  prefs.begin("arctrk", false);
  savedLat = prefs.getInt("lat", 0);
  savedLon = prefs.getInt("lon", 0);
  haveSaved = (savedLat != 0 || savedLon != 0);
  if (haveSaved) Serial.printf("Last saved fix: %.7f,%.7f\n", savedLat / 1e7, savedLon / 1e7);

  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int st = radio.begin(RF_FREQ_MHZ, RF_BW_KHZ, RF_SF, RF_CR, RF_SYNC, 10, RF_PREAMBLE, TCXO_VOLTS);
  if (st != RADIOLIB_ERR_NONE) {
    Serial.printf("radio.begin failed: %d\n", st);
    tft.setTextColor(ST77XX_RED);
    tft.printf("RADIO FAIL %d", st);
    while (true) delay(1000);
  }
  radio.setDio2AsRfSwitch(true);
  radio.setCRC(true);
  radio.setPacketReceivedAction(onRx);
  radio.startReceive();
  Serial.println("seq,state,lat,lon,alt_m,sats,fresh,batt_mV,maxAgl_m,rssi,snr,maps");
  draw();
}

void loop() {
  while (Serial1.available()) myGps.encode(Serial1.read());

  if (rxFlag) {
    rxFlag = false;
    TrackerPacket p;
    size_t len = radio.getPacketLength();
    int st = radio.readData((uint8_t *)&p, sizeof(p));
    if (st == RADIOLIB_ERR_NONE && len == sizeof(p) && p.magic == 0xA7 && p.teamId == TEAM_ID) {
      last = p; haveLast = true; lastRxMs = millis(); rxCount++;
      lastRssi = radio.getRSSI(); lastSnr = radio.getSNR();
      if (p.flags & FLAG_FIX) saveFix(p.lat_e7, p.lon_e7);
      Serial.printf("%u,%s,%.7f,%.7f,%d,%u,%d,%u,%u,%.0f,%.1f,https://maps.google.com/?q=%.7f,%.7f\n",
                    p.seq, stateText(p.flags), p.lat_e7 / 1e7, p.lon_e7 / 1e7, p.alt_m, p.sats,
                    (p.flags & FLAG_FRESH) ? 1 : 0, p.batt_mV, p.maxAgl_m, lastRssi, lastSnr,
                    p.lat_e7 / 1e7, p.lon_e7 / 1e7);
    }
    radio.startReceive();
  }

  // Our own position, for the web app's distance/bearing: ME,lat,lon,alt_m,sats
  if (millis() - lastMeMs > 2000) {
    lastMeMs = millis();
    if (myGps.location.isValid() && myGps.location.age() < 5000)
      Serial.printf("ME,%.7f,%.7f,%d,%u\n", myGps.location.lat(), myGps.location.lng(),
                    (int)myGps.altitude.meters(), (unsigned)myGps.satellites.value());
    else
      Serial.printf("ME,nofix,%u\n", (unsigned)myGps.satellites.value());
  }

  if (millis() - lastDraw > 1000) { lastDraw = millis(); draw(); }
}
