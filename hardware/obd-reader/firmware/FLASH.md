# Flashing the OBD-Reader firmware onto the Pico

This puts `main.py` (command/reply telemetry firmware) on the Raspberry Pi Pico so
the **Universal Chip Lab** desktop app can see it on the **OBD Reader** tab.

> ⚠️ **Bench only for now.** Flash and test the Pico over **USB at your desk** —
> the car's 12 V never touches the Pico until you've confirmed **5.1 V at VSYS**
> (see `../BUILD.md` → "set the LM2596 to 5.1 V *before* connecting the Pico").

## 1. Put MicroPython on the Pico (once)
If the Pico already runs MicroPython (it does if you've used PicoForge), skip this.
1. Hold **BOOTSEL**, plug the Pico into USB → it mounts as a drive `RPI-RP2`.
2. Drag the MicroPython `.uf2` ([micropython.org/download/RPI_PICO](https://micropython.org/download/RPI_PICO/))
   onto that drive. It reboots running MicroPython.

## 2. Copy `main.py` to the Pico
Use **Thonny** (easiest) or `mpremote`:

**Thonny:** open `main.py` → *File ▸ Save as… ▸ Raspberry Pi Pico* → name it
**`main.py`** (so it runs on boot). Close Thonny afterwards — it holds the COM port
and the app can't open it while Thonny is connected.

**mpremote:**
```sh
pip install mpremote        # once
mpremote connect auto fs cp main.py :main.py
mpremote connect auto reset
```

## 3. Sanity-check in a serial monitor (optional)
Open the port at **115200** (Thonny shell, or any monitor) and type:
```
PING        -> OK OBD-Reader v1
BATT        -> OK <ms>,<volts>,OK,<vmin>,<vmax>
```
With nothing on GP28 the volts read near 0 — that's fine; it'll read real voltage
once the divider sees the protected 12 V rail.

## 4. See it in the app
1. **Close Thonny / any serial monitor** (frees the COM port).
2. Launch the desktop app → **OBD Reader** tab → **Connect**.
3. It auto-detects the Pico, verifies it's running this firmware (`PING`), and starts
   polling **BATT** live.

## Try it with no car (bench simulator)
The firmware has a built-in simulator so you can polish the app end-to-end without
a vehicle. In the app's **OBD Reader** tab, the **Bench simulator** card has scenario
buttons — pick **Engine start → drive** and watch the voltage animate through the
key-on → crank dip → alternator climb, and the CAN panel fill with decoded
**RPM / speed / coolant**. Everything shown while a scenario is active is FAKE and
the UI flags it **⚠ SIMULATION**; hit **Off (live)** before reading a real car.

In the app this drives the whole scan-tool UI in sim: **Scan vehicle** (live data
— discovers supported PIDs and polls them), **Read codes** (DTCs + VIN), and the
battery gauge, all from fake-but-realistic data.

By hand in a serial monitor it's the `SIM` + `OBD` commands:
```
SIM DRIVE     -> OK sim=DRIVE (SIMULATION - not a real car)
BATT          -> OK <ms>,12.93,CHARGING,...   (synthesized, climbing)
OBD 01 00     -> OK 00181a8003                 (supported-PID bitmask)
OBD 01 0C     -> OK 0c...                       (live RPM; 0D=speed, 05=coolant…)
OBD 03        -> OK 03010420                    (stored DTCs P0301, P0420)
OBD 09 02     -> OK 0201<vin ascii>             (VIN)
OBD 04        -> OK                              (clear codes — writes to the car)
SIM OFF       -> OK sim off                      (back to live ADC; OBD then needs can2040)
```
Scenarios: `OFF | IGNITION | WEAK | IDLE | DRIVE`. `OBD <mode> [pid]` is hex.

## 5. Bench-calibrate the voltage (do once)
Feed the protected 12 V input a known voltage (bench supply, e.g. 12.00 V) and
compare the app's reading to your multimeter. If they differ, nudge the divider
ratio: send `CAL 5.74` (or whatever matches) — the default is `5.7`. The app's
**Calibrate** field does this for you and the firmware echoes the new ratio.

## CAN frames
`CANINIT` / `CANDUMP` are wired but return an honest error on stock MicroPython —
the RP2040 has no hardware CAN, so live frame decode needs a **can2040** build
(C/Arduino with Kevin O'Connor's `can2040`, or a custom MicroPython with the
driver). Battery telemetry — what actually verifies your bench and the 12→14 V
engine-start climb — works today without it.
