// =====================================================================
//  Rocket Tracker  -  FLIGHT UNIT
//  Seeed XIAO ESP32S3 + Wio-SX1262 (B2B) + Seeed L76K GNSS for XIAO
//
//  Transmit-only GPS beacon. It never listens for commands, so nothing
//  outside the rocket can control it after liftoff.
//
//  Libraries: RadioLib (jgromes), TinyGPSPlus (mikalhart)
// =====================================================================
#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>
#include <TinyGPSPlus.h>

// ----------------------------- SETTINGS ------------------------------
#define TEAM_ID              0x2A   // any 0-255; ground station must match
#define RF_FREQ_MHZ          915.0
#define RF_BW_KHZ            500.0  // 500 kHz: see plan section 6 (FCC note)
#define RF_SF                11     // 12 = more range, 2x airtime
#define RF_CR                5      // 4/5
#define RF_SYNC              0x12   // private network sync word
#ifndef RF_POWER_DBM
#define RF_POWER_DBM         22     // flight power; the `bench` build sets 2
#endif
#define RF_PREAMBLE          8
#define TCXO_VOLTS           1.8    // Meshtastic value; if begin() fails, try 1.6
#define TX_INTERVAL_MS       1000   // pad + flight
#define LANDED_TX_INTERVAL_MS 3000  // after landing (saves battery)
#define LOW_BATT_MV          3500

// ------------------------------- PINS --------------------------------
// SX1262 (through the B2B connector on the XIAO's top side)
#define LORA_SCK    7    // D8
#define LORA_MISO   8    // D9
#define LORA_MOSI   9    // D10
#define LORA_NSS    41
#define LORA_DIO1   39
#define LORA_RST    42
#define LORA_BUSY   40
#define LORA_RXEN   38   // RF switch, HIGH = receive
// L76K GNSS (XIAO header)
#define GPS_RX_PIN  44   // D7  <- L76K TXD
#define GPS_TX_PIN  43   // D6  -> L76K RXD
#define GPS_WAKE    1    // D0  hold HIGH = awake
#define GPS_RESET   3    // D2  hold HIGH = run (current L76K revision)
#define GPS_BAUD    9600
// Add-ons you wire yourself
#define BUZZER_PIN  6    // D5 -> 1k -> 2N3904 base
#define VBAT_PIN    2    // D1 <- midpoint of 100k/100k divider on BAT+

// --------------------------- PACKET FORMAT ---------------------------
// 22 bytes. Ground station uses the identical struct.
struct __attribute__((packed)) TrackerPacket {
  uint8_t  magic;      // 0xA7
  uint8_t  teamId;
  uint16_t seq;
  int32_t  lat_e7;     // degrees * 1e7
  int32_t  lon_e7;
  int16_t  alt_m;      // meters above sea level
  uint8_t  sats;
  uint8_t  flags;      // see FLAG_*
  uint16_t fixAge_ds;  // age of the position, tenths of a second (capped)
  uint16_t batt_mV;
  uint16_t maxAgl_m;   // highest GPS altitude above pad seen (not official!)
};
static_assert(sizeof(TrackerPacket) == 22, "packet must be 22 bytes");

#define FLAG_FIX       0x01  // position has ever been valid
#define FLAG_FRESH     0x02  // position updated in the last 3 s
#define FLAG_PADSET    0x04  // pad position locked in
#define FLAG_FLIGHT    0x08  // launch detected
#define FLAG_LANDED    0x10  // landing detected
#define FLAG_LOWBATT   0x20

// ------------------------------ GLOBALS ------------------------------
SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
TinyGPSPlus gps;

enum State : uint8_t { ST_PAD, ST_FLIGHT, ST_LANDED };
State state = ST_PAD;

double padLat = 0, padLon = 0, padAlt = 0;
bool   padSet = false;
uint32_t padGoodSince = 0;     // when we first had a good fix on the pad
float  maxAgl = 0;
uint32_t launchMs = 0, groundSince = 0;
uint16_t seq = 0;
uint32_t lastTx = 0;
bool radioOk = false;

// ------------------------------ BUZZER -------------------------------
uint8_t  beepsLeft = 0;
bool     beepOn = false;
uint32_t beepNext = 0, beepOnMs = 60, beepOffMs = 120, lastPattern = 0;

