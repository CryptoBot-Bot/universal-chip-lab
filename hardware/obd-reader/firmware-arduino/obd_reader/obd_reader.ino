// obd_reader.ino — OBD-II reader firmware (Arduino-Pico + can2040 real CAN)
// =============================================================================
// The real-CAN successor to the MicroPython firmware. Same USB serial protocol
// (PING / BATT / OBD / CANDUMP / SIM …) so the Universal Chip Lab desktop app
// drives it UNCHANGED — only the CAN layer underneath is now real, via can2040
// running on the RP2040's PIO through the ACAN2040 (Duncan Greenwood) library.
//
//   Board   : Raspberry Pi Pico   (Arduino-Pico core, earlephilhower)
//   Library : ACAN2040  (Library Manager)
//   Wiring  : SN65HVD230  D/CTX <- GP5 (TX),  R/CRX -> GP4 (RX)  [BUILD.md]
//             battery divider 47k/10k -> GP28 (ADC2)
//
// SIM mode is retained: with no car you can still prove the whole firmware +
// app end-to-end. Everything under SIM is FAKE and the app flags it.
// =============================================================================
#include <ACAN2040.h>
#include <EEPROM.h>   // arduino-pico: flash-emulated EEPROM, for persistent calibration

static const char* FIRMWARE = "OBD-Reader v2 (can2040)";

// Settings are stored in flash so they survive power-cycles AND follow the
// device to any PC. Layout: [0]=magic, [4]=float ratio, [8]=uint32 bitrate.
static const uint32_t CAL_MAGIC = 0xCA11B007;

// ---- pins ----
static const uint8_t CAN_TX_PIN = 5;      // -> transceiver D / CTX
static const uint8_t CAN_RX_PIN = 4;      // <- transceiver R / CRX
static const uint8_t CAN_PIO    = 0;
static uint32_t bitrate = 500000;          // HS-CAN bitrate (flash; 125k/250k/500k)
// Second (MS-CAN) bus: 2nd SN65HVD230 on GP7=TX / GP6=RX -> OBD pins 3/11.
static const uint8_t MS_CAN_TX_PIN = 7;
static const uint8_t MS_CAN_RX_PIN = 6;
static const uint8_t MS_CAN_PIO    = 1;    // RP2040's second PIO block
static uint32_t bitrateMs = 125000;        // MS-CAN bitrate (flash; default 125k)
#define BATT_ADC A2                        // GP28 = ADC2

// ---- battery calibration / thresholds ----
static const float VREF = 3.3f;
static const int   ADC_MAX = 4095;         // 12-bit
static float ratio = 5.7f;                 // (47k+10k)/10k
static const float V_LOW = 11.8f, V_CHARGING = 13.2f;

// ---- OBD-II / ISO-TP ----
static const uint32_t OBD_REQUEST_ID = 0x7DF;  // functional broadcast
static const uint8_t  PAD = 0x55;              // unused request bytes (ECUs ignore value; 0x00 also fine)
static const uint32_t OBD_TIMEOUT_MS = 1000;

// ---- state ----
ACAN2040* can = nullptr;
ACAN2040* can2 = nullptr;   // MS-CAN, lazily created on first use (see ensureCan2)
unsigned long t0 = 0;
float vmin = 99.0f, vmax = 0.0f;

// sim
const char* simScenario = nullptr;   // nullptr = off
unsigned long simT0 = 0;
bool simCleared = false;

// ---- CAN RX ring buffers (single-producer IRQ, single-consumer loop) ----
#define RXBUF 48
static struct can2040_msg rxq[RXBUF];
volatile uint8_t rxHead = 0, rxTail = 0;
static struct can2040_msg rxq2[RXBUF];   // MS-CAN
volatile uint8_t rxHead2 = 0, rxTail2 = 0;

static void canCallback(struct can2040* cd, uint32_t notify, struct can2040_msg* msg) {
  (void)cd;
  if (notify & CAN2040_NOTIFY_RX) {
    uint8_t n = (rxHead + 1) % RXBUF;
    if (n != rxTail) {                 // drop on overflow rather than block
      rxq[rxHead] = *msg;
      rxHead = n;
    }
  }
}

static bool popRx(struct can2040_msg* out) {
  if (rxTail == rxHead) return false;
  *out = rxq[rxTail];
  rxTail = (rxTail + 1) % RXBUF;
  return true;
}

