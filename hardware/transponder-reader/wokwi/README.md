# Wokwi project — 125 kHz Transponder Reader (Layer 2)

Visualize the solder-up of the EM4095 LF RFID front-end. Full build + safety in
`../BUILD.md`.

## Files
| File | Role |
| --- | --- |
| `diagram.json` | Board layout + every wire |
| `main.py` | Pico firmware — enable field, sample DEMOD/RDYCLK |
| `wokwi.toml` | VS Code / CLI manifest |
| `em4095.chip.{c,json}` | 125 kHz RFID front-end IC |
| `antenna.chip.{c,json}` | LC tank (coil + Cres + Rser) |
| `shifter4.chip.{c,json}` | 4-ch level shifter (5 V EM4095 ↔ 3.3 V Pico) |

## Load on wokwi.com
1. **New Project → Raspberry Pi Pico — MicroPython.**
2. Paste `main.py` and `diagram.json`.
3. Add each custom chip with the **`+`** button: `em4095.chip.c/.json`,
   `antenna.chip.c/.json`, `shifter4.chip.c/.json`.
4. ▶ Play. The diagram is the wiring picture; RF is not simulated (the serial
   monitor prints `no tag in field`).

## Simulates vs. picture
- **Picture only:** all the RF (EM4095, antenna, tag coupling) — Wokwi has no RF
  engine. The diagram exists so you solder the right pins, especially the level
  shifter on the 5 V logic lines.
