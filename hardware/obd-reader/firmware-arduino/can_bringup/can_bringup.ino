// can_bringup.ino — two-node CAN test, verbose per-attempt diagnostics.
// =============================================================================
// Flash to TWO Picos (NODE_ID 1 and 2). Each transmits slowly and prints, per
// attempt, whether the driver accepted it — and once a second prints can2040's
// counters WITH per-second deltas, so the failure mode is unmistakable.
//
//   ok_to_send=0  -> the TX queue is JAMMED (a frame is stuck, never ACKed/sent)
//   send=0        -> can2040 refused the frame (queue full)
//   err climbing  -> transmitted dominant bits aren't read back on the bus
//                    = the TRANSCEIVER isn't driving (RS/slope or dead driver)
//   rx delta >0   -> we're actually hearing the other node (the goal)
//   tx delta >0   -> our frames are completing (ACKed) (the goal)
//
// To test the transceiver-slew theory, set BITRATE = 125000 on BOTH nodes.
//
// Board: Raspberry Pi Pico (Arduino-Pico).  Library: ACAN2040.
// Wiring: SN65HVD230  D <- GP5 (TX),  R -> GP4 (RX).  RS must be GND (high-speed)!
// =============================================================================
#include <ACAN2040.h>

#define NODE_ID 1                          // <-- 1 on one Pico, 2 on the other
static const uint32_t BITRATE = 500000;    // match the car/fake_ecu bus; drop to 125000 if marginal

// These are GPIO (GP) numbers, NOT physical pin numbers!
//   GP5 = physical pin 7   (wire the transceiver CTX here)
//   GP4 = physical pin 6   (wire the transceiver CRX here)
static const uint8_t CAN_TX_PIN = 5;        // GP5  -> CTX (physical pin 7)
static const uint8_t CAN_RX_PIN = 4;        // GP4  -> CRX (physical pin 6)
static const uint8_t PIOIDX     = 0;
static const uint8_t PAD        = 0x55;

ACAN2040* can = nullptr;
volatile uint32_t rxCount = 0, lastId = 0;
volatile uint8_t lastByte = 0;

static void cb(struct can2040* cd, uint32_t notify, struct can2040_msg* msg) {
  (void)cd;
  if (notify & CAN2040_NOTIFY_RX) { rxCount++; lastId = msg->id & 0x1FFFFFFF; lastByte = msg->data[1]; }
}

static bool sendFrame(uint32_t id, const uint8_t* d, int n) {
  struct can2040_msg m; m.id = id; m.dlc = 8;
  for (int i = 0; i < 8; i++) m.data[i] = (i < n) ? d[i] : PAD;
  return can->send_message(&m);
}

uint32_t pRx = 0, pTx = 0, pAtt = 0, pErr = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  can = new ACAN2040(PIOIDX, CAN_TX_PIN, CAN_RX_PIN, BITRATE, F_CPU, cb);
  can->begin();
  char b[80];
  snprintf(b, sizeof(b), "can_bringup node %d @ %lu bps — verbose", NODE_ID, (unsigned long)BITRATE);
  Serial.println(b);
}

uint32_t lastTx = 0, lastStat = 0;
uint8_t ctr = 0;

void loop() {
  uint32_t now = millis();

  if (now - lastTx > 500) {                 // slow, observable transmit
    lastTx = now;
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
    bool okts = can->ok_to_send();
    uint8_t b[8] = { (uint8_t)NODE_ID, ctr++, 0, 0, 0, 0, 0, 0 };
    bool sent = sendFrame(0x100 + NODE_ID, b, 8);
    char l[90];
    snprintf(l, sizeof(l), "node %d TX  ok_to_send=%d  send_message=%d", NODE_ID, okts ? 1 : 0, sent ? 1 : 0);
    Serial.println(l);
  }

  if (now - lastStat > 1000) {
    lastStat = now;
    struct can2040_stats st = { 0, 0, 0, 0 };
    can->get_statistics(&st);
    char l[170];
    snprintf(l, sizeof(l),
             "node %d STAT rx=%lu(+%lu) tx=%lu(+%lu) txAtt=%lu(+%lu) err=%lu(+%lu) heard=0x%lX",
             NODE_ID,
             (unsigned long)st.rx_total, (unsigned long)(st.rx_total - pRx),
             (unsigned long)st.tx_total, (unsigned long)(st.tx_total - pTx),
             (unsigned long)st.tx_attempt, (unsigned long)(st.tx_attempt - pAtt),
             (unsigned long)st.parse_error, (unsigned long)(st.parse_error - pErr),
             (unsigned long)lastId);
    Serial.println(l);
    pRx = st.rx_total; pTx = st.tx_total; pAtt = st.tx_attempt; pErr = st.parse_error;
  }
}
