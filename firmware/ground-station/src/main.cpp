// =====================================================================
//  Rocket Tracker  -  GROUND STATION
//  Heltec Wireless Tracker V1.1 or V2 (ESP32-S3 + SX1262 + UC6580 GNSS + 0.96" TFT)
//
//  Listens for the flight unit, shows the rocket's position, distance and
//  bearing from you, and saves the last good fix so a reboot can't lose it.
//  Talks to the web app over USB or Bluetooth LE (Nordic UART service): the
//  same text lines go out on both, and commands come in on both.
//
//  Commands: INFO, BUZZ <seconds> (0 = stop), LANDBEEP ON|OFF, QUIET ON|OFF,
//  CANCEL, FORGET. BUZZ / LANDBEEP / QUIET are sent to the rocket only in
//  non-competition mode; in competition mode it never listens, so they're refused.
//  PRG button: short press = buzz 30 s, hold 1 s = stop.
//
//  Libraries: RadioLib, TinyGPSPlus, Adafruit GFX, Adafruit ST7735 and ST7789,
//  NimBLE-Arduino
// =====================================================================
#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>
#include <TinyGPSPlus.h>
#include <Preferences.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <NimBLEDevice.h>

// ----------------------------- SETTINGS ------------------------------
#define FW_VERSION    3
// MUST match the flight unit exactly
#define TEAM_ID       0x2A
#define RF_FREQ_MHZ   915.0
#define RF_BW_KHZ     500.0
#define RF_SF         11
#define RF_CR         5
#define RF_SYNC       0x12
#define RF_PREAMBLE   8
#define TCXO_VOLTS    1.8
#define TX_DBM        10    // commands only. On V2 the front end's amplifier adds to this
#define CMD_TRIES     6     // packets to wait for the rocket to confirm a command
#define BLE_NAME      "Rocket Tracker GS"

// ------------------------------- PINS --------------------------------
// From the Meshtastic heltec_wireless_tracker variants
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
#define VEXT_PIN   3    // HIGH powers GNSS + TFT
#define TFT_CS     38
#define TFT_DC     40
#define TFT_RST    39
#define TFT_SCLK   41
#define TFT_MOSI   42
#define TFT_BL     21
#define BUTTON_PIN 0    // PRG button, LOW = pressed
// Wireless Tracker V2 only: KCT8103L RF front end (from the Meshtastic v2 variant).
// It must be powered and set to receive, or the radio hears nothing.
// On V1.1 these are unused header pins, so driving them is harmless there.
#define FEM_POWER  7    // HIGH = front-end LDO on
#define FEM_CSD    4    // HIGH = front end enabled
#define FEM_CTX    5    // LOW = receive through the low-noise amplifier, HIGH = transmit

// --------------------------- PACKET FORMAT ---------------------------
// Firmware 3 sends 23 bytes (cfg added); firmware 2 sent the first 22.
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
  uint8_t  cfg;
};
static_assert(sizeof(TrackerPacket) == 23, "packet must be 23 bytes");
#define LEGACY_LEN 22

#define FLAG_FIX     0x01
#define FLAG_FRESH   0x02
#define FLAG_PADSET  0x04
#define FLAG_FLIGHT  0x08
#define FLAG_LANDED  0x10
#define FLAG_LOWBATT 0x20

#define CFG_NONCOMP   0x01
#define CFG_LANDBEEP 0x02
#define CFG_BUZZING  0x04
#define CFG_QUIET    0x08

struct __attribute__((packed)) CommandPacket {
  uint8_t magic;
  uint8_t teamId;
  uint8_t cmd;
  uint8_t arg;
};
#define CMD_MAGIC    0xC3
#define CMD_BUZZ     1
#define CMD_LANDBEEP 2
#define CMD_QUIET    3

// ------------------------------ GLOBALS ------------------------------
SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
TinyGPSPlus myGps;
Preferences prefs;
Adafruit_ST7735 tft(TFT_CS, TFT_DC, TFT_MOSI, TFT_SCLK, TFT_RST);   // software SPI