static void canCallback2(struct can2040* cd, uint32_t notify, struct can2040_msg* msg) {
  (void)cd;
  if (notify & CAN2040_NOTIFY_RX) {
    uint8_t n = (rxHead2 + 1) % RXBUF;
    if (n != rxTail2) { rxq2[rxHead2] = *msg; rxHead2 = n; }
  }
}

static bool popRx2(struct can2040_msg* out) {
  if (rxTail2 == rxHead2) return false;
  *out = rxq2[rxTail2];
  rxTail2 = (rxTail2 + 1) % RXBUF;
  return true;
}

// MS-CAN is lazily started on first use, so it can never affect HS-CAN boot.
static void ensureCan2() {
  if (!can2) {
    can2 = new ACAN2040(MS_CAN_PIO, MS_CAN_TX_PIN, MS_CAN_RX_PIN, bitrateMs, F_CPU, canCallback2);
    can2->begin();
  }
}

// =============================================================================
// Battery
// =============================================================================
static float simVoltage() {
  float t = (millis() - simT0) / 1000.0f;
  float base = 12.5f;
  if (!strcmp(simScenario, "WEAK")) base = 11.4f;
  else if (!strcmp(simScenario, "IDLE")) base = 13.9f;
  else if (!strcmp(simScenario, "DRIVE")) {
    if (t < 3) base = 12.5f;
    else if (t < 4) base = 10.2f;            // crank dip
    else if (t < 12) base = 12.6f + (t - 4) * 0.21f;  // alternator ramp
    else base = 14.3f;
  } else if (!strcmp(simScenario, "IGNITION")) base = 12.5f;
  float jitter = (((long)(millis() / 100) % 7) - 3) * 0.02f;
  return base + jitter;
}

static float readBattery() {
  if (simScenario) return simVoltage();
  const int N = 15;
  int v[N];
  for (int i = 0; i < N; i++) { v[i] = analogRead(BATT_ADC); delay(1); }
  for (int i = 1; i < N; i++) {             // insertion sort -> median
    int x = v[i], j = i - 1;
    while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; }
    v[j + 1] = x;
  }
  float vadc = (float)v[N / 2] / ADC_MAX * VREF;
  return vadc * ratio;
}

static const char* classify(float vb) {
  if (vb < V_LOW) return "LOW";
  if (vb >= V_CHARGING) return "CHARGING";
  return "OK";
}

// =============================================================================
// OBD-II — simulated answers
// =============================================================================
// Fills out[] with the response DATA (after the 0x4X service echo), returns its
// length, or -1 with *err set. Mirrors the MicroPython sim exactly.
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
  if (mode == 0x03) {
    if (simCleared) return 0;
    out[0] = 0x03; out[1] = 0x01; out[2] = 0x04; out[3] = 0x20; return 4;  // P0301, P0420
  }
  if (mode == 0x07 || mode == 0x0A) return 0;
  if (mode == 0x09 && pid == 0x02) {
    const char* vin = "1HGSIM0000PICO123";
    out[0] = 0x02; out[1] = 0x01;
    for (int i = 0; i < 17; i++) out[2 + i] = vin[i];
    return 19;
  }
  if (mode == 0x04) { simCleared = true; return 0; }
  *err = "Mode not simulated";
  return -1;
}

// =============================================================================
// ISO-TP transport (shared by OBD-II and UDS) over real CAN
// =============================================================================
static void canSendFrame(uint32_t id, const uint8_t* d, int dlc) {
  struct can2040_msg m;
  m.id = id; m.dlc = 8;                       // OBD frames are padded to 8
  for (int i = 0; i < 8; i++) m.data[i] = (i < dlc) ? d[i] : PAD;
  can->send_message(&m);
}

