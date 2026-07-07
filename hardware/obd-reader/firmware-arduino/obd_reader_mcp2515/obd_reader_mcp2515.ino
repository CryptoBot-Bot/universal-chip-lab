// obd_reader_mcp2515.ino — OBD-II reader firmware on a HARDWARE CAN controller.
// =============================================================================
// Drop-in replacement for obd_reader.ino (can2040). SAME USB serial protocol
// (PING / BATT / OBD / ISOTP / CANDUMP / REQDUMP / PROBE / SIM / CANSTAT …), so
// the Universal Chip Lab desktop app drives it UNCHANGED — only the CAN layer
// underneath is now a Microchip MCP2515 over SPI + a TJA1050 transceiver.
//
// WHY THIS EXISTS: the RP2040 has no hardware CAN, so can2040 bit-bangs it on the
// PIO and relies on the transceiver's analog edges being perfect at 500k. On a
// marginal/heat-stressed SN65HVD230 that produced corrupt transmit (tx completes
// ~1%, every frame errors, the lone bench TCM bus-offs). The MCP2515 generates
// CAN bits and ACK in DEDICATED HARDWARE with a crystal-timed bit clock, and the
// TJA1050 has no RS/standby pin to mis-wire — so clean transmit is the default.
//
//   Board   : Raspberry Pi Pico (Arduino-Pico core, earlephilhower)
//   Library : "mcp_can" by coryjfowler  (Library Manager: "MCP_CAN by coryjfowler")
//
//   POWER MODE: run BOTH modules' VCC at 3.3V (from the Pico 3V3 pin). Then MISO
//   is natively 3.3V — wire it DIRECT (no divider, no shifter), SPI runs at full
//   speed, and the Pico is safe. This is the proven, reliable setup.
//
// ─────────────────────────────  WIRING (READ THIS)  ──────────────────────────
// The blue MCP2515 module runs its TJA1050 transceiver at 5V, so the module's
// logic outputs (SO/MISO, INT) swing to 5V. Feeding 5V into a Pico 3.3V GPIO
// DAMAGES IT. Two safe options — pick one:
//
//   A) SAFEST (level-shift, no board mod): power the module from Pico VBUS (5V),
//      and run ALL SPI lines through your AITIAO/BSS138 level shifter between the
//      Pico 3.3V side and the module 5V side:
//        Pico GP18 (SCK)  → shift → MCP SCK
//        Pico GP19 (MOSI) → shift → MCP SI
//        MCP SO (MISO)    → shift → Pico GP16     <-- 5V→3.3V, MUST shift
//        Pico GP17 (CS)   → shift → MCP CS
//        MCP INT          → shift → Pico GP20     <-- 5V→3.3V, MUST shift
//        Module VCC = Pico VBUS (pin 40, ~5V) ; GND common
//
//   B) SIMPLE (module at 3.3V): power the module VCC from Pico 3V3 (pin 36). Then
//      all logic is 3.3V and SPI is Pico-safe with NO shifter. The catch: the
//      TJA1050 is a 5V part, so at 3.3V its CAN levels are slightly low — fine for
//      a short bench bus with ~60Ω termination, marginal for a long harness. Good
//      enough to prove transmit works; move to (A) for the car.
//
//   CANH → OBD pin 6 , CANL → OBD pin 14 (HS-CAN). Battery divider 47k/10k → GP28.
//
// ──────────────────────  ADDING THE SECOND MODULE (MS-CAN)  ───────────────────
// The MS-CAN module is a second, identical blue MCP2515+TJA1050. It SHARES the
// three SPI signals with the HS module and only needs its own CS + INT:
//        Pico GP18 (SCK)  → MS MCP SCK    (same wire/net as HS SCK)
//        Pico GP19 (MOSI) → MS MCP SI     (same net as HS SI)
//        MS MCP SO        → Pico GP16     (same net as HS SO — all SO are high-Z when not selected)
//        Pico GP15 (CS)   → MS MCP CS     <-- its OWN pin, do NOT share
//        MS MCP INT       → Pico GP14     <-- its OWN pin
//        MS module VCC + GND like the HS module (3.3V option B, or 5V + shifter option A)
//   MS CANH → OBD pin 3 , MS CANL → OBD pin 11.  MS-CAN usually runs 125 kbps.
//   Level-shift note: if you power the MS module at 5V (option A) its SO and INT
//   also need shifting to 3.3V before GP16/GP14 — same rule as the HS module.
//   Termination: MS-CAN has its own 120Ω pair on the car; on a bench keep ~60Ω
//   on the MS pair too (one terminator if the module already has one).
//
// ───────────────────────────  TWO GOTCHAS IF NO COMMS  ───────────────────────
//   1) CRYSTAL: these modules ship with an 8MHz OR 16MHz crystal. Wrong value =
//      wrong bit timing = zero communication. Default below is 8MHz; if the bus
//      stays silent, flip CRYSTAL_16MHZ to 1 and reflash. (Check the tiny silver
//      can on the board: "8.000" vs "16.000".)
//   2) TERMINATION: most modules have an onboard 120Ω (J1 jumper). On a bench you
//      want ~60Ω total, so keep ONE terminator in the system; on a real car leave
//      the module's 120Ω OFF (the car is already terminated).
// =============================================================================
#include <SPI.h>
#include <mcp_can.h>
#include <EEPROM.h>

