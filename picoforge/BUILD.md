# PicoForge v1 — Final Build Spec

The physical device: a Pico-based **universal memory programmer** with an OLED,
a mode button, status LEDs, and a **labeled target field** you clip any chip
onto. Native 3.3 V (safe), 5 V available through the level converters for
93Cxx writes. Speaks USB serial to the Universal Chip Lab app.

Build philosophy: **breadboard first, prove every chip family, THEN solder.**
After the 95080, we don't power anything we haven't verified.

---

## 1. Bill of materials
| # | Part | Notes |
|---|---|---|
| 1 | Raspberry Pi Pico (or Pico W) | The brain. Solder on female headers so it's removable. |
| 1 | SSD1306 128×64 I²C OLED | Status screen (addr 0x3C). |
| 2 | Momentary push buttons | MODE cycle + ACTION (quick read). |
| 6 | LED + 330 Ω resistor | 4 mode LEDs + activity + power. |
| 1 | Passive buzzer | Beeps on mode change / read (GP15). |
| 2 | 4.7 kΩ resistor | I²C pull-ups (SDA/SCL). |
| 1–2 | 4-channel level converter (you have 10) | 5 V path for 93Cxx writes. |
| 1 | SOIC-8 test clip **and/or** SOIC-8 ZIF socket | Your chip interface. |
| 1 | Half-size perfboard / protoboard | The base. |
| — | Male & female pin headers | Pico sockets + the target field. |
| — | Hookup wire, solder, flux | Your station. |
| 1 | Project box / 3D-printed shell *(optional)* | Makes it a "product." |
| 1 | Short USB cable (Pico ↔ PC) | Data, not charge-only. |

Buy anything you're missing — none of it is exotic.

---

## 2. Block diagram
```
                 ┌───────────────────────────────┐
   USB ─────────►│  Raspberry Pi Pico (3.3 V)     │
   (to PC)       │                               │
                 │  GP8/GP9  ──► OLED (I²C0)       │
                 │  GP22     ──► MODE button       │
                 │  GP20     ──► activity LED      │
                 │                               │
                 │  GP16-19  ──► SPI  field       │
                 │  GP26/27  ──► I²C  field        │──► TARGET FIELD
                 │  GP10-13  ──► Microwire field   │    (labeled headers
                 │  3V3 / VBUS(5V) / GND ──►        │     → your clip/socket)
                 └───────────────────────────────┘
```

## 3. Exact wiring (matches the firmware pin map)
**On-board UI**
| From Pico | To |
|---|---|
| GP8 / GP9 | OLED SDA / SCL |
| 3V3 / GND | OLED VCC / GND |
| GP2 / GP3 / GP4 / GP5 | mode LEDs (SPI-Flash / SPI-EE / I²C / MW), each → 330 Ω → LED → GND |
| GP20 → 330 Ω → LED → GND | activity LED |
| 3V3 → 330 Ω → LED → GND | power LED (always on) |
| GP22 | MODE button → other leg to GND |
| GP21 | ACTION button (quick read) → other leg to GND |
| GP15 | buzzer → other leg to GND |

**Target field** — bring these to a labeled header block (this is what your
chip clips to):
| Label | Pico | Used by |
|---|---|---|
| CS | GP17 | SPI |
| CLK | GP18 | SPI |
| MOSI/DI | GP19 | SPI |
| MISO/DO | GP16 | SPI |
| SDA | GP26 | I²C |
| SCL | GP27 | I²C |
| MW_CS | GP10 | Microwire |
| MW_SK | GP11 | Microwire |
| MW_DI | GP12 | Microwire |
| MW_DO | GP13 | Microwire |
| 3V3 | 3V3 | power (default) |
| 5V | VBUS | power (93C writes, via level shifter) |
| GND ×2 | GND | ground |

Per-chip pin→label mapping is in `README.md` (SPI / I²C / Microwire tables).
Print those tables and tape them to the lid as your legend cards.

## 4. Build order (breadboard → solder)
1. **Breadboard the UI first**: Pico + OLED + button + LED. Flash the firmware
   (Section 6), confirm the OLED, button-cycle, and `PING` work. *No chips yet.*
2. **Prove one chip family at a time** on the breadboard, lowest-risk first:
   - **24Cxx (I²C)** — easy, 3.3 V, can't reverse-cook easily. `MODE 2`, `READ 0 16`.
   - **W25Q32 (SPI)** — `MODE 0`, `ID` should return a JEDEC id like `EF 40 16`.
   - **93Cxx (Microwire)** — `MODE 3`; we calibrate addr width together.
   - **M95 (SPI EEPROM)** — `MODE 1` (the family the CH341A couldn't do).
3. Only once each family reads on the breadboard → **transfer to perfboard** and
   solder, keeping the exact same wiring.
4. (Optional) drop it in an enclosure with the OLED + button on top, USB on the side.

## 5. ⚠️ Safety (the rules that save chips)
- **3V3 is the default.** Only use the 5 V rail through the level converters, and
  only for 93Cxx *writes*.
- **Before powering any chip, verify with a multimeter** that the chip's VCC pin
  reads 3.3 V and its GND pin reads 0 V — *never* assume orientation. This is the
  exact check that would have saved the 95080.
- Tie **WP** and **HOLD** to 3V3 on SPI parts; set **ORG** on 93Cxx.
- Read every original **twice** and SHA-compare before trusting it.

## 6. Connect it to the PC for real (next milestone)
1. **Flash MicroPython** to the real Pico: hold **BOOTSEL**, plug in USB → it
   mounts as `RPI-RP2`; drag the **MicroPython UF2** for Pico onto it.
2. Copy our files onto the Pico (via **Thonny**): `main.py`, `memchips.py`,
   `ssd1306.py`. It auto-runs `main.py` on power-up.
3. Find its **COM port** (Device Manager → Ports).
4. Open that port in a serial monitor (Thonny shell, or PuTTY at any baud) and
   type `PING` → `OK PicoForge v1.0`. You're talking to your machine.
5. Then we wire a **`PicoAdapter`** into the Universal Chip Lab app so the app
   drives it (the `READ/WRITE/ID` protocol is already there).

That's the bridge: your hardware, your firmware, your app — one loop.