volatile bool rxFlag = false;
TrackerPacket last = {};
bool haveLast = false;         // any packet this session
bool lastHasCfg = false;       // false = rocket runs firmware 2
float lastRssi = 0, lastSnr = 0;
uint32_t lastRxMs = 0, rxCount = 0, crcCount = 0, otherCount = 0;

int32_t savedLat = 0, savedLon = 0;   // last FIX'd position, survives reboot
bool haveSaved = false;
uint32_t lastSaveMs = 0, lastDraw = 0, lastMeMs = 0, lastStatMs = 0;

// A command waiting for the rocket's next packet
struct {
  bool active;
  uint8_t cmd, arg, tries;
  uint32_t since;
} pending = {};

void IRAM_ATTR onRx() { rxFlag = true; }

// ------------------------------- BLE ---------------------------------
#define NUS_SERVICE "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX      "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"   // app writes commands
#define NUS_TX      "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"   // we notify lines
NimBLECharacteristic *bleTx = nullptr;
volatile bool bleConnected = false;
volatile uint16_t bleMtu = 23;
portMUX_TYPE bleMux = portMUX_INITIALIZER_UNLOCKED;
String bleIn;                  // filled by the BLE task, drained by loop()

class ServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *, NimBLEConnInfo &) override { bleConnected = true; }
  void onDisconnect(NimBLEServer *, NimBLEConnInfo &, int) override {
    bleConnected = false; bleMtu = 23;
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, NimBLEConnInfo &) override { bleMtu = mtu; }
};

class RxCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &) override {
    std::string v = c->getValue();
    portENTER_CRITICAL(&bleMux);
    if (bleIn.length() < 256) bleIn += v.c_str();
    portEXIT_CRITICAL(&bleMux);
  }
};

void bleInit() {
  NimBLEDevice::init(BLE_NAME);
  NimBLEDevice::setMTU(247);
  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCb());
  NimBLEService *svc = server->createService(NUS_SERVICE);
  bleTx = svc->createCharacteristic(NUS_TX, NIMBLE_PROPERTY::NOTIFY);
  NimBLECharacteristic *rx = svc->createCharacteristic(NUS_RX, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  rx->setCallbacks(new RxCb());
  svc->start();
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE);
  NimBLEAdvertisementData scan;
  scan.setName(BLE_NAME);
  adv->setScanResponseData(scan);
  adv->enableScanResponse(true);
  adv->start();
}

// Every line goes to USB and, when the app is connected, to Bluetooth.
void out(const char *fmt, ...) {
  char buf[200];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof(buf) - 1, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  if (n > (int)sizeof(buf) - 2) n = sizeof(buf) - 2;
  buf[n++] = '\n';
  Serial.write((const uint8_t *)buf, n);
  if (bleConnected && bleTx) {
    size_t chunk = bleMtu > 3 ? bleMtu - 3 : 20;
    for (int i = 0; i < n; i += chunk) bleTx->notify((const uint8_t *)buf + i, min<size_t>(chunk, n - i));
  }
}

// ------------------------------ HELPERS ------------------------------
const char *stateText(uint8_t f) {
  if (f & FLAG_LANDED) return "LANDED";
  if (f & FLAG_FLIGHT) return "FLIGHT";
  if (f & FLAG_PADSET) return "PAD-READY";
  return "PAD-NOFIX";
}

const char *cmdName(uint8_t c) {
  return c == CMD_BUZZ ? "BUZZ" : c == CMD_LANDBEEP ? "LANDBEEP" : "QUIET";
}

void saveFix(int32_t lat, int32_t lon) {
  savedLat = lat; savedLon = lon; haveSaved = true;
  if (millis() - lastSaveMs > 5000) {            // limit flash writes
    prefs.putInt("lat", lat);
    prefs.putInt("lon", lon);
    lastSaveMs = millis();
  }
}

void femReceive()  { digitalWrite(FEM_CTX, LOW); }
void femTransmit() { digitalWrite(FEM_CTX, HIGH); }