static const char* FIRMWARE = "OBD-Reader v3 (MCP2515)";

// ---- set to 1 if your module has a 16MHz crystal (default assumes 8MHz) ------
// Both MCP2515 modules almost always share the same crystal; set both the same.
#define CRYSTAL_16MHZ     0
#define CRYSTAL_16MHZ_MS  0

// ---- pins ----
// HS controller (CAN0) — the existing one, OBD pins 6/14.
static const uint8_t PIN_CS  = 17;   // GP17 -> MCP CS
static const uint8_t PIN_INT = 20;   // GP20 <- MCP INT (polled; wire it anyway)
static const uint8_t PIN_SCK = 18;   // GP18 -> MCP SCK  (SHARED with the MS module)
static const uint8_t PIN_MOSI = 19;  // GP19 -> MCP SI   (SHARED)
static const uint8_t PIN_MISO = 16;  // GP16 <- MCP SO   (SHARED)
// MS controller (CAN1) — the SECOND module you're adding, OBD pins 3/11.
// It shares SCK/SI/SO with the HS module; only CS + INT are its own.
static const uint8_t PIN_CS2  = 15;  // GP15 -> MS MCP CS
static const uint8_t PIN_INT2 = 14;  // GP14 <- MS MCP INT (polled)
#define BATT_ADC A2                  // GP28 = ADC2

MCP_CAN CAN0(PIN_CS);                // HS
MCP_CAN CAN1(PIN_CS2);              // MS (shares the SPI bus, own CS)

// ---- config (flash-persisted, like the can2040 build) ----
static const uint32_t CAL_MAGIC = 0xCA11B009;   // bumped: added msBitrate slot
static uint32_t bitrate = 500000;               // HS: 125k/250k/500k
static uint32_t msBitrate = 125000;             // MS: usually 125k (GMLAN/Ford MS)
static uint8_t  activeBus = 0;                   // 0 = HS (CAN0), 1 = MS (CAN1) — which bus we TRANSMIT on
static float ratio = 5.7f;
static const float VREF = 3.3f;
static const int   ADC_MAX = 4095;
static const float V_LOW = 11.8f, V_CHARGING = 13.2f;

// ---- OBD-II / ISO-TP ----
static const uint32_t OBD_REQUEST_ID = 0x7DF;
static const uint8_t  PAD = 0x55;

// ---- state / counters ----
bool canUp = false;      // HS controller (CAN0) up
bool canUp2 = false;     // MS controller (CAN1) up
unsigned long t0 = 0;
float vmin = 99.0f, vmax = 0.0f;
volatile uint32_t rxTotal = 0, txTotal = 0, txFail = 0;      // HS
volatile uint32_t rxTotal2 = 0, txTotal2 = 0, txFail2 = 0;   // MS

// sim
const char* simScenario = nullptr;
unsigned long simT0 = 0;
bool simCleared = false;

// ---- a plain CAN frame + RX ring buffer (filled by pumpRx) ----
struct Frame { uint32_t id; uint8_t dlc; uint8_t data[8]; };
#define RXBUF 128
static Frame rxq[RXBUF];
static uint8_t rxHead = 0, rxTail = 0;
static Frame rxq2[RXBUF];              // MS bus ring buffer
static uint8_t rxHead2 = 0, rxTail2 = 0;

static bool popRx(Frame* out) {
  if (rxTail == rxHead) return false;
  *out = rxq[rxTail];
  rxTail = (rxTail + 1) % RXBUF;
  return true;
}

static bool popRx2(Frame* out) {
  if (rxTail2 == rxHead2) return false;
  *out = rxq2[rxTail2];
  rxTail2 = (rxTail2 + 1) % RXBUF;
  return true;
}

// Drain every frame the MCP2515 currently holds into our ring buffer. Called from
// loop() AND from inside every receive-wait loop, so blocking ISO-TP windows still
// collect frames (the can2040 build got this for free via its RX interrupt).
static void pumpRx() {
  if (!canUp) return;
  unsigned long rxId; uint8_t len; uint8_t buf[8];
  int guard = 0;
  while (CAN0.checkReceive() == CAN_MSGAVAIL && guard++ < 32) {
    if (CAN0.readMsgBuf(&rxId, &len, buf) != CAN_OK) break;
    uint8_t n = (rxHead + 1) % RXBUF;
    if (n != rxTail) {
      rxq[rxHead].id = (uint32_t)(rxId & 0x1FFFFFFF);
      rxq[rxHead].dlc = (len > 8) ? 8 : len;
      for (int i = 0; i < 8; i++) rxq[rxHead].data[i] = (i < len) ? buf[i] : 0;
      rxHead = n;
    }
    rxTotal++;
  }
}

