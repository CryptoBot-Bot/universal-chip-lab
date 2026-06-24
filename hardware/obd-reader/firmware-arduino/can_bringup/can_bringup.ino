// can_bringup.ino — two-node can2040 bring-up test for the OBD reader hardware.
// =============================================================================
// Proves the real-CAN path BEFORE we port the full firmware: can2040 (PIO CAN),
// the ACAN2040 library, your SN65HVD230 wiring, and bus termination. Flash this
// to TWO Picos (NODE_ID 1 and 2), wire their transceivers together with 120 ohm
// at each end, and watch each node's rx counter climb — that's them hearing each
// other over a real CAN bus.
//
// Board: Raspberry Pi Pico (Arduino-Pico core).  Library: ACAN2040.
// Wiring (BUILD.md): SN65HVD230  D/CTX <- GP5 (TX),  R/CRX -> GP4 (RX).
// =============================================================================
#include <ACAN2040.h>

// ---- set this PER BOARD before flashing: 1 on the first Pico, 2 on the second
#define NODE_ID 1

static const uint32_t CAN_TX_PIN  = 5;        // -> transceiver D / CTX
static const uint32_t CAN_RX_PIN  = 4;        // <- transceiver R / CRX
static const uint32_t CAN_BITRATE = 500000;   // OBD-II high-speed CAN
static const uint32_t CAN_PIO     = 0;        // which PIO block can2040 uses

ACAN2040 *can;

// RX happens in a callback (can2040 calls this from its IRQ). Keep it tiny:
// just record what we got; the loop() prints it.
volatile uint32_t rxCount    = 0;
volatile uint32_t lastRxId   = 0;
volatile uint8_t  lastRxNode = 0;
volatile uint8_t  lastRxCnt  = 0;

static void onCanRx(const struct can2040_msg *msg) {
  rxCount++;
  lastRxId   = msg->id;
  lastRxNode = msg->data[0];
  lastRxCnt  = msg->data[1];
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);

  // (pioIndex, txPin, rxPin, bitRate, CPU frequency, rx callback)
  can = new ACAN2040(CAN_PIO, CAN_TX_PIN, CAN_RX_PIN, CAN_BITRATE, F_CPU, onCanRx);
  can->begin();

  Serial.print("can_bringup node ");
  Serial.print(NODE_ID);
  Serial.println(" — CAN up on GP5(TX)/GP4(RX) @ 500k. Waiting for the other node…");
}

uint32_t lastTx = 0;
uint8_t  counter = 0;

void loop() {
  uint32_t now = millis();
  if (now - lastTx >= 500) {
    lastTx = now;
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));

    struct can2040_msg msg;
    msg.id  = 0x100 + NODE_ID;   // standard 11-bit id, unique per node
    msg.dlc = 2;
    msg.data[0] = NODE_ID;
    msg.data[1] = counter++;
    bool queued = can->tryToSend(&msg);

    char line[128];
    snprintf(line, sizeof(line),
             "node %u tx id=0x%03lX cnt=%u %s | rx=%lu lastId=0x%03lX fromNode=%u theirCnt=%u",
             (unsigned)NODE_ID, (unsigned long)msg.id, (unsigned)msg.data[1],
             queued ? "queued" : "BUSY",
             (unsigned long)rxCount, (unsigned long)lastRxId,
             (unsigned)lastRxNode, (unsigned)lastRxCnt);
    Serial.println(line);
  }
}
