// fake_ecu.ino — a bench OBD-II / UDS responder, for a 2nd Pico.
// =============================================================================
// Flash this to a SPARE Pico + transceiver and wire it to the reader (CANH-CANH,
// CANL-CANL, 120 ohm at EACH end, common ground). It answers standard requests
// to 0x7DF / 0x7E0 on 0x7E8 — so it's a KNOWN-GOOD target to prove the reader's
// active request/response path (Scan all modules / Read codes / Live data / UDS).
//
//   - Scan works against this  -> the reader's TX+RX active path is GOOD; a real
//     car not answering is then car-specific (speed, addressing, gateway).
//   - Scan fails against this  -> the bug is in the reader; debug it here.
//
// Board: Raspberry Pi Pico (Arduino-Pico).  Library: ACAN2040.
// Wiring: SN65HVD230  D <- GP5 (TX),  R -> GP4 (RX).  Bus @ 500 kbit/s.
// =============================================================================
#include <ACAN2040.h>

static const uint8_t CAN_TX_PIN = 5;
static const uint8_t CAN_RX_PIN = 4;
static const uint8_t PIOIDX     = 0;
static const uint32_t BITRATE   = 500000;
static const uint8_t PAD        = 0x55;

ACAN2040* can = nullptr;

#define RXBUF 64
static struct can2040_msg rxq[RXBUF];
volatile uint8_t rxHead = 0, rxTail = 0;

static void cb(struct can2040* cd, uint32_t notify, struct can2040_msg* msg) {
  (void)cd;
  if (notify & CAN2040_NOTIFY_RX) {
    uint8_t n = (rxHead + 1) % RXBUF;
    if (n != rxTail) { rxq[rxHead] = *msg; rxHead = n; }
  }
}
static bool popRx(struct can2040_msg* o) {
  if (rxTail == rxHead) return false;
  *o = rxq[rxTail]; rxTail = (rxTail + 1) % RXBUF; return true;
}

static void sendFrame(uint32_t id, const uint8_t* d, int n) {
  struct can2040_msg m; m.id = id; m.dlc = 8;
  for (int i = 0; i < 8; i++) m.data[i] = (i < n) ? d[i] : PAD;
  can->send_message(&m);
}

// Build the response payload (service byte + data) for a request. 0 = no answer.
static const char* VIN = "1FAKEECU000000123";   // 17 chars
static int buildResponse(const uint8_t* req, int reqLen, uint8_t* out) {
  if (reqLen < 1) return 0;
  uint8_t svc = req[0];
  if (svc == 0x01) {                              // OBD-II current data
    if (reqLen < 2) return 0;
    uint8_t pid = req[1];
    out[0] = 0x41; out[1] = pid;
    if (pid == 0x00) { out[2] = 0x08; out[3] = 0x18; out[4] = 0x80; out[5] = 0x00; return 6; } // supports 05,0C,0D,11
    if (pid == 0x0C) { out[2] = 0x0F; out[3] = 0xA0; return 4; }   // ~1000 rpm
    if (pid == 0x0D) { out[2] = 0x32; return 3; }                 // 50 km/h
    if (pid == 0x05) { out[2] = 0x5A; return 3; }                 // 50 degC
    if (pid == 0x11) { out[2] = 0x40; return 3; }                 // ~25% throttle
    out[2] = 0x00; return 3;
  }
  if (svc == 0x03) { uint8_t r[] = { 0x43, 0x04, 0x20, 0x01, 0x71 }; for (int i = 0; i < 5; i++) out[i] = r[i]; return 5; } // P0420,P0171
  if (svc == 0x09 && reqLen >= 2 && req[1] == 0x02) { out[0] = 0x49; out[1] = 0x02; out[2] = 0x01; for (int i = 0; i < 17; i++) out[3 + i] = VIN[i]; return 20; }
  if (svc == 0x04) { out[0] = 0x44; return 1; }
  if (svc == 0x3E) { out[0] = 0x7E; out[1] = 0x00; return 2; }     // UDS tester present
  if (svc == 0x10) { out[0] = 0x50; out[1] = (reqLen > 1 ? req[1] : 1); out[2] = 0; out[3] = 0x32; out[4] = 1; out[5] = 0xF4; return 6; }
  if (svc == 0x22 && reqLen >= 3 && req[1] == 0xF1 && req[2] == 0x90) { out[0] = 0x62; out[1] = 0xF1; out[2] = 0x90; for (int i = 0; i < 17; i++) out[3 + i] = VIN[i]; return 20; }
  if (svc == 0x19) { uint8_t r[] = { 0x59, 0x02, 0xFF, 0x04, 0x20, 0x00, 0x09 }; for (int i = 0; i < 7; i++) out[i] = r[i]; return 7; }
  if (svc == 0x14) { out[0] = 0x54; return 1; }
  return 0;
}