// Same as pumpRx but for the MS controller — drains CAN1 into its own ring.
static void pumpRx2() {
  if (!canUp2) return;
  unsigned long rxId; uint8_t len; uint8_t buf[8];
  int guard = 0;
  while (CAN1.checkReceive() == CAN_MSGAVAIL && guard++ < 32) {
    if (CAN1.readMsgBuf(&rxId, &len, buf) != CAN_OK) break;
    uint8_t n = (rxHead2 + 1) % RXBUF;
    if (n != rxTail2) {
      rxq2[rxHead2].id = (uint32_t)(rxId & 0x1FFFFFFF);
      rxq2[rxHead2].dlc = (len > 8) ? 8 : len;
      for (int i = 0; i < 8; i++) rxq2[rxHead2].data[i] = (i < len) ? buf[i] : 0;
      rxHead2 = n;
    }
    rxTotal2++;
  }
}

static uint8_t speedConst(uint32_t bps) {
  return (bps == 125000) ? CAN_125KBPS : (bps == 250000) ? CAN_250KBPS : CAN_500KBPS;
}

// ---- active-bus helpers: transmit + ISO-TP receive follow the selected bus ---
static MCP_CAN* activeCan()  { return (activeBus == 1) ? &CAN1 : &CAN0; }
static bool     activeUp()   { return (activeBus == 1) ? canUp2 : canUp; }
static void     pumpActive() { if (activeBus == 1) pumpRx2(); else pumpRx(); }
static bool     popRxActive(Frame* o) { return (activeBus == 1) ? popRx2(o) : popRx(o); }

static bool bringUpCan() {
  uint8_t xtal = CRYSTAL_16MHZ ? MCP_16MHZ : MCP_8MHZ;
  if (CAN0.begin(MCP_ANY, speedConst(bitrate), xtal) != CAN_OK) return false;
  CAN0.setMode(MCP_NORMAL);   // NORMAL = transmit + hardware ACK (keeps the bus alive)
  return true;
}

static bool bringUpCan2() {
  uint8_t xtal = CRYSTAL_16MHZ_MS ? MCP_16MHZ : MCP_8MHZ;
  if (CAN1.begin(MCP_ANY, speedConst(msBitrate), xtal) != CAN_OK) return false;
  // NORMAL = full transmit + hardware ACK on MS, same as HS. The MS controller
  // only actually drives the bus when it's the selected transmit bus (CANBUS MS);
  // otherwise it just receives. Both controllers always receive passively.
  CAN1.setMode(MCP_NORMAL);
  return true;
}

// =============================================================================
// Battery (identical maths to the can2040 build)
// =============================================================================
static float simVoltage() {
  float t = (millis() - simT0) / 1000.0f;
  float base = 12.5f;
  if (!strcmp(simScenario, "WEAK")) base = 11.4f;
  else if (!strcmp(simScenario, "IDLE")) base = 13.9f;
  else if (!strcmp(simScenario, "DRIVE")) {
    if (t < 3) base = 12.5f;
    else if (t < 4) base = 10.2f;
    else if (t < 12) base = 12.6f + (t - 4) * 0.21f;
    else base = 14.3f;
  } else if (!strcmp(simScenario, "IGNITION")) base = 12.5f;
  float jitter = (((long)(millis() / 100) % 7) - 3) * 0.02f;
  return base + jitter;
}

static float readBattery() {
  if (simScenario) return simVoltage();
  const int N = 15; int v[N];
  for (int i = 0; i < N; i++) { v[i] = analogRead(BATT_ADC); delay(1); }
  for (int i = 1; i < N; i++) { int x = v[i], j = i - 1; while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; } v[j + 1] = x; }
  float vadc = (float)v[N / 2] / ADC_MAX * VREF;
  return vadc * ratio;
}

static const char* classify(float vb) {
  if (vb < V_LOW) return "LOW";
  if (vb >= V_CHARGING) return "CHARGING";
  return "OK";
}

