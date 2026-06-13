# Wokwi project — OBD-II CAN Reader

Visualize the full solder-up of the OBD-II CAN reader (see `../BUILD.md` for the
real-hardware build & safety notes).

## Files in this project

| File | Role |
| --- | --- |
| `diagram.json` | The board layout + every wire (this is the picture you want) |
| `main.py` | Pico firmware (MicroPython) — battery-voltage read over USB serial |
| `wokwi.toml` | Manifest for the VS Code / CLI Wokwi extension |
| `obd2.chip.{c,json}` | OBD-II J1962 plug (7 pins) — drives 12.6 V onto pin 16 so the ADC reads real |
| `carprotect.chip.{c,json}` | Fuse + Schottky + TVS block — drives the protected 12.2 V rail |
| `lm2596.chip.{c,json}` | Buck module — drives the regulated 5.1 V rail |
| `sn65hvd230.chip.{c,json}` | 3.3 V CAN transceiver (used twice: HS-CAN + MS-CAN) |
| `kline.chip.{c,json}` | K-line front-end (L9637D + pull-up + diode + level shifter) |

Buses on the board: **HS-CAN** (GP4/5 → OBD 6/14), **MS-CAN** (GP6/7 → OBD 3/11),
**K-line** (GP8/9 → OBD 7). Only the power/battery path runs live in sim; the
buses are wiring references (see the notes in `main.py` and `../BUILD.md`).

Every voltage above is an editable part attr in `diagram.json` (`battery_voltage`
on the OBD plug, `vout` on the protection block and buck), so you can drop Wokwi
voltage probes on the 12 V → 12.2 V → 5.1 V → GP28 chain and watch it.

## Load it on wokwi.com (easiest — no toml needed)

1. Go to **wokwi.com** → **New Project** → **Raspberry Pi Pico — MicroPython**.
2. Replace the editor's `main.py` with this folder's `main.py`.
3. Click the **`diagram.json`** tab and paste this folder's `diagram.json`.
4. For each custom chip, hit the **`+`** (new file) and create both files with the
   exact names: `obd2.chip.c`, `obd2.chip.json`, `carprotect.chip.c`,
   `carprotect.chip.json`, `lm2596.chip.c`, `lm2596.chip.json`,
   `sn65hvd230.chip.c`, `sn65hvd230.chip.json`, `kline.chip.c`, `kline.chip.json`
   — paste each from this folder.
5. Press **▶ Play**. You'll see the wiring laid out and the serial monitor stream
   `ms,battery_v,state,vmin,vmax` lines — e.g. `912,12.60,OK,12.60,12.60`.

To fake the engine running, open `diagram.json`, find the `chip-obd2` part and
change `"battery_voltage": "12.6"` to `"14.4"` — the reading climbs.

## Load it in VS Code (Wokwi extension)

The `wokwi.toml` here is already wired up. The custom `.chip.c` files must be
compiled to `.wasm` first (the web editor does this for you; locally use the
[wokwi-chips-api](https://github.com/wokwi/wokwi-chips-api) build). Then
**Wokwi: Start Simulator**.

## What simulates vs. what's just for the picture

- **Simulates:** the full power chain — OBD 12.6 V → protected 12.2 V → buck
  5.1 V → VSYS, and the R1/R2 divider → live voltage on GP28 that `main.py` reads
  and prints.
- **Visual only:** the CAN transceiver is a passive placeholder. CAN has no live
  bus in sim (the RP2040 has no hardware CAN; real builds run it over PIO — see
  the CAN section at the bottom of `main.py`). The CAN wiring is still drawn so
  you solder the right pins, which is the whole point here.