// Sends a single-frame request (<=7 bytes) to txid, then reassembles the first
// response from any 0x7E8-0x7EF (single + multi-frame w/ flow control). `out`
// gets the RAW response INCLUDING the service byte. Returns length, 0 on timeout.
static int isotpRequest(uint32_t txid, const uint8_t* req, int reqLen,
                        uint8_t* out, int outMax, uint32_t* respId) {
  if (!can || reqLen > 7) return -1;          // single-frame requests only

  struct can2040_msg drain;
  while (popRx(&drain)) {}                     // flush stale frames

  uint8_t f[8];
  f[0] = (uint8_t)reqLen;                       // single-frame PCI = length
  for (int i = 0; i < reqLen; i++) f[1 + i] = req[i];
  canSendFrame(txid, f, 1 + reqLen);

  int asmLen = 0, expected = -1;
  uint32_t rid = 0;
  uint32_t deadline = millis() + OBD_TIMEOUT_MS;

  while ((long)(deadline - millis()) > 0) {
    struct can2040_msg m;
    if (!popRx(&m)) { delay(1); continue; }
    uint32_t id = m.id & 0x1FFFFFFF;
    if (id < 0x7E8 || id > 0x7EF) continue;
    uint8_t pci = m.data[0] & 0xF0;
    if (pci == 0x00) {                          // single frame
      int len = m.data[0] & 0x0F;
      for (int i = 0; i < len && i < outMax; i++) out[i] = m.data[1 + i];
      asmLen = len; rid = id; break;
    } else if (pci == 0x10) {                   // first frame
      expected = ((m.data[0] & 0x0F) << 8) | m.data[1];
      for (int i = 0; i < 6 && asmLen < outMax; i++) out[asmLen++] = m.data[2 + i];
      rid = id;
      uint8_t fc[3] = { 0x30, 0x00, 0x00 };     // flow control -> responder's request id
      canSendFrame(id - 8, fc, 3);
    } else if (pci == 0x20) {                    // consecutive frame
      for (int i = 0; i < 7 && asmLen < expected && asmLen < outMax; i++)
        out[asmLen++] = m.data[1 + i];
      if (expected > 0 && asmLen >= expected) break;
    }
  }
  if (respId) *respId = rid;
  return asmLen;
}

// OBD-II to the functional address; returns the response AFTER the service byte
// (app-compatible). Reuses the ISO-TP engine.
static int realObd(uint8_t mode, int pid, uint8_t* out, const char** err) {
  uint8_t req[2]; int reqLen;
  if (pid >= 0) { req[0] = mode; req[1] = (uint8_t)pid; reqLen = 2; }
  else { req[0] = mode; reqLen = 1; }
  uint8_t raw[80];
  int n = isotpRequest(OBD_REQUEST_ID, req, reqLen, raw, sizeof(raw), nullptr);
  if (n <= 0) { *err = "no response (engine off? wrong bus? car uses K-line?)"; return -1; }
  for (int i = 0; i < n - 1; i++) out[i] = raw[1 + i];   // strip the 0x4X service echo
  return n - 1;
}

// Functional supported-PIDs request; collects every distinct responder id, so we
// can see which modules are present. Returns count; ids[] gets the addresses.
static int probeModules(uint16_t* ids, int maxIds) {
  if (!can) return 0;
  struct can2040_msg drain;
  while (popRx(&drain)) {}
  uint8_t f[3] = { 0x02, 0x01, 0x00 };          // SF: mode 01 pid 00 (supported PIDs)
  canSendFrame(OBD_REQUEST_ID, f, 3);
  int count = 0;
  uint32_t deadline = millis() + 1200;
  while ((long)(deadline - millis()) > 0) {
    struct can2040_msg m;
    if (!popRx(&m)) { delay(1); continue; }
    uint32_t id = m.id & 0x1FFFFFFF;
    if (id < 0x7E8 || id > 0x7EF) continue;
    bool known = false;
    for (int i = 0; i < count; i++) if (ids[i] == id) known = true;
    if (!known && count < maxIds) ids[count++] = (uint16_t)id;
  }
  return count;
}