// =============================================================================
// OBD-II — simulated answers (verbatim from the can2040 build)
// =============================================================================
static int simObd(uint8_t mode, int pid, uint8_t* out, const char** err) {
  long t = (millis() - simT0) / 1000;
  if (mode == 0x01) {
    if (pid < 0) { *err = "Mode 01 needs a PID"; return -1; }
    out[0] = (uint8_t)pid;
    switch (pid) {
      case 0x00: out[1] = 0x18; out[2] = 0x1A; out[3] = 0x80; out[4] = 0x03; return 5;
      case 0x20: out[1] = 0x00; out[2] = 0x02; out[3] = 0x00; out[4] = 0x01; return 5;
      case 0x40: out[1] = 0x40; out[2] = 0x00; out[3] = 0x00; out[4] = 0x00; return 5;
      case 0x04: out[1] = (uint8_t)((t * 7 % 100) * 255 / 100); return 2;
      case 0x05: out[1] = (uint8_t)(min(92L, 25 + t) + 40); return 2;
      case 0x0C: { long rv = (800 + (t % 30) * 80) * 4; out[1] = (rv >> 8) & 0xFF; out[2] = rv & 0xFF; return 3; }
      case 0x0D: out[1] = (uint8_t)(t % 70); return 2;
      case 0x0F: out[1] = 70; return 2;
      case 0x11: out[1] = (uint8_t)(((t * 3 % 80) + 10) * 255 / 100); return 2;
      case 0x1F: out[1] = (t >> 8) & 0xFF; out[2] = t & 0xFF; return 3;
      case 0x2F: out[1] = 153; return 2;
      case 0x42: out[1] = 0x37; out[2] = 0x78; return 3;
      default: *err = "PID not supported"; return -1;
    }
  }
  if (mode == 0x03) { if (simCleared) return 0; out[0] = 0x03; out[1] = 0x01; out[2] = 0x04; out[3] = 0x20; return 4; }
  if (mode == 0x07 || mode == 0x0A) return 0;
  if (mode == 0x09 && pid == 0x02) {
    const char* vin = "1HGSIM0000PICO123";
    out[0] = 0x02; out[1] = 0x01;
    for (int i = 0; i < 17; i++) out[2 + i] = vin[i];
    return 19;
  }
  if (mode == 0x04) { simCleared = true; return 0; }
  *err = "Mode not simulated"; return -1;
}

// =============================================================================
// ISO-TP transport over the MCP2515
// =============================================================================
static void canSendFrame(uint32_t id, const uint8_t* d, int dlc) {
  uint8_t buf[8];
  for (int i = 0; i < 8; i++) buf[i] = (i < dlc) ? d[i] : PAD;   // OBD frames padded to 8
  bool ok = (activeCan()->sendMsgBuf(id, 0 /*standard id*/, 8, buf) == CAN_OK);
  if (activeBus == 1) { if (ok) txTotal2++; else txFail2++; }
  else                { if (ok) txTotal++;  else txFail++; }
}

static int isotpAttempt(uint32_t txid, const uint8_t* req, int reqLen,
                        uint8_t* out, int outMax, uint32_t* respId, uint32_t windowMs) {
  Frame drain;
  pumpActive(); while (popRxActive(&drain)) {}       // flush stale frames on the active bus

  uint8_t f[8];
  f[0] = (uint8_t)reqLen;
  for (int i = 0; i < reqLen; i++) f[1 + i] = req[i];
  canSendFrame(txid, f, 1 + reqLen);

  int asmLen = 0, expected = -1;
  uint32_t rid = 0;
  uint32_t deadline = millis() + windowMs;
  while ((long)(deadline - millis()) > 0) {
    pumpActive();
    Frame m;
    if (!popRxActive(&m)) { delay(1); continue; }
    uint32_t id = m.id & 0x1FFFFFFF;
    // accept the standard diagnostic responders, or this request's own txid+8
    // (handles KWP 7E1->7E9 and any physical req->req+8 on either bus).
    if (!((id >= 0x7E8 && id <= 0x7EF) || id == txid + 8)) continue;
    uint8_t pci = m.data[0] & 0xF0;
    if (pci == 0x00) {
      int len = m.data[0] & 0x0F;
      for (int i = 0; i < len && i < outMax; i++) out[i] = m.data[1 + i];
      asmLen = len; rid = id; break;
    } else if (pci == 0x10) {
      expected = ((m.data[0] & 0x0F) << 8) | m.data[1];
      for (int i = 0; i < 6 && asmLen < outMax; i++) out[asmLen++] = m.data[2 + i];
      rid = id;
      uint8_t fc[3] = { 0x30, 0x00, 0x00 };
      canSendFrame(id - 8, fc, 3);
    } else if (pci == 0x20) {
      for (int i = 0; i < 7 && asmLen < expected && asmLen < outMax; i++) out[asmLen++] = m.data[1 + i];
      if (expected > 0 && asmLen >= expected) break;
    }
  }
  if (respId) *respId = rid;
  return asmLen;
}

static int isotpRequest(uint32_t txid, const uint8_t* req, int reqLen,
                        uint8_t* out, int outMax, uint32_t* respId) {
  if (!activeUp() || reqLen > 7) return -1;
  for (int attempt = 0; attempt < 3; attempt++) {
    int n = isotpAttempt(txid, req, reqLen, out, outMax, respId, 400);
    if (n > 0) return n;
  }
  return 0;
}