void printInfo() {
  out("GS,fw=%d,team=%02X,freq=%.1f,bw=%.0f,sf=%d,ble=1,name=%s", FW_VERSION, TEAM_ID,
      RF_FREQ_MHZ, RF_BW_KHZ, RF_SF, BLE_NAME);
}

void queueCommand(uint8_t cmd, uint8_t arg) {
  pending = { true, cmd, arg, 0, millis() };
  out("ACK,%s,%u,queued", cmdName(cmd), arg);
}

// Does the rocket's cfg byte show that the command took effect?
bool commandDone(const TrackerPacket &p) {
  bool on = pending.arg != 0;
  switch (pending.cmd) {
    case CMD_BUZZ:     return ((p.cfg & CFG_BUZZING) != 0) == on;
    case CMD_LANDBEEP: return ((p.cfg & CFG_LANDBEEP) != 0) == on;
    case CMD_QUIET:    return ((p.cfg & CFG_QUIET) != 0) == on;
  }
  return true;
}

// Called right after each packet from the rocket. A non-competition rocket listens for
// 400 ms after every packet, so this is the moment to talk.
void serviceCommand(const TrackerPacket &p, bool hasCfg) {
  if (!pending.active) return;
  const char *name = cmdName(pending.cmd);
  if (!hasCfg) { out("CMD,refused,%s,%u,oldfw", name, pending.arg); pending.active = false; return; }
  if (!(p.cfg & CFG_NONCOMP)) { out("CMD,refused,%s,%u,comp", name, pending.arg); pending.active = false; return; }
  if (pending.tries > 0 && commandDone(p)) { out("CMD,done,%s,%u", name, pending.arg); pending.active = false; return; }
  if (pending.tries >= CMD_TRIES) { out("CMD,failed,%s,%u,noconfirm", name, pending.arg); pending.active = false; return; }

  CommandPacket c = { CMD_MAGIC, TEAM_ID, pending.cmd, pending.arg };
  delay(25);                                   // give the rocket time to switch to receive
  femTransmit();
  int st = radio.transmit((uint8_t *)&c, sizeof(c));
  femReceive();
  rxFlag = false;                              // the TX-done interrupt set it
  radio.startReceive();
  pending.tries++;
  if (st == RADIOLIB_ERR_NONE) out("CMD,sent,%s,%u,try=%u", name, pending.arg, pending.tries);
  else out("CMD,txerror,%s,%u,%d", name, pending.arg, st);
}

// ------------------------------ COMMANDS -----------------------------
bool parseOnOff(const String &v, uint8_t &out) {
  if (v == "ON" || v == "1")  { out = 1; return true; }
  if (v == "OFF" || v == "0") { out = 0; return true; }
  return false;
}

void handleLine(String line) {
  line.trim();
  line.toUpperCase();
  if (!line.length()) return;
  int sp = line.indexOf(' ');
  String cmd = sp < 0 ? line : line.substring(0, sp);
  String arg = sp < 0 ? "" : line.substring(sp + 1);
  arg.trim();
  uint8_t v;

  if (cmd == "INFO") { printInfo(); return; }
  if (cmd == "BUZZ") { long s = arg.length() ? arg.toInt() : 30; queueCommand(CMD_BUZZ, (uint8_t)constrain(s, 0, 255)); return; }
  if (cmd == "LANDBEEP" && parseOnOff(arg, v)) { queueCommand(CMD_LANDBEEP, v); return; }
  if (cmd == "QUIET" && parseOnOff(arg, v))    { queueCommand(CMD_QUIET, v); return; }
  if (cmd == "CANCEL") {
    if (pending.active) out("CMD,cancelled,%s,%u", cmdName(pending.cmd), pending.arg);
    pending.active = false;
    return;
  }
  if (cmd == "FORGET") {
    prefs.remove("lat"); prefs.remove("lon");
    savedLat = savedLon = 0; haveSaved = false;
    out("ACK,FORGET");
    return;
  }
  out("ERR,unknown command: %s", line.c_str());
}