// Simulated ISO-TP/UDS responder for SIM mode — lets the whole multi-module +
// UDS app be exercised with no car. Returns RAW response (incl. service byte).
static int simIsotp(uint32_t txid, const uint8_t* req, int reqLen, uint8_t* out) {
  (void)txid;
  if (reqLen < 1) return 0;
  uint8_t svc = req[0];
  if (svc == 0x3E) return 0;   // sim: no tester-present reply (discovery uses PROBE's list)
  if (svc == 0x10) { out[0] = 0x50; out[1] = (reqLen > 1) ? req[1] : 1;
                     out[2] = 0x00; out[3] = 0x32; out[4] = 0x01; out[5] = 0xF4; return 6; }
  if (svc == 0x22) {                                                     // read data by id
    if (reqLen >= 3 && req[1] == 0xF1 && req[2] == 0x90) {               // VIN
      const char* vin = "1HGSIM0000PICO123";
      out[0] = 0x62; out[1] = 0xF1; out[2] = 0x90;
      for (int i = 0; i < 17; i++) out[3 + i] = vin[i];
      return 20;
    }
    out[0] = 0x62; out[1] = (reqLen > 1) ? req[1] : 0; out[2] = (reqLen > 2) ? req[2] : 0;
    out[3] = 0xAA; out[4] = 0x55; return 5;                             // generic DID
  }
  if (svc == 0x19) {                                                     // read DTC info
    if (simCleared) { out[0] = 0x59; out[1] = 0x02; out[2] = 0xFF; return 3; }
    uint8_t r[] = { 0x59, 0x02, 0xFF, 0x04, 0x20, 0x00, 0x09, 0x01, 0x76, 0x00, 0x09 };
    for (int i = 0; i < (int)sizeof(r); i++) out[i] = r[i];             // P0420, P0176
    return sizeof(r);
  }
  if (svc == 0x14) { simCleared = true; out[0] = 0x54; return 1; }       // clear DTCs
  out[0] = 0x7F; out[1] = svc; out[2] = 0x11; return 3;                  // serviceNotSupported
}

// =============================================================================
// Serial protocol
// =============================================================================
static void printOK(const char* s) { Serial.print("OK "); Serial.println(s); }
static void printERR(const char* s) { Serial.print("ERR "); Serial.println(s); }

static void printOKBytes(const uint8_t* d, int n) {
  Serial.print("OK ");
  for (int i = 0; i < n; i++) {
    if (d[i] < 0x10) Serial.print('0');
    Serial.print(d[i], HEX);
  }
  Serial.println();
}