static int realObd(uint8_t mode, int pid, uint8_t* out, const char** err) {
  uint8_t req[2]; int reqLen;
  if (pid >= 0) { req[0] = mode; req[1] = (uint8_t)pid; reqLen = 2; }
  else { req[0] = mode; reqLen = 1; }
  uint8_t raw[80];
  int n = isotpRequest(OBD_REQUEST_ID, req, reqLen, raw, sizeof(raw), nullptr);
  if (n <= 0) { *err = "no response (engine off? wrong bus? car uses K-line?)"; return -1; }
  for (int i = 0; i < n - 1; i++) out[i] = raw[1 + i];
  return n - 1;
}

static int probeModules(uint16_t* ids, int maxIds) {
  if (!activeUp()) return 0;
  Frame drain; pumpActive(); while (popRxActive(&drain)) {}
  uint8_t f[3] = { 0x02, 0x01, 0x00 };
  canSendFrame(OBD_REQUEST_ID, f, 3);
  int count = 0;
  uint32_t deadline = millis() + 1200;
  while ((long)(deadline - millis()) > 0) {
    pumpActive();
    Frame m;
    if (!popRxActive(&m)) { delay(1); continue; }
    uint32_t id = m.id & 0x1FFFFFFF;
    if (id < 0x7E8 || id > 0x7EF) continue;
    bool known = false;
    for (int i = 0; i < count; i++) if (ids[i] == id) known = true;
    if (!known && count < maxIds) ids[count++] = (uint16_t)id;
  }
  return count;
}

static int simIsotp(uint32_t txid, const uint8_t* req, int reqLen, uint8_t* out) {
  (void)txid;
  if (reqLen < 1) return 0;
  uint8_t svc = req[0];
  if (svc == 0x3E) return 0;
  if (svc == 0x10) { out[0] = 0x50; out[1] = (reqLen > 1) ? req[1] : 1; out[2] = 0x00; out[3] = 0x32; out[4] = 0x01; out[5] = 0xF4; return 6; }
  if (svc == 0x22) {
    if (reqLen >= 3 && req[1] == 0xF1 && req[2] == 0x90) {
      const char* vin = "1HGSIM0000PICO123";
      out[0] = 0x62; out[1] = 0xF1; out[2] = 0x90;
      for (int i = 0; i < 17; i++) out[3 + i] = vin[i];
      return 20;
    }
    out[0] = 0x62; out[1] = (reqLen > 1) ? req[1] : 0; out[2] = (reqLen > 2) ? req[2] : 0;
    out[3] = 0xAA; out[4] = 0x55; return 5;
  }
  if (svc == 0x19) {
    if (simCleared) { out[0] = 0x59; out[1] = 0x02; out[2] = 0xFF; return 3; }
    uint8_t r[] = { 0x59, 0x02, 0xFF, 0x04, 0x20, 0x00, 0x09, 0x01, 0x76, 0x00, 0x09 };
    for (int i = 0; i < (int)sizeof(r); i++) out[i] = r[i];
    return sizeof(r);
  }
  if (svc == 0x14) { simCleared = true; out[0] = 0x54; return 1; }
  out[0] = 0x7F; out[1] = svc; out[2] = 0x11; return 3;
}

// =============================================================================
// Serial protocol
// =============================================================================
static void printOK(const char* s) { Serial.print("OK "); Serial.println(s); }
static void printERR(const char* s) { Serial.print("ERR "); Serial.println(s); }
static void printOKBytes(const uint8_t* d, int n) {
  Serial.print("OK ");
  for (int i = 0; i < n; i++) { if (d[i] < 0x10) Serial.print('0'); Serial.print(d[i], HEX); }
  Serial.println();
}

static void saveRatio()   { EEPROM.put(0, CAL_MAGIC); EEPROM.put(4, ratio);   EEPROM.commit(); }
static void saveBitrate(uint32_t b)   { EEPROM.put(0, CAL_MAGIC); EEPROM.put(8, b);  EEPROM.commit(); }
static void saveMsBitrate(uint32_t b) { EEPROM.put(0, CAL_MAGIC); EEPROM.put(12, b); EEPROM.commit(); }
static void saveActiveBus(uint8_t v)   { EEPROM.put(0, CAL_MAGIC); EEPROM.put(16, v); EEPROM.commit(); }
static void loadConfig() {
  uint32_t magic = 0; EEPROM.get(0, magic);
  if (magic == CAL_MAGIC) { float r = 0; EEPROM.get(4, r); if (r > 0.1f && r < 100.0f) ratio = r; }
  uint32_t b = 0; EEPROM.get(8, b);
  if (b == 125000 || b == 250000 || b == 500000) bitrate = b;
  uint32_t mb = 0; EEPROM.get(12, mb);
  if (mb == 125000 || mb == 250000 || mb == 500000) msBitrate = mb;
  uint8_t ab = 0; EEPROM.get(16, ab);
  if (ab == 0 || ab == 1) activeBus = ab;
}