void startBeeps(uint8_t n, uint32_t onMs, uint32_t offMs) {
  if (beepsLeft) return;                 // let the current pattern finish
  beepsLeft = n; beepOnMs = onMs; beepOffMs = offMs; beepOn = false; beepNext = 0;
}

void updateBuzzer() {
  if (!beepsLeft) return;
  uint32_t now = millis();
  if (now < beepNext) return;
  if (!beepOn) { digitalWrite(BUZZER_PIN, HIGH); beepOn = true;  beepNext = now + beepOnMs; }
  else         { digitalWrite(BUZZER_PIN, LOW);  beepOn = false; beepNext = now + beepOffMs; beepsLeft--; }
}

// Pad, no fix:   1 short chirp every 5 s
// Pad, fix:      2 short chirps every 5 s   (OK to close up and launch)
// Flight:        silent
// Landed:        3 long beeps every 2 s     (walk toward the noise)
void buzzerPattern() {
  uint32_t now = millis();
  if (state == ST_LANDED) {
    if (now - lastPattern > 2000) { startBeeps(3, 250, 150); lastPattern = now; }
  } else if (state == ST_PAD) {
    if (now - lastPattern > 5000) { startBeeps(padSet ? 2 : 1, 40, 160); lastPattern = now; }
  }
}

// ------------------------------- GPS ---------------------------------
void sendPCAS(const char *body) {           // body = text between '$' and '*'
  uint8_t cs = 0;
  for (const char *p = body; *p; p++) cs ^= (uint8_t)*p;
  char buf[96];
  snprintf(buf, sizeof(buf), "$%s*%02X\r\n", body, cs);
  Serial1.print(buf);
}

void gpsInit() {
  pinMode(GPS_WAKE, OUTPUT);  digitalWrite(GPS_WAKE, HIGH);
  pinMode(GPS_RESET, OUTPUT); digitalWrite(GPS_RESET, HIGH);
  Serial1.setRxBufferSize(1024);            // survives the ~170 ms blocking TX
  Serial1.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  delay(300);
  sendPCAS("PCAS04,7");                     // GPS + BeiDou + GLONASS
  delay(50);
  sendPCAS("PCAS03,1,0,0,0,1,0,0,0,0,0,,,0,0");  // only GGA + RMC sentences
}

bool fixFresh() {
  return gps.location.isValid() && gps.location.age() < 3000 && gps.altitude.isValid();
}

// ----------------------------- BATTERY -------------------------------
uint16_t readBatt_mV() {
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) sum += analogReadMilliVolts(VBAT_PIN);
  return (uint16_t)((sum / 8) * 2);         // divider halves the voltage
}

// --------------------------- FLIGHT LOGIC ----------------------------
void updateState() {
  if (!fixFresh()) {
    // No fresh fix: only the timeout can move us out of FLIGHT
    if (state == ST_FLIGHT && millis() - launchMs > 120000) state = ST_LANDED;
    return;
  }
  double lat = gps.location.lat(), lon = gps.location.lng(), alt = gps.altitude.meters();
  uint32_t now = millis();

  if (state == ST_PAD) {
    bool goodFix = gps.satellites.value() >= 6 && gps.hdop.isValid() && gps.hdop.hdop() < 3.0;
    if (padSet) {
      double dist = TinyGPSPlus::distanceBetween(lat, lon, padLat, padLon);
      bool usable = gps.satellites.value() >= 5;          // ignore junk fixes
      if (usable && alt > padAlt + 30.0) {  // climbing: launch
        state = ST_FLIGHT; launchMs = now; return;
      }
      if (usable && dist > 60.0) {          // re-locked far from the pad after a dropout
        state = ST_LANDED; return;
      }
      if (goodFix && dist < 20.0 && fabs(alt - padAlt) < 15.0) {
        // slowly refine the pad estimate while sitting still
        padLat += (lat - padLat) * 0.05;
        padLon += (lon - padLon) * 0.05;
        padAlt += (alt - padAlt) * 0.05;
      }
    } else if (goodFix) {
      if (!padGoodSince) { padGoodSince = now; padLat = lat; padLon = lon; padAlt = alt; }
      padLat += (lat - padLat) * 0.2; padLon += (lon - padLon) * 0.2; padAlt += (alt - padAlt) * 0.2;
      if (now - padGoodSince > 10000) padSet = true;   // 10 s of good fixes
    } else {
      padGoodSince = 0;
    }
  }

  if (state == ST_FLIGHT) {
    float agl = alt - padAlt;
    if (agl > maxAgl) maxAgl = agl;
    bool still = agl < 20.0 && gps.speed.isValid() && gps.speed.mps() < 2.0;
    if (still) { if (!groundSince) groundSince = now; }
    else groundSince = 0;
    if ((groundSince && now - groundSince > 15000) || now - launchMs > 120000) state = ST_LANDED;
  }
}

