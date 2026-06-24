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

static const char* FIRMWARE = "OBD-Reader v2 (can2040)";

// ---- pins ----
static const uint8_t CAN_TX_PIN = 5;      // -> transceiver D / CTX
static const uint8_t CAN_RX_PIN = 4;      // <- transceiver R / CRX
static const uint8_t CAN_PIO    = 0;
static const uint32_t CAN_BITRATE = 500000;   // OBD-II high-speed CAN
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
unsigned long t0 = 0;
float vmin = 99.0f, vmax = 0.0f;

// sim
const char* simScenario = nullptr;   // nullptr = off
unsigned long simT0 = 0;
bool simCleared = false;

// ---- CAN RX ring buffer (single-producer IRQ, single-consumer loop) ----
#define RXBUF 48
static struct can2040_msg rxq[RXBUF];
volatile uint8_t rxHead = 0, rxTail = 0;

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
// OBD-II — real CAN request/response with ISO-TP reassembly
// =============================================================================
// Sends a request to 0x7DF and reassembles the first ECU response (0x7E8-0x7EF),
// handling single-frame and multi-frame (First/Consecutive + Flow Control).
// out[] gets the response data AFTER the service byte. Returns length, or -1.
static int realObd(uint8_t mode, int pid, uint8_t* out, const char** err) {
  if (!can) { *err = "CAN not initialised"; return -1; }

  struct can2040_msg drain;
  while (popRx(&drain)) {}                   // flush stale frames before requesting

  struct can2040_msg req;
  req.id = OBD_REQUEST_ID;
  req.dlc = 8;
  for (int i = 0; i < 8; i++) req.data[i] = PAD;
  if (pid >= 0) { req.data[0] = 0x02; req.data[1] = mode; req.data[2] = (uint8_t)pid; }
  else { req.data[0] = 0x01; req.data[1] = mode; }
  can->send_message(&req);   // if it can't go out, we simply time out below

  uint8_t asmbuf[80];
  int asmLen = 0, expected = -1;
  uint32_t deadline = millis() + OBD_TIMEOUT_MS;

  while ((long)(deadline - millis()) > 0) {
    struct can2040_msg m;
    if (!popRx(&m)) { delay(1); continue; }
    uint32_t rid = m.id & 0x1FFFFFFF;
    if (rid < 0x7E8 || rid > 0x7EF) continue;   // OBD-II responses only

    uint8_t pci = m.data[0] & 0xF0;
    if (pci == 0x00) {                          // single frame
      int len = m.data[0] & 0x0F;
      for (int i = 0; i < len && i < (int)sizeof(asmbuf); i++) asmbuf[i] = m.data[1 + i];
      asmLen = len;
      break;
    } else if (pci == 0x10) {                   // first frame of a multi-frame msg
      expected = ((m.data[0] & 0x0F) << 8) | m.data[1];
      for (int i = 0; i < 6; i++) asmbuf[asmLen++] = m.data[2 + i];
      struct can2040_msg fc;                    // flow control -> responder id - 8
      fc.id = rid - 8; fc.dlc = 8;
      for (int i = 0; i < 8; i++) fc.data[i] = PAD;
      fc.data[0] = 0x30; fc.data[1] = 0x00; fc.data[2] = 0x00;
      can->send_message(&fc);
    } else if (pci == 0x20) {                    // consecutive frame
      for (int i = 0; i < 7 && asmLen < expected && asmLen < (int)sizeof(asmbuf); i++)
        asmbuf[asmLen++] = m.data[1 + i];
      if (expected > 0 && asmLen >= expected) break;
    }
  }

  if (asmLen == 0) { *err = "no response (engine off? wrong bus? car uses K-line?)"; return -1; }
  // Strip the service byte (mode + 0x40); return the rest, matching the app.
  int n = asmLen - 1;
  for (int i = 0; i < n; i++) out[i] = asmbuf[1 + i];
  return n < 0 ? 0 : n;
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
    printOK("PING INFO BATT CAL<r> RESET CANINIT CANDUMP OBD<mode>[<pid>] SIM<OFF|IGNITION|WEAK|IDLE|DRIVE>");
  } else if (!strcmp(cmd, "INFO")) {
    char b[120];
    snprintf(b, sizeof(b), "ratio=%.3f | low=%.1f charging=%.1f | can=up@%lu | sim=%s | can2040",
             ratio, V_LOW, V_CHARGING, (unsigned long)CAN_BITRATE, simScenario ? simScenario : "off");
    printOK(b);
  } else if (!strcmp(cmd, "BATT")) {
    float vb = readBattery();
    if (vb < vmin) vmin = vb;
    if (vb > vmax) vmax = vb;
    char b[80];
    snprintf(b, sizeof(b), "%lu,%.2f,%s,%.2f,%.2f", (unsigned long)(millis() - t0), vb, classify(vb), vmin, vmax);
    printOK(b);
  } else if (!strcmp(cmd, "CAL")) {
    if (nt > 1) ratio = atof(tok[1]);
    char b[32]; snprintf(b, sizeof(b), "ratio=%.3f", ratio); printOK(b);
  } else if (!strcmp(cmd, "RESET")) {
    vmin = 99.0f; vmax = 0.0f; printOK("min/max cleared");
  } else if (!strcmp(cmd, "CANINIT")) {
    printOK("can up @ 500000 bps");          // CAN is begun in setup(); this just acks
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
  } else if (!strcmp(cmd, "OBD")) {
    if (nt < 2) { printERR("OBD needs a mode"); return; }
    uint8_t mode = (uint8_t)strtol(tok[1], nullptr, 16);
    int pid = (nt > 2) ? (int)strtol(tok[2], nullptr, 16) : -1;
    uint8_t out[80]; const char* err = "error";
    int n = simScenario ? simObd(mode, pid, out, &err) : realObd(mode, pid, out, &err);
    if (n < 0) printERR(err); else printOKBytes(out, n);
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
String inLine;

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  analogReadResolution(12);
  t0 = millis();

  can = new ACAN2040(CAN_PIO, CAN_TX_PIN, CAN_RX_PIN, CAN_BITRATE, F_CPU, canCallback);
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
