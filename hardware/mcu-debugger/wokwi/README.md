# Wokwi project — MCU Debugger / Internal-Memory Reader (Layer 3)

Visualize the solder-up of the level-shifted debug interface board. Full build,
connector pinouts, and target table in `../BUILD.md`.

## Files
| File | Role |
| --- | --- |
| `diagram.json` | Board layout + every wire |
| `main.py` | Placeholder (the real probe runs `debugprobe` firmware — see notes) |
| `wokwi.toml` | VS Code / CLI manifest |
| `shifter4.chip.{c,json}` | 4-ch level shifter (used twice = 8 lines) |
| `debugport.chip.{c,json}` | Target connectors (SWD/JTAG/BDM/BSL fan-out) |

## Load on wokwi.com
1. **New Project → Raspberry Pi Pico — MicroPython.**
2. Paste `main.py` and `diagram.json`.
3. Add custom chips with **`+`**: `shifter4.chip.c/.json`, `debugport.chip.c/.json`.
4. ▶ Play — the LED blinks and the serial monitor prints the pin map. The board
   itself does its real work via the debug firmware + OpenOCD, not in sim.

## Simulates vs. picture
- **Picture only.** This board is wiring + level shifting + connectors; there is
  no target MCU to talk to in Wokwi. The diagram exists so you solder the right
  pins and, above all, get the **VTref-referenced level shifting** right.
