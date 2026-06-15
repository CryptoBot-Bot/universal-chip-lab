# PicoForge — Universal Serial-Memory Programmer

A Raspberry Pi Pico that reads & writes **SPI (25/95/W25Q)**, **I²C (24Cxx)** and
**Microwire (93Cxx)** memory chips at a safe **3.3 V**, with an OLED status
screen, a mode button, and a tiny USB serial protocol so the **Universal Chip
Lab** app can drive it. Built to be the safe, app-integrated answer to the
CH341A's two limits (it's 5 V, and flashrom is blind to serial EEPROMs).

> ⚠️ Native 3.3 V. For 5 V-only parts (e.g. 93Cxx *writes* need ≥4.5 V), put the
> 4-channel level converters on the data lines and power the chip at 5 V.

---

## Run it in Wokwi (simulator)
1. New project → **Raspberry Pi Pico → MicroPython**.
2. Create these files and paste the matching contents:
   - `diagram.json`
   - `main.py`
   - `memchips.py`
   - `ssd1306.py`
3. Press **Run**. You should see:
   - the **OLED** showing `PicoForge / SPI Flash / 3V3 safe / ready`,
   - the green **LED** flashing on activity, the onboard LED as a heartbeat,
   - press the **button** → the mode cycles (SPI Flash → SPI EEPROM → I²C → Microwire),
   - in the **Serial Monitor**, type `PING` ↵ → `OK PicoForge v1.0`, then `HELP`.

*(The microSD part is a stand-in for an SPI chip — same pins. Real reads/writes
happen on the physical Pico wired to a real chip.)*

---

## Pin map (firmware ↔ Pico GPIO)
| Function | Pico |
|---|---|
| OLED I²C (SDA / SCL) | GP8 / GP9 |
| SPI bus (SCK / MOSI / MISO / CS) | GP18 / GP19 / GP16 / GP17 |
| I²C bus for 24Cxx (SDA / SCL) | GP26 / GP27 |
| Microwire (CS / SK / DI / DO) | GP10 / GP11 / GP12 / GP13 |
| Mode LEDs (SPI-Flash/SPI-EE/I²C/MW) | GP2 / GP3 / GP4 / GP5 (each → 330 Ω → LED → GND) |
| Activity LED | GP20 → 330 Ω → LED → GND |
| Power LED | 3V3 → 330 Ω → LED → GND (always on) |
| MODE button | GP22 → GND |
| ACTION button (quick read) | GP21 → GND |
| Buzzer | GP15 → buzzer → GND |

## Wiring the real chips (8-pin SOIC, via your clip)

**SPI — W25Q / 25xx / M95xx**
| Chip pin | → |
|---|---|
| 1 CS | GP17 |
| 2 DO | GP16 (MISO) |
| 3 WP | **3V3** (tie high) |
| 4 GND | GND |
| 5 DI | GP19 (MOSI) |
| 6 CLK | GP18 |
| 7 HOLD | **3V3** (tie high) |
| 8 VCC | 3V3 |

**I²C — 24Cxx**: SDA→GP26, SCL→GP27, VCC→3V3, GND→GND, A0/A1/A2→GND, WP→GND.
Add 4.7 kΩ pull-ups on SDA & SCL to 3V3.

**Microwire — 93Cxx**: CS→GP10, SK(CLK)→GP11, DI→GP12, DO→GP13, GND→GND,
VCC→3V3 (use 5 V + level shifters for writes), ORG→3V3 (x16) or GND (x8).

## Serial protocol (USB CDC, one command per line)
```
PING                -> OK PicoForge v1.5
HELP                -> command list
INFO                -> current mode + SPI clock
MODE <0..3>         -> 0 SPI Flash | 1 SPI EEPROM | 2 I2C EEPROM | 3 Microwire
SPEED [<hz>]        -> get/set the SPI clock in Hz (e.g. SPEED 1000000)
ID                  -> JEDEC id (SPI modes)
READ  <start> <len> -> OK <hex bytes>
WRITE <start> <hex> -> OK wrote N
```

### SPI clock (`SPEED`) — fixing all-`00` reads
The SPI clock is the SCK frequency the Pico drives the bus at. It is a pure
throughput knob: SPI has **no minimum**, so slowing down is always safe for a
read — the only cost is time. The *maximum* is per-chip (the datasheet's
output-valid time `tV`) and derates with supply voltage and long jumper leads.

If a chip reads back a wall of `0x00`, the Pico is clocking faster than the chip
can drive its SO/MISO line, so it samples the idle-low line before valid data
arrives. (A genuinely blank chip reads `0xFF`, never `0x00` — so all-`00` means
"nobody is driving the line", not "empty".) The fix is to slow down:
`SPEED 1000000` (1 MHz). Default is 2 MHz; the firmware clamps to 10 kHz…62.5 MHz
(the RP2040 PL022 ceiling). `SPEED` affects SPI modes (0/1) only — I²C and
Microwire have their own fixed clocks. The app exposes this as the **SPI clock**
control in the Read/Write tabs and Settings, with each chip's datasheet-rated
clock stored in the chip database (`readAlgorithm.maxClockHz`).
This is the bridge for a future `PicoAdapter` in the Universal Chip Lab app:
the app opens the Pico's COM port and sends these lines.

## Bill of materials (buy anything you're missing)
- Raspberry Pi Pico (or Pico W) ×1
- SSD1306 128×64 I²C OLED ×1
- Momentary push buttons ×2 (MODE + ACTION)
- LEDs ×6 (4 mode + activity + power) + 6× 330 Ω resistors
- Passive buzzer ×1 (GP15)
- 2× 4.7 kΩ resistors (I²C pull-ups)
- 4-channel logic level converters (you have these) for 5 V parts
- SOIC-8 test clip / sockets (you have these)
- Perfboard or a small custom PCB + your solder station

## Status / roadmap
- v1.0: UI + serial protocol + SPI/I²C drivers; Microwire read (calibrate per chip).
- next: Microwire write, W25Q sector-erase, and the app-side `PicoAdapter`.