static void handle(char* line) {
  char* tok[4]; int nt = 0;
  char* p = strtok(line, " \t");
  while (p && nt < 4) { tok[nt++] = p; p = strtok(nullptr, " \t"); }
  if (nt == 0) return;
  for (char* c = tok[0]; *c; c++) *c = toupper(*c);
  const char* cmd = tok[0];

  if (!strcmp(cmd, "PING")) {
    printOK(FIRMWARE);
  } else if (!strcmp(cmd, "HELP")) {
    printOK("PING INFO BATT CANSTAT CAL<r> SPEED<125|250|500> SPEEDMS<125|250|500> CANBUS<HS|MS> RESET CANINIT CANRESET CANDUMP CANDUMP2 OBD<mode>[<pid>] ISOTP<txid><hex> REQDUMP<txid><hex> PROBE SIM<OFF|IGNITION|WEAK|IDLE|DRIVE>");
  } else if (!strcmp(cmd, "INFO")) {
    char b[180];
    snprintf(b, sizeof(b), "ratio=%.3f | low=%.1f charging=%.1f | can=%s@%lu | ms=%s@%lu | txbus=%s | sim=%s | mcp2515 xtal=%dMHz",
             ratio, V_LOW, V_CHARGING, canUp ? "up" : "DOWN", (unsigned long)bitrate,
             canUp2 ? "up" : "DOWN", (unsigned long)msBitrate, activeBus ? "MS" : "HS",
             simScenario ? simScenario : "off", CRYSTAL_16MHZ ? 16 : 8);
    printOK(b);
  } else if (!strcmp(cmd, "BATT")) {
    float vb = readBattery();
    if (vb < vmin) vmin = vb; if (vb > vmax) vmax = vb;
    char b[80];
    snprintf(b, sizeof(b), "%lu,%.2f,%s,%.2f,%.2f", (unsigned long)(millis() - t0), vb, classify(vb), vmin, vmax);
    printOK(b);
  } else if (!strcmp(cmd, "CAL")) {
    if (nt > 1) { ratio = atof(tok[1]); saveRatio(); }
    char b[32]; snprintf(b, sizeof(b), "ratio=%.3f", ratio); printOK(b);
  } else if (!strcmp(cmd, "RESET")) {
    vmin = 99.0f; vmax = 0.0f; printOK("min/max cleared");
  } else if (!strcmp(cmd, "CANRESET")) {
    printOK("rebooting"); Serial.flush(); delay(50); rp2040.reboot();
  } else if (!strcmp(cmd, "SPEED")) {
    if (nt < 2) { printERR("SPEED needs 125 / 250 / 500"); return; }
    long v = strtol(tok[1], nullptr, 10);
    if (v < 1000) v *= 1000;
    if (v != 125000 && v != 250000 && v != 500000) { printERR("only 125000/250000/500000"); return; }
    saveBitrate((uint32_t)v);
    char b[40]; snprintf(b, sizeof(b), "speed=%ld, rebooting", v); printOK(b);
    Serial.flush(); delay(50); rp2040.reboot();
  } else if (!strcmp(cmd, "SPEEDMS")) {
    if (nt < 2) { printERR("SPEEDMS needs 125 / 250 / 500"); return; }
    long v = strtol(tok[1], nullptr, 10);
    if (v < 1000) v *= 1000;
    if (v != 125000 && v != 250000 && v != 500000) { printERR("only 125000/250000/500000"); return; }
    saveMsBitrate((uint32_t)v);
    char b[40]; snprintf(b, sizeof(b), "ms speed=%ld, rebooting", v); printOK(b);
    Serial.flush(); delay(50); rp2040.reboot();
  } else if (!strcmp(cmd, "CANBUS")) {
    // Select which controller transmits + which one ISO-TP listens on. No reboot,
    // so the app can switch buses instantly. Both buses always receive passively.
    if (nt < 2) { char b[40]; snprintf(b, sizeof(b), "txbus=%s", activeBus ? "MS" : "HS"); printOK(b); return; }
    for (char* c = tok[1]; *c; c++) *c = toupper(*c);
    uint8_t want;
    if (!strcmp(tok[1], "HS") || !strcmp(tok[1], "0")) want = 0;
    else if (!strcmp(tok[1], "MS") || !strcmp(tok[1], "1")) want = 1;
    else { printERR("CANBUS needs HS or MS"); return; }
    if (want == 1 && !canUp2) { printERR("MS controller is down (2nd MCP2515 not found)"); return; }
    activeBus = want; saveActiveBus(want);
    char b[40]; snprintf(b, sizeof(b), "txbus=%s", activeBus ? "MS" : "HS"); printOK(b);
  } else if (!strcmp(cmd, "CANSTAT")) {
    // Hardware error counters (TEC/REC) are the real transmit truth on the MCP2515:
    // clean transmit = tx climbing, txFail ~0, tec low. A driver that can't be ACKed
    // shows tx stuck with tec climbing toward 255 (bus-off).
    uint8_t eflg = CAN0.getError();
    char b[200];
    if (canUp2) {
      snprintf(b, sizeof(b),
               "HS rx=%lu tx=%lu txFail=%lu tec=%d rec=%d eflg=0x%02X | MS rx=%lu tx=%lu eflg=0x%02X",
               (unsigned long)rxTotal, (unsigned long)txTotal, (unsigned long)txFail,
               (int)CAN0.errorCountTX(), (int)CAN0.errorCountRX(), eflg,
               (unsigned long)rxTotal2, (unsigned long)txTotal2, CAN1.getError());
    } else {
      snprintf(b, sizeof(b), "HS rx=%lu tx=%lu txFail=%lu tec=%d rec=%d eflg=0x%02X | MS down",
               (unsigned long)rxTotal, (unsigned long)txTotal, (unsigned long)txFail,
               (int)CAN0.errorCountTX(), (int)CAN0.errorCountRX(), eflg);
    }
    printOK(b);
  } else if (!strcmp(cmd, "CANINIT")) {
    char b[40]; snprintf(b, sizeof(b), "can %s @ %lu bps", canUp ? "up" : "DOWN", (unsigned long)bitrate); printOK(b);
  } else if (!strcmp(cmd, "CANDUMP")) {
    if (simScenario) {
      long t = (millis() - simT0) / 1000; long rv = (800 + (t % 30) * 80) * 4;
      char b[96];
      snprintf(b, sizeof(b), "7E8#04410c%02lx%02lx 7E8#03410d%02lx 7E8#0341%02lx",
               (rv >> 8) & 0xFF, rv & 0xFF, (t % 70) & 0xFF, (min(92L, 25 + t) + 40) & 0xFF);
      printOK(b);
    } else {
      String s; Frame m; int count = 0;
      pumpRx();
      while (popRx(&m) && count < 24) {
        char f[40]; int k = snprintf(f, sizeof(f), "%lX#", (unsigned long)(m.id & 0x1FFFFFFF));
        for (uint32_t i = 0; i < m.dlc && i < 8; i++) { char h[3]; snprintf(h, sizeof(h), "%02X", m.data[i]); f[k++] = h[0]; f[k++] = h[1]; }
        f[k] = 0; if (count) s += ' '; s += f; count++;
      }
      printOK(count ? s.c_str() : "(no frames)");
    }
  } else if (!strcmp(cmd, "CANDUMP2")) {
    if (simScenario) { printOK("520#0102030405060708 625#aa55aa55"); return; }
    if (!canUp2) { printOK("(MS controller down — check the 2nd MCP2515 wiring/crystal)"); return; }
    String s; Frame m; int count = 0;
    pumpRx2();
    while (popRx2(&m) && count < 24) {
      char f[40]; int k = snprintf(f, sizeof(f), "%lX#", (unsigned long)(m.id & 0x1FFFFFFF));
      for (uint32_t i = 0; i < m.dlc && i < 8; i++) { char h[3]; snprintf(h, sizeof(h), "%02X", m.data[i]); f[k++] = h[0]; f[k++] = h[1]; }
      f[k] = 0; if (count) s += ' '; s += f; count++;
    }
    printOK(count ? s.c_str() : "(no frames)");
  } else if (!strcmp(cmd, "OBD")) {
    if (nt < 2) { printERR("OBD needs a mode"); return; }
    uint8_t mode = (uint8_t)strtol(tok[1], nullptr, 16);
    int pid = (nt > 2) ? (int)strtol(tok[2], nullptr, 16) : -1;
    uint8_t out[80]; const char* err = "error";
    int n = simScenario ? simObd(mode, pid, out, &err) : realObd(mode, pid, out, &err);
    if (n < 0) printERR(err); else printOKBytes(out, n);
  } else if (!strcmp(cmd, "ISOTP")) {
    if (nt < 3) { printERR("ISOTP needs <txid> <hex>"); return; }
    uint32_t txid = (uint32_t)strtol(tok[1], nullptr, 16);
    uint8_t req[8]; int reqLen = 0; const char* h = tok[2];
    while (h[0] && h[1] && reqLen < 8) { char bb[3] = { h[0], h[1], 0 }; req[reqLen++] = (uint8_t)strtol(bb, nullptr, 16); h += 2; }
    uint8_t out[80];
    int n = simScenario ? simIsotp(txid, req, reqLen, out) : isotpRequest(txid, req, reqLen, out, sizeof(out), nullptr);
    if (n <= 0) printERR("no response"); else printOKBytes(out, n);
  } else if (!strcmp(cmd, "REQDUMP")) {
    if (nt < 3) { printERR("REQDUMP needs <txid> <hex>"); return; }
    if (simScenario) { printOK("7E8#0641004000 174#ffe7d4aa00000000 176#0000000000"); return; }
    uint32_t txid = (uint32_t)strtol(tok[1], nullptr, 16);
    uint8_t req[8]; int reqLen = 0; const char* h = tok[2];
    while (h[0] && h[1] && reqLen < 8) { char bb[3] = { h[0], h[1], 0 }; req[reqLen++] = (uint8_t)strtol(bb, nullptr, 16); h += 2; }
    Frame drain; pumpActive(); while (popRxActive(&drain)) {}
    uint8_t f[8]; f[0] = (uint8_t)reqLen;
    for (int i = 0; i < reqLen; i++) f[1 + i] = req[i];
    canSendFrame(txid, f, 1 + reqLen);
    uint16_t seen[20]; int nseen = 0; String s;
    uint32_t deadline = millis() + 800;
    while ((long)(deadline - millis()) > 0) {
      pumpActive();
      Frame m;
      if (!popRxActive(&m)) { delay(1); continue; }
      uint32_t id = m.id & 0x1FFFFFFF;
      bool known = false;
      for (int i = 0; i < nseen; i++) if (seen[i] == id) known = true;
      if (known || nseen >= 20) continue;
      seen[nseen++] = (uint16_t)id;
      char fr[40]; int k = snprintf(fr, sizeof(fr), "%lX#", (unsigned long)id);
      for (uint32_t i = 0; i < m.dlc && i < 8; i++) { char hh[3]; snprintf(hh, sizeof(hh), "%02X", m.data[i]); fr[k++] = hh[0]; fr[k++] = hh[1]; }
      fr[k] = 0; if (nseen > 1) s += ' '; s += fr;
    }
    printOK(nseen ? s.c_str() : "(no frames)");
  } else if (!strcmp(cmd, "PROBE")) {
    if (simScenario) { printOK("7E8 7E9 7EA 7EB"); return; }
    uint16_t ids[8]; int n = probeModules(ids, 8);
    if (n == 0) { printOK("(none)"); return; }
    String s;
    for (int i = 0; i < n; i++) { if (i) s += ' '; char bb[6]; snprintf(bb, sizeof(bb), "%X", ids[i]); s += bb; }
    printOK(s.c_str());
  } else if (!strcmp(cmd, "SIM")) {
    const char* arg = (nt > 1) ? tok[1] : "OFF";
    for (char* c = (char*)arg; *c; c++) *c = toupper(*c);
    if (!strcmp(arg, "OFF")) { simScenario = nullptr; printOK("sim off"); }
    else if (!strcmp(arg, "IGNITION") || !strcmp(arg, "WEAK") || !strcmp(arg, "IDLE") || !strcmp(arg, "DRIVE")) {
      if (!strcmp(arg, "IGNITION")) simScenario = "IGNITION";
      else if (!strcmp(arg, "WEAK")) simScenario = "WEAK";
      else if (!strcmp(arg, "IDLE")) simScenario = "IDLE";
      else simScenario = "DRIVE";
      simT0 = millis(); simCleared = false;
      char b[48]; snprintf(b, sizeof(b), "sim=%s (SIMULATION - not a real car)", simScenario); printOK(b);
    } else printERR("scenario must be OFF|IGNITION|WEAK|IDLE|DRIVE");
  } else {
    printERR("unknown cmd (try HELP)");
  }
}