// Send an ISO-TP response on 0x7E8 (single- or multi-frame with flow control).
static void sendIsoTp(const uint8_t* data, int len) {
  if (len <= 7) {
    uint8_t f[8]; f[0] = len; for (int i = 0; i < len; i++) f[1 + i] = data[i];
    sendFrame(0x7E8, f, 1 + len);
    return;
  }
  uint8_t ff[8]; ff[0] = 0x10 | ((len >> 8) & 0x0F); ff[1] = len & 0xFF;
  for (int i = 0; i < 6; i++) ff[2 + i] = data[i];
  sendFrame(0x7E8, ff, 8);
  uint32_t deadline = millis() + 200; bool go = false;   // wait for flow control
  while ((long)(deadline - millis()) > 0) {
    struct can2040_msg m;
    if (popRx(&m)) { uint32_t id = m.id & 0x1FFFFFFF; if ((id == 0x7E0 || id == 0x7DF) && (m.data[0] & 0xF0) == 0x30) { go = true; break; } }
    else delay(1);
  }
  if (!go) return;
  int idx = 6; uint8_t sn = 1;
  while (idx < len) {
    uint8_t cf[8]; cf[0] = 0x20 | (sn & 0x0F); int k = 1;
    for (; k < 8 && idx < len; k++) cf[k] = data[idx++];
    sendFrame(0x7E8, cf, k);
    sn++; delay(2);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  can = new ACAN2040(PIOIDX, CAN_TX_PIN, CAN_RX_PIN, BITRATE, F_CPU, cb);
  can->begin();
  Serial.println("fake_ecu ready — answers 0x7DF/0x7E0 on 0x7E8 @ 500k, broadcasts 0x123");
}

// ---- liveness + serial test interface ----
uint32_t lastBcast = 0, lastBlink = 0, lastStatus = 0;
uint8_t ctr = 0;
uint32_t rxCount = 0, reqCount = 0, respCount = 0;
String inLine;

static void printStats() {
  char b[100];
  snprintf(b, sizeof(b), "fake_ecu alive @ %lus | canRx=%lu req=%lu resp=%lu",
           (unsigned long)(millis() / 1000), (unsigned long)rxCount,
           (unsigned long)reqCount, (unsigned long)respCount);
  Serial.println(b);
}

// Serial commands you can type into the monitor to verify the module.
static void handleSerial(String line) {
  line.trim(); line.toUpperCase();
  if (line == "PING") { Serial.println("OK fake_ecu alive"); return; }
  if (line == "STATS") { printStats(); return; }
  if (line == "TEST") {
    // Exercise the response builder with NO CAN needed — proves the logic works.
    struct { const char* name; uint8_t req[3]; int len; } t[] = {
      { "01 00 (supported PIDs)", { 0x01, 0x00, 0 }, 2 },
      { "01 0C (engine RPM)",     { 0x01, 0x0C, 0 }, 2 },
      { "03 (stored DTCs)",       { 0x03, 0, 0 },    1 },
      { "22 F190 (VIN)",          { 0x22, 0xF1, 0x90 }, 3 },
      { "19 02 (UDS DTCs)",       { 0x19, 0x02, 0xFF }, 3 },
    };
    for (unsigned i = 0; i < sizeof(t) / sizeof(t[0]); i++) {
      uint8_t out[40]; int n = buildResponse(t[i].req, t[i].len, out);
      String s = String("  ") + t[i].name + " -> ";
      if (n <= 0) s += "(no answer)";
      else for (int j = 0; j < n; j++) { char h[4]; snprintf(h, sizeof(h), "%02X ", out[j]); s += h; }
      Serial.println(s);
    }
    return;
  }
  Serial.println("cmds: PING | STATS | TEST");
}

void loop() {
  uint32_t now = millis();

  if (now - lastBlink > 100) { lastBlink = now; digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN)); }  // alive blink (always)
  if (now - lastStatus > 2000) { lastStatus = now; printStats(); }                                       // periodic status line
  // Broadcast a heartbeat frame on 0x123 so a passive monitor can see we're a
  // live module. NOTE: a transmit needs another node to ACK it — so keep the
  // READER powered (its CAN ACKs us). If we run totally ALONE for a few seconds
  // the controller will bus-off (harmless; serial TEST/STATS still work) — just
  // power-cycle this Pico with the reader already powered.
  if (now - lastBcast > 100) {
    lastBcast = now;
    uint8_t b[8] = { 0xDE, 0xAD, 0xBE, 0xEF, ctr++, 0, 0, 0 };
    sendFrame(0x123, b, 8);
  }

  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') { handleSerial(inLine); inLine = ""; }
    else if (c >= 0x20 && inLine.length() < 60) inLine += c;
  }

  struct can2040_msg m;
  if (popRx(&m)) {
    rxCount++;
    uint32_t id = m.id & 0x1FFFFFFF;
    if (id == 0x7DF || id == 0x7E0) {
      if ((m.data[0] & 0xF0) == 0x00) {            // single-frame request
        reqCount++;
        int rl = m.data[0] & 0x0F;
        uint8_t resp[40];
        int n = buildResponse(&m.data[1], rl, resp);
        if (n > 0) { sendIsoTp(resp, n); respCount++; }
      }
    }
  }
}