// ------------------------------- RADIO -------------------------------
void radioInit() {
  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int st = radio.begin(RF_FREQ_MHZ, RF_BW_KHZ, RF_SF, RF_CR, RF_SYNC,
                       RF_POWER_DBM, RF_PREAMBLE, TCXO_VOLTS);
  if (st != RADIOLIB_ERR_NONE) {
    Serial.printf("radio.begin failed: %d\n", st);
    return;
  }
  radio.setDio2AsRfSwitch(true);
  radio.setRfSwitchPins(LORA_RXEN, RADIOLIB_NC);
  radio.setCurrentLimit(140.0);
  radio.setCRC(true);
  radioOk = true;
  Serial.println("radio OK");
}

void sendPacket() {
  TrackerPacket p = {};
  p.magic  = 0xA7;
  p.teamId = TEAM_ID;
  p.seq    = seq++;
  p.sats   = gps.satellites.isValid() ? (uint8_t)min<uint32_t>(gps.satellites.value(), 255) : 0;

  uint8_t flags = 0;
  if (gps.location.isValid()) {
    flags |= FLAG_FIX;
    p.lat_e7 = (int32_t)lround(gps.location.lat() * 1e7);
    p.lon_e7 = (int32_t)lround(gps.location.lng() * 1e7);
    p.alt_m  = gps.altitude.isValid() ? (int16_t)lround(gps.altitude.meters()) : 0;
    p.fixAge_ds = (uint16_t)min<uint32_t>(gps.location.age() / 100, 65535);
  }
  if (fixFresh())          flags |= FLAG_FRESH;
  if (padSet)              flags |= FLAG_PADSET;
  if (state != ST_PAD)     flags |= FLAG_FLIGHT;
  if (state == ST_LANDED)  flags |= FLAG_LANDED;
  p.batt_mV = readBatt_mV();
  if (p.batt_mV > 1000 && p.batt_mV < LOW_BATT_MV) flags |= FLAG_LOWBATT;
  p.flags = flags;
  p.maxAgl_m = (uint16_t)max(0.0f, maxAgl);

  if (radioOk) {
    int st = radio.transmit((uint8_t *)&p, sizeof(p));   // ~170 ms at SF11/500k
    if (st != RADIOLIB_ERR_NONE) Serial.printf("tx error %d\n", st);
  }
  // gps_chars climbing = the L76K is wired and talking, even with no fix
  Serial.printf("#%u st=%d fix=%d sats=%u %.7f,%.7f alt=%d agl_max=%u batt=%u gps_chars=%lu bad=%lu flags=%02X\n",
                p.seq, state, (flags & FLAG_FRESH) ? 1 : 0, p.sats,
                p.lat_e7 / 1e7, p.lon_e7 / 1e7, p.alt_m, p.maxAgl_m, p.batt_mV,
                (unsigned long)gps.charsProcessed(), (unsigned long)gps.failedChecksum(), flags);
}

// ------------------------------ ARDUINO ------------------------------
void setup() {
  setCpuFrequencyMhz(80);                   // plenty, saves ~20 mA
  pinMode(BUZZER_PIN, OUTPUT); digitalWrite(BUZZER_PIN, LOW);
  analogReadResolution(12);
  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);                 // don't stall when no laptop is plugged in
#endif
  delay(500);
  Serial.println("Rocket tracker flight unit");
  gpsInit();
  radioInit();
  startBeeps(radioOk ? 1 : 5, radioOk ? 300 : 80, 100);   // 1 long = good, 5 fast = radio fault
}

void loop() {
  while (Serial1.available()) gps.encode(Serial1.read());
  updateState();
  buzzerPattern();
  updateBuzzer();

  uint32_t interval = (state == ST_LANDED) ? LANDED_TX_INTERVAL_MS : TX_INTERVAL_MS;
  if (millis() - lastTx >= interval) {
    lastTx = millis();
    sendPacket();
  }
}