String inLine;

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(PIN_INT, INPUT);
  pinMode(PIN_INT2, INPUT);
  pinMode(PIN_CS2, OUTPUT); digitalWrite(PIN_CS2, HIGH);  // deselect MS before HS init
  analogReadResolution(12);
  EEPROM.begin(256);
  loadConfig();
  t0 = millis();

  // RP2040 SPI0 pins for the arduino-pico core, then bring up both controllers.
  // Both MCP2515s share SCK/MOSI/MISO; each drives its own CS, so they coexist.
  SPI.setSCK(PIN_SCK); SPI.setTX(PIN_MOSI); SPI.setRX(PIN_MISO); SPI.setCS(PIN_CS);
  canUp  = bringUpCan();
  canUp2 = bringUpCan2();   // returns false (ms=DOWN) if the 2nd module isn't wired yet — harmless
  if (activeBus == 1 && !canUp2) activeBus = 0;   // never transmit on a bus that didn't come up

  Serial.println(String(FIRMWARE)
    + (canUp ? " HS ready." : " HS NOT found (check wiring/crystal).")
    + (canUp2 ? " MS ready." : " MS down (2nd module absent/misw).")
    + " Type HELP.");
}

unsigned long lastHb = 0;

void loop() {
  unsigned long now = millis();
  if (now - lastHb > 250) { digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN)); lastHb = now; }

  pumpRx();    // keep the HS RX ring fed for passive monitoring
  pumpRx2();   // and the MS RX ring

  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') { char buf[160]; inLine.toCharArray(buf, sizeof(buf)); handle(buf); inLine = ""; }
    else if (c >= 0x20 && inLine.length() < 150) inLine += c;
  }
}