String usbBuf;
void readCommands() {
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') { if (usbBuf.length()) handleLine(usbBuf); usbBuf = ""; }
    else if (usbBuf.length() < 64) usbBuf += ch;
  }
  String ble;
  portENTER_CRITICAL(&bleMux);
  int nl = bleIn.indexOf('\n');
  if (nl >= 0) { ble = bleIn.substring(0, nl); bleIn.remove(0, nl + 1); }
  portEXIT_CRITICAL(&bleMux);
  if (ble.length()) handleLine(ble);
}

// PRG button: short press = buzz 30 s, hold 1 s = stop.
uint32_t pressedAt = 0;
void readButton() {
  bool down = digitalRead(BUTTON_PIN) == LOW;
  if (down && !pressedAt) pressedAt = millis();
  if (!down && pressedAt) {
    uint32_t held = millis() - pressedAt;
    pressedAt = 0;
    if (held > 40) queueCommand(CMD_BUZZ, held >= 1000 ? 0 : 30);
  }
}

// ------------------------------ DISPLAY ------------------------------
void draw() {
  char line[32];
  tft.fillScreen(ST77XX_BLACK);
  tft.setCursor(0, 0);
  tft.setTextColor(ST77XX_WHITE);

  if (haveLast) {
    uint32_t ago = (millis() - lastRxMs) / 1000;
    tft.setTextColor(ago < 5 ? ST77XX_GREEN : ST77XX_RED);
    snprintf(line, sizeof(line), "RX#%u %lus %ddB%s\n", last.seq, (unsigned long)ago, (int)lastRssi, bleConnected ? " BT" : "");
    tft.print(line);
    tft.setTextColor(ST77XX_WHITE);
    const char *mode = !lastHasCfg ? "" : (last.cfg & CFG_NONCOMP) ? " NONCOMP" : " COMP";
    snprintf(line, sizeof(line), "%s%s s%u %umV\n", stateText(last.flags), mode, last.sats, last.batt_mV);
    tft.print(line);
  } else {
    tft.print(bleConnected ? "Waiting for rocket... BT\n\n" : "Waiting for rocket...\n\n");
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
  }
  if (pending.active) {
    tft.setTextColor(ST77XX_MAGENTA);
    snprintf(line, sizeof(line), "%s %u: sending (%u)\n", cmdName(pending.cmd), pending.arg, pending.tries);
    tft.print(line);
  } else if (haveLast) {
    tft.setTextColor(ST77XX_WHITE);
    snprintf(line, sizeof(line), "max %um AGL%s\n", last.maxAgl_m,
             lastHasCfg && (last.cfg & CFG_BUZZING) ? " BUZZING" : "");
    tft.print(line);
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
  pinMode(FEM_POWER, OUTPUT); digitalWrite(FEM_POWER, HIGH);
  pinMode(FEM_CSD, OUTPUT);   digitalWrite(FEM_CSD, HIGH);
  pinMode(FEM_CTX, OUTPUT);   femReceive();
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  delay(200);
  pinMode(TFT_BL, OUTPUT); digitalWrite(TFT_BL, HIGH);
  tft.initR(INITR_MINI160x80);        // if colors look inverted: INITR_MINI160x80_PLUGIN
  tft.setRotation(1);
  tft.fillScreen(ST77XX_BLACK);

  Serial1.setRxBufferSize(1024);
  Serial1.begin(GNSS_BAUD, SERIAL_8N1, GNSS_RX, GNSS_TX);

  bleInit();

  prefs.begin("rtgs", false);
  savedLat = prefs.getInt("lat", 0);
  savedLon = prefs.getInt("lon", 0);
  haveSaved = (savedLat != 0 || savedLon != 0);
  if (haveSaved) out("Last saved fix: %.7f,%.7f", savedLat / 1e7, savedLon / 1e7);

  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int st = radio.begin(RF_FREQ_MHZ, RF_BW_KHZ, RF_SF, RF_CR, RF_SYNC, TX_DBM, RF_PREAMBLE, TCXO_VOLTS);
  if (st != RADIOLIB_ERR_NONE) {
    out("radio.begin failed: %d", st);
    tft.setTextColor(ST77XX_RED);
    tft.printf("RADIO FAIL %d", st);
    while (true) { readCommands(); delay(50); }   // still answers INFO so the app can show it
  }
  radio.setDio2AsRfSwitch(true);
  radio.setCRC(true);
  radio.setPacketReceivedAction(onRx);
  radio.startReceive();
  out("radio OK");
  printInfo();
  out("seq,state,lat,lon,alt_m,sats,fresh,batt_mV,maxAgl_m,rssi,snr,flags,cfg,age_s,maps");
  draw();
}

void loop() {
  while (Serial1.available()) myGps.encode(Serial1.read());
  readCommands();
  readButton();

  if (rxFlag) {
    rxFlag = false;
    TrackerPacket p = {};
    size_t len = radio.getPacketLength();
    int st = radio.readData((uint8_t *)&p, min(len, sizeof(p)));
    bool hasCfg = len == sizeof(p);
    if (st == RADIOLIB_ERR_CRC_MISMATCH) crcCount++;
    else if (st == RADIOLIB_ERR_NONE && (hasCfg || len == LEGACY_LEN) && p.magic == 0xA7 && p.teamId == TEAM_ID) {
      if (!hasCfg) p.cfg = 0;
      last = p; haveLast = true; lastHasCfg = hasCfg; lastRxMs = millis(); rxCount++;
      lastRssi = radio.getRSSI(); lastSnr = radio.getSNR();
      if (p.flags & FLAG_FIX) saveFix(p.lat_e7, p.lon_e7);
      char cfg[3];
      if (hasCfg) snprintf(cfg, sizeof(cfg), "%02X", p.cfg); else strcpy(cfg, "--");
      out("%u,%s,%.7f,%.7f,%d,%u,%d,%u,%u,%.0f,%.1f,%02X,%s,%.1f,https://maps.google.com/?q=%.7f,%.7f",
          p.seq, stateText(p.flags), p.lat_e7 / 1e7, p.lon_e7 / 1e7, p.alt_m, p.sats,
          (p.flags & FLAG_FRESH) ? 1 : 0, p.batt_mV, p.maxAgl_m, lastRssi, lastSnr,
          p.flags, cfg, p.fixAge_ds / 10.0, p.lat_e7 / 1e7, p.lon_e7 / 1e7);
      serviceCommand(p, hasCfg);
    } else if (st == RADIOLIB_ERR_NONE) otherCount++;   // someone else's LoRa
    radio.startReceive();
  }

  // A command can't wait forever for a rocket that has gone quiet.
  if (pending.active && millis() - pending.since > 60000 && (!haveLast || millis() - lastRxMs > 30000)) {
    out("CMD,failed,%s,%u,nolink", cmdName(pending.cmd), pending.arg);
    pending.active = false;
  }

  // Our own position, for the web app: ME,lat,lon,alt_m,sats,course_deg,speed_mps,hdop
  if (millis() - lastMeMs > 2000) {
    lastMeMs = millis();
    if (myGps.location.isValid() && myGps.location.age() < 5000)
      out("ME,%.7f,%.7f,%d,%u,%.0f,%.1f,%.1f", myGps.location.lat(), myGps.location.lng(),
          (int)myGps.altitude.meters(), (unsigned)myGps.satellites.value(),
          myGps.course.isValid() ? myGps.course.deg() : -1.0, myGps.speed.isValid() ? myGps.speed.mps() : 0.0,
          myGps.hdop.isValid() ? myGps.hdop.hdop() : 99.9);
    else
      out("ME,nofix,%u", (unsigned)myGps.satellites.value());
  }

  // Link health for the app's signal panel.
  if (millis() - lastStatMs > 5000) {
    lastStatMs = millis();
    out("STAT,rx=%lu,crc=%lu,other=%lu,up=%lu,ble=%d", (unsigned long)rxCount, (unsigned long)crcCount,
        (unsigned long)otherCount, (unsigned long)(millis() / 1000), bleConnected ? 1 : 0);
  }

  if (millis() - lastDraw > 1000) { lastDraw = millis(); draw(); }
}
