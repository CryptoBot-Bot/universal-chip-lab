# OBD Reader — Arduino / can2040 firmware

This is the **real-CAN** firmware track for the OBD reader. The RP2040 has no
hardware CAN, so we use **can2040** (a software CAN controller running on the
Pico's PIO) through the **Arduino-Pico** core, which bundles it. The firmware
keeps the **exact same USB serial protocol** as the MicroPython build
(`PING` / `BATT` / `OBD <mode> <pid>` / `CANDUMP` / `SIM …`), so the desktop app
works against it unchanged — only the CAN layer underneath becomes real.

> ⚠️ Flashing an Arduino sketch **replaces MicroPython** on that Pico. That's
> expected — this Arduino firmware *becomes* the reader firmware. The app talks
> the same protocol either way.

## Hardware — nothing to resolder
The CAN wiring you already built is exactly what can2040 uses:

| Pico | SN65HVD230 | OBD |
| --- | --- | --- |
| **GP5** (TX) | D / CTX | — |
| **GP4** (RX) | R / CRX | — |
| 3V3 | 3V3 | — |
| GND | GND | — |
| — | CANH | pin 6 |
| — | CANL | pin 14 |

## Step 1 — Install the toolchain (once)
1. Install the **Arduino IDE** (2.x).
2. **File ▸ Preferences ▸ Additional boards manager URLs**, add:
   `https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json`
3. **Tools ▸ Board ▸ Boards Manager**, search **"pico"**, install
   **"Raspberry Pi Pico/RP2040/RP2350" by Earle F. Philhower**.
4. **Tools ▸ Board** → select **Raspberry Pi Pico**.
5. **Sketch ▸ Include Library ▸ Manage Libraries**, search **"ACAN2040"**
   (Pierre Molinaro's Arduino wrapper around can2040), install it.

## Step 2 — Build the test partner (no soldering)
You need two CAN nodes to prove the bus. Use your **spare Pico + a transceiver
on a breadboard** as node 2 (the reader is node 1). Wire each Pico's GP5→D,
GP4→R, 3V3→3V3, GND→GND, then join the two boards:

```
   Node 1 (reader)            Node 2 (spare on breadboard)
   transceiver CANH ──────────── CANH transceiver
   transceiver CANL ──────────── CANL transceiver
        [120 Ω] across CANH–CANL at EACH end   ← bench bus needs termination
        GND ───────────────────── GND          ← common ground
```
> **Termination:** a 2-node bench bus needs **120 Ω at each end** — use the two
> modules whose on-board 120 Ω you kept (or add a resistor). A real car needs
> **none** (it's already terminated). This is the one rule that flips between
> bench and car.

## Step 3 — Flash the bring-up test to both Picos
Open `can_bringup/can_bringup.ino`.

1. Set `NODE_ID` to **1**, select the first Pico's port, **Upload**.
   *(First Arduino upload over MicroPython: if it won't upload, hold **BOOTSEL**
   while plugging in, then upload once — after that it auto-resets.)*
2. Change `NODE_ID` to **2**, select the second Pico's port, **Upload**.
3. Open a **Serial Monitor** (115200) on each. You should see each node's `rx`
   counter **climbing** — that means they're hearing each other over real CAN. 🎉

**If `rx` stays 0:** check termination (120 Ω each end), common ground, CANH↔CANH /
CANL↔CANL not swapped, and — if still nothing — try swapping `CAN_TX_PIN` /
`CAN_RX_PIN` (confirm the constructor order against the ACAN2040 examples for your
installed version). A single node alone can't transmit (CAN needs another node to
ACK), so both must be running.

## `obd_reader/` — the full firmware (real CAN, proven on a bench TCM)
This is what you flash to the reader Pico. It speaks the same USB serial protocol
as before, now backed by real can2040, and adds a multi-module diagnostic layer:

| Command | Purpose |
| --- | --- |
| `PING` / `INFO` / `BATT` / `CAL <r>` / `RESET` | identity, telemetry, persistent calibration |
| `CANDUMP` | drain received frames (passive monitor) |
| `OBD <mode> [pid]` | OBD-II request to the functional address (0x7DF) |
| **`ISOTP <txidHex> <hexPayload>`** | raw ISO-TP request to ANY address — the primitive behind UDS |
| **`PROBE`** | list every module that answers (CAN response ids) |
| `SIM <OFF\|IGNITION\|WEAK\|IDLE\|DRIVE>` | bench simulator (incl. fake modules + UDS) |

Calibration persists in flash (`EEPROM`), so it follows the device to any PC.

The desktop app's **OBD Reader** tab drives all of this: battery + calibration,
**Full vehicle scan** (discover every module → read each one's DTCs + VIN over
OBD-II/UDS), live data, per-module clear, and a passive **Bus monitor** with log
export. Re-Upload this sketch whenever the firmware changes (auto-reset, no BOOTSEL).