static void handle(char* line) {
  // tokenize on spaces (up to 3 tokens is all we need)
  char* tok[4]; int nt = 0;
  char* p = strtok(line, " \t");
  while (p && nt < 4) { tok[nt++] = p; p = strtok(nullptr, " \t"); }
  if (nt == 0) return;
  for (char* c = tok[0]; *c; c++) *c = toupper(*c);
  const char* cmd = tok[0];

  if (!strcmp(cmd, "PING")) {
    printOK(FIRMWARE);
  } else if (!strcmp(cmd, "HELP")) {
    printOK("PING INFO BATT CAL<r> SPEED<125|250|500> SPEEDMS<125|250|500> RESET CANINIT CANRESET CANDUMP CANDUMP2 OBD<mode>[<pid>] ISOTP<txid><hex> REQDUMP<txid><hex> PROBE SIM<OFF|IGNITION|WEAK|IDLE|DRIVE>");
  } else if (!strcmp(cmd, "INFO")) {
    char b[120];
    snprintf(b, sizeof(b), "ratio=%.3f | low=%.1f charging=%.1f | can=up@%lu | ms=up@%lu | sim=%s | can2040",
             ratio, V_LOW, V_CHARGING, (unsigned long)bitrate, (unsigned long)bitrateMs, simScenario ? simScenario : "off");
    printOK(b);
  } else if (!strcmp(cmd, "BATT")) {
    float vb = readBattery();
    if (vb < vmin) vmin = vb;
    if (vb > vmax) vmax = vb;
    char b[80];
    snprintf(b, sizeof(b), "%lu,%.2f,%s,%.2f,%.2f", (unsigned long)(millis() - t0), vb, classify(vb), vmin, vmax);
    printOK(b);
  } else if (!strcmp(cmd, "CAL")) {
    if (nt > 1) { ratio = atof(tok[1]); saveRatio(); }   // persist to flash
    char b[32]; snprintf(b, sizeof(b), "ratio=%.3f", ratio); printOK(b);
  } else if (!strcmp(cmd, "RESET")) {
    vmin = 99.0f; vmax = 0.0f; printOK("min/max cleared");
  } else if (!strcmp(cmd, "CANRESET")) {
    // Recover from bus-off by rebooting: re-runs setup() → fresh can2040 + reloads
    // calibration from flash. The USB port drops briefly; the app reconnects.
    printOK("rebooting");
    Serial.flush();
    delay(50);
    rp2040.reboot();
  } else if (!strcmp(cmd, "SPEEDMS")) {
    // MS-CAN bus speed (default 125k). Stored + reboot, like SPEED.
    if (nt < 2) { printERR("SPEEDMS needs 125 / 250 / 500"); return; }
    long v = strtol(tok[1], nullptr, 10);
    if (v < 1000) v *= 1000;
    if (v != 125000 && v != 250000 && v != 500000) { printERR("only 125000/250000/500000"); return; }
    saveBitrateMs((uint32_t)v);
    char b[40]; snprintf(b, sizeof(b), "ms speed=%ld, rebooting", v); printOK(b);
    Serial.flush(); delay(50); rp2040.reboot();
  } else if (!strcmp(cmd, "SPEED")) {
    // SPEED <250000|500000> (or 250/500) — store the bus bitrate and reboot into it.
    if (nt < 2) { printERR("SPEED needs 125 / 250 / 500 (kbit) or the full bps"); return; }
    long v = strtol(tok[1], nullptr, 10);
    if (v < 1000) v *= 1000;                 // accept "125"/"250"/"500" shorthand
    if (v != 125000 && v != 250000 && v != 500000) { printERR("only 125000/250000/500000 supported"); return; }
    saveBitrate((uint32_t)v);
    char b[40]; snprintf(b, sizeof(b), "speed=%ld, rebooting", v); printOK(b);
    Serial.flush(); delay(50); rp2040.reboot();
  } else if (!strcmp(cmd, "CANINIT")) {
    char b[32]; snprintf(b, sizeof(b), "can up @ %lu bps", (unsigned long)bitrate); printOK(b);
  } else if (!strcmp(cmd, "CANDUMP")) {
    if (simScenario) {
      long t = (millis() - simT0) / 1000;
      long rv = (800 + (t % 30) * 80) * 4;
      char b[96];
      snprintf(b, sizeof(b), "7E8#04410c%02lx%02lx 7E8#03410d%02lx 7E8#0341%02lx",
               (rv >> 8) & 0xFF, rv & 0xFF, (t % 70) & 0xFF, (min(92L, 25 + t) + 40) & 0xFF);
      printOK(b);
    } else {
      String s; struct can2040_msg m; int count = 0;
      while (popRx(&m) && count < 24) {
        char f[40]; int k = snprintf(f, sizeof(f), "%lX#", (unsigned long)(m.id & 0x1FFFFFFF));
        for (uint32_t i = 0; i < m.dlc && i < 8; i++) { char h[3]; snprintf(h, sizeof(h), "%02X", m.data[i]); f[k++] = h[0]; f[k++] = h[1]; }
        f[k] = 0; if (count) s += ' '; s += f; count++;
      }
      printOK(count ? s.c_str() : "(no frames)");
    }
  } else if (!strcmp(cmd, "CANDUMP2")) {
    // Passive monitor of the MS-CAN bus (2nd transceiver, OBD pins 3/11).
    if (simScenario) { printOK("520#0102030405060708 625#aa55aa55"); return; }
    ensureCan2();                          // lazily start the 2nd CAN controller
    String s; struct can2040_msg m; int count = 0;
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
    // ISOTP <txidHex> <payloadHex> — raw request/response to any address (UDS etc.)
    if (nt < 3) { printERR("ISOTP needs <txid> <hex>"); return; }
    uint32_t txid = (uint32_t)strtol(tok[1], nullptr, 16);
    uint8_t req[8]; int reqLen = 0;
    const char* h = tok[2];
    while (h[0] && h[1] && reqLen < 8) {
      char bb[3] = { h[0], h[1], 0 };
      req[reqLen++] = (uint8_t)strtol(bb, nullptr, 16);
      h += 2;
    }
    uint8_t out[80];
    int n = simScenario ? simIsotp(txid, req, reqLen, out)
                        : isotpRequest(txid, req, reqLen, out, sizeof(out), nullptr);
    if (n <= 0) printERR("no response"); else printOKBytes(out, n);
  } else if (!strcmp(cmd, "REQDUMP")) {
    // RE tool: send a request to <txid>, then capture every DISTINCT id seen for
    // ~800 ms — reveals responses on non-standard addresses (Nissan etc.).
    if (nt < 3) { printERR("REQDUMP needs <txid> <hex>"); return; }
    if (simScenario) { printOK("7E8#0641004000 174#ffe7d4aa00000000 176#0000000000"); return; }
    uint32_t txid = (uint32_t)strtol(tok[1], nullptr, 16);
    uint8_t req[8]; int reqLen = 0;
    const char* h = tok[2];
    while (h[0] && h[1] && reqLen < 8) { char bb[3] = { h[0], h[1], 0 }; req[reqLen++] = (uint8_t)strtol(bb, nullptr, 16); h += 2; }
    struct can2040_msg drain; while (popRx(&drain)) {}
    uint8_t f[8]; f[0] = (uint8_t)reqLen;
    for (int i = 0; i < reqLen; i++) f[1 + i] = req[i];
    canSendFrame(txid, f, 1 + reqLen);
    uint16_t seen[20]; int nseen = 0; String s;
    uint32_t deadline = millis() + 800;
    while ((long)(deadline - millis()) > 0) {
      struct can2040_msg m;
      if (!popRx(&m)) { delay(1); continue; }
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
    // Discover which modules answer (their CAN response addresses).
    if (simScenario) { printOK("7E8 7E9 7EA 7EB"); return; }   // ECM, TCM, +2 modules (fake)
    uint16_t ids[8];
    int n = probeModules(ids, 8);
    if (n == 0) { printOK("(none)"); return; }
    String s;
    for (int i = 0; i < n; i++) { if (i) s += ' '; char bb[6]; snprintf(bb, sizeof(bb), "%X", ids[i]); s += bb; }
    printOK(s.c_str());
  } else if (!strcmp(cmd, "SIM")) {
    const char* arg = (nt > 1) ? tok[1] : "OFF";
    for (char* c = (char*)arg; *c; c++) *c = toupper(*c);
    if (!strcmp(arg, "OFF")) { simScenario = nullptr; printOK("sim off"); }
    else if (!strcmp(arg, "IGNITION") || !strcmp(arg, "WEAK") || !strcmp(arg, "IDLE") || !strcmp(arg, "DRIVE")) {
      // keep a stable pointer to a literal so strcmp works later
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

// =============================================================================
// Persistent calibration (flash-emulated EEPROM)
static void saveRatio() {
  EEPROM.put(0, CAL_MAGIC);
  EEPROM.put(4, ratio);
  EEPROM.commit();             // actually write the flash sector
}

static void saveBitrate(uint32_t b) {
  EEPROM.put(0, CAL_MAGIC);
  EEPROM.put(8, b);
  EEPROM.commit();
}

static void saveBitrateMs(uint32_t b) {
  EEPROM.put(0, CAL_MAGIC);
  EEPROM.put(12, b);
  EEPROM.commit();
}

static void loadConfig() {
  uint32_t magic = 0;
  EEPROM.get(0, magic);
  if (magic == CAL_MAGIC) {
    float r = 0;
    EEPROM.get(4, r);
    if (r > 0.1f && r < 100.0f) ratio = r;   // sanity-bound before trusting it
  }
  uint32_t b = 0;
  EEPROM.get(8, b);
  if (b == 125000 || b == 250000 || b == 500000) bitrate = b;  // value-validated
  uint32_t bm = 0;
  EEPROM.get(12, bm);
  if (bm == 125000 || bm == 250000 || bm == 500000) bitrateMs = bm;
}

String inLine;

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  analogReadResolution(12);
  EEPROM.begin(256);           // reserve a flash page for settings
  loadConfig();                // restore stored calibration + bus speed, if any
  t0 = millis();

  can = new ACAN2040(CAN_PIO, CAN_TX_PIN, CAN_RX_PIN, bitrate, F_CPU, canCallback);
  can->begin();

  Serial.println(String(FIRMWARE) + " ready. Type HELP and press Enter.");
}

unsigned long lastHb = 0;

void loop() {
  unsigned long now = millis();
  if (now - lastHb > 250) { digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN)); lastHb = now; }

  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') {
      char buf[160];
      inLine.toCharArray(buf, sizeof(buf));
      handle(buf);
      inLine = "";
    } else if (c >= 0x20 && inLine.length() < 150) {
      inLine += c;                            // ignore CR + stray control bytes (e.g. app's Ctrl-C/D)
    }
  }
}
