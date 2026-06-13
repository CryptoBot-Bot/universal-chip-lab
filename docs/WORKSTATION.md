# Universal Chip Lab — Bench Workstation v1

> **Permanent reference.** Edit this doc when the bench changes — never trust your memory of "which jumper goes where."

---

## 1. Purpose

A documented, ESD-safe bench that any session can use to:

1. **Bring up power safely** — bench PSU → distribution strip → DUT, one knob, one switch.
2. **Connect ANY programmer to ANY chip type** through a single standardised DUT interface (no rewiring per chip).
3. **Voltage-shift safely** between 5 V programmer logic and 3.3 V chip logic — always on, never an afterthought.
4. **Hot-swap chips** without touching upstream wiring.
5. **Tap the logic analyzer** on any DUT signal without re-wiring.
6. **Maintain ESD safety** throughout...

The design philosophy is **standardised pinouts + hot-swappable modules**, not "wire it from scratch every time."

---

## 2. Bench Topology

```
            ┌───────────────── LAPTOP (USB-hub or direct) ─────────────────┐
            │                                                              │
       [CH341A]   [FT232H]   [Bus Pirate]   [T48]   [Pi Pico]              │
            │        │           │           │         │                   │
            └────────┴─────┬─────┴───────────┴─────────┘                   │
                           │                                               │
                       Programmer-side jumpers                             │
                       (5 V HV  or  3.3 V LV  depending on chip)           │
                           ▼                                               │
                ┌──────────────────────────────────┐                       │
                │   MODULE E — LEVEL SHIFTER       │   ← AITIAO BSS138     │
                │   HV ref ← 5 V rail              │     always-on,        │
                │   LV ref ← 3.3 V rail            │     parked here       │
                │   HV1..4 ⇄ LV1..4                │                       │
                └──────────────────────────────────┘                       │
                           │  LV-side jumpers (3.3 V signals)              │
                           ▼                                               │
                ┌──────────────────────────────────┐                       │
                │  MODULE A — POWER DISTRIBUTION   │   ← perf board        │
                │  In : PSU +3.3 V, +5 V, GND      │                       │
                │  Out: 6× (3V3+GND), 4× (5V+GND)  │                       │
                └──────────────────────────────────┘                       │
                           │                                               │
            ┌──────────────┼──────────────────┬─────────────────┐          │
            ▼              ▼                  ▼                 ▼          │
   ┌────────────────┐ ┌───────────────┐ ┌──────────────┐ ┌──────────────┐ │
   │ MODULE B       │ │ MODULE C      │ │ MODULE D     │ │ MODULE F     │ │
   │ SPI Flash/EE   │ │ I²C EEPROM    │ │ Microwire    │ │ In-circuit   │ │
   │ DUT Jig        │ │ DUT Jig       │ │ DUT Jig      │ │ Clip Rig     │ │
   │ (W25Q/M95/25xx)│ │ (24Cxx)       │ │ (93Cxx)      │ │ (SOIC-8 clip)│ │
   └────────────────┘ └───────────────┘ └──────────────┘ └──────────────┘ │
            │              │                  │                 │          │
            └──────────────┴──────────────────┴─────────────────┘          │
                                  │                                        │
                           DUT signal taps                                 │
                                  ▼                                        │
                ┌──────────────────────────────────┐                       │
                │   HiLetgo 24 MHz Logic Analyzer  │ ───────────────── ▲ ──┘
                │   parked over the DUT signals    │
                └──────────────────────────────────┘

  Klein 80196 multimeter: probes parked left of the DUT zone.
  T48 programmer: sits on its own as the "second opinion" — uses Xgpro, not flashrom.
  ESD mat: covers the whole area; wrist strap snapped to mat.
```

---

## 3. Standards

### 3.1 Standard DUT Headers — pinout = SOIC-8 chip pinout

**SPI DUT header** (matches 25xx / W25Qxx / M95xx SOIC-8 top view):

| Pin | Signal | Notes |
|----:|:-------|:------|
| 1   | CS     | active low |
| 2   | MISO / DO | data from chip |
| 3   | WP     | hard-tied HIGH on Jig B (read-only safe) |
| 4   | GND    | |
| 5   | MOSI / DI | data to chip |
| 6   | SCK / CLK | |
| 7   | HOLD   | hard-tied HIGH on Jig B (normal op) |
| 8   | VCC    | 3.3 V |

**I²C DUT header** (matches 24Cxx SOIC-8 functional groups):

| Pin | Signal | Notes |
|----:|:-------|:------|
| 1   | VCC    | 3.3 V |
| 2   | SDA    | pull-up via AITIAO level shifter |
| 3   | SCL    | pull-up via AITIAO level shifter |
| 4   | GND    | |

**Microwire DUT header** (matches 93Cxx SOIC-8 top view):

| Pin | Signal | Notes |
|----:|:-------|:------|
| 1   | CS     | active HIGH |
| 2   | SK / CLK | |
| 3   | DI     | data to chip |
| 4   | DO     | data from chip |
| 5   | GND    | |
| 6   | ORG    | jumper: LOW = x8, HIGH = x16 |
| 7   | NC     | leave open |
| 8   | VCC    | usually 5 V for writes; 3.3 V OK for reads |

### 3.2 Color conventions for jumper wires

Pick colors and stick with them across the whole bench. Recommended:

| Color | Signal class |
|:------|:-------------|
| Black | GND (always) |
| Red   | VCC / +3.3 V |
| Orange | +5 V |
| Yellow | CLK / SCK / SK |
| Green | MOSI / DI / SDA |
| Blue | MISO / DO |
| White | CS (chip select) |
| Brown | WP / HOLD / ORG / aux |

### 3.3 Naming conventions

- **Modules** are lettered: A (power), B (SPI DUT), C (I²C DUT), D (Microwire DUT), E (level shifter), F (in-circuit clip rig).
- **Headers** are labelled `<module><port-letter>` on the board with a Sharpie: e.g., `B-IN` (Module B's input from programmer/level shifter), `B-DUT` (where the chip sits).
- **Power rails** on Module A: `3V3-1` through `3V3-6`, `5V-1` through `5V-4`, `GND-*`.

---

## 4. Modules — what each one is, parts, and how to build

All modules use perf board from the 174-pc kit, soldered with 30 AWG silicone hookup wire. Headers from the 40-pin male/female header strips that came in that kit. Through-hole solder pads, no SMD.

### 4.A — Power Distribution Strip

**Purpose.** One place where the PSU lands and from which the rest of the bench draws clean 3.3 V and 5 V. Eliminates "where do I get 3.3 V" rewiring per session.

**Parts (v1 — confirmed 2026-05-25).**
- 1× small perf board (~4 × 6 cm) from the 174-pc kit.
- **4× thick hookup wires (~20 cm)** soldered directly into the board as PSU input, terminated at the PSU end with banana plugs or alligator clips. (No screw terminals — soldered direct wire.)
- 1× 2×8 (16-pin) female header for 3.3 V output ports (one row 3V3, one row GND).
- 1× 2×4 (8-pin) female header for 5 V output ports (one row 5V, one row GND).
- ~30 cm each of 30 AWG silicone hookup wire in red (3V3), orange (5V), black (GND).
- **2× LEDs (any color, 3 mm or 5 mm) + 2× 1 kΩ resistors** — one rail-live indicator per voltage rail.

**Layout (top view, header pin numbering left-to-right):**

```
   +---------------------------------------------------+
   |  [PSU IN]    [3V3-1 GND] [3V3-2 GND] [3V3-3 GND]  |
   |  3V3 ─ GND   [3V3-4 GND] [3V3-5 GND] [3V3-6 GND]  |
   |                                                   |
   |  [PSU IN]    [5V-1  GND] [5V-2  GND]              |
   |  5V  ─ GND   [5V-3  GND] [5V-4  GND]              |
   +---------------------------------------------------+
```

**Build steps (in order — do not skip the test).**
1. Lay out the female headers on the perf board, mark hole positions with a pencil.
2. Solder all the female headers down first (one corner each, check seating, then the rest).
3. Run a single red wire connecting every "3V3" pin in one continuous run. Solder at each pin.
4. Repeat with orange for the 5 V pins.
5. Run a single black wire connecting every GND pin — both 3V3-side and 5V-side share ground.
6. Solder the input screw terminal (or solder lugs) for the PSU side.
7. **Visual inspection.** No solder bridges. Continuity test next.
8. **Continuity test (Klein 80196 on continuity beep).**
   - Touch any 3V3 output pin to PSU 3V3 input → beep.
   - Touch any 5V output pin to PSU 5V input → beep.
   - Touch any GND pin to PSU GND → beep.
   - Touch any 3V3 pin to any 5V pin → **must NOT beep** (no short).
   - Touch any 3V3 pin to any GND pin → **must NOT beep**.
   - Touch any 5V pin to any GND pin → **must NOT beep**.
9. **First power test (no DUT, no chip).**
   - PSU: 3.30 V on channel A, 5.00 V on channel B (if 2-channel) OR pick ONE rail to test first.
   - Current limit: 100 mA.
   - Connect PSU → Module A input.
   - Output ON.
   - Multimeter at every output port: should read within ±0.05 V of nominal.
10. Sharpie-label every output port: `3V3-1`, `3V3-2`, …

### 4.B — SPI Flash / EEPROM DUT Jig

**Purpose.** Permanent home for one SPI chip-under-test at a time. Hot-swap by plugging a new module in. WP and HOLD pre-tied HIGH so we never forget.

**Parts (v1 — confirmed 2026-05-25).**
- 1× medium perf board (~5 × 7 cm) from the 174-pc kit.
- 1× **8-pin female socket** to host the W25Q64 module. Layout (1×8 inline vs 2×4 dual-row) must **match your specific W25Q64 module's pin arrangement** — inspect before placing.
- 1× **4-pin female header** labelled `B-IN` (CS, MISO, MOSI, CLK incoming from programmer / level shifter).
- 1× **2-pin female header** labelled `B-PWR` (3V3, GND from Module A).
- 1× **4-pin male header** labelled `B-TAP` (logic analyzer taps: CS, CLK, MOSI, MISO).
- 30 AWG silicone wire (red, black, plus 4 signal colors).

**Pin map (everything routes from the DUT socket — chip pinout drives the layout):**

| DUT socket pin (= SOIC-8 chip pin) | Signal | Internal trace lands on |
|----:|:------|:------------------------|
| 1 | CS    | `B-IN`-1 + `B-TAP`-1 |
| 2 | MISO  | `B-IN`-2 + `B-TAP`-4 |
| 3 | WP    | **hard-tied to 3V3 trace** (read-only safe, internal only) |
| 4 | GND   | GND trace + `B-PWR`-2 |
| 5 | MOSI  | `B-IN`-3 + `B-TAP`-3 |
| 6 | CLK   | `B-IN`-4 + `B-TAP`-2 |
| 7 | HOLD  | **hard-tied to 3V3 trace** (normal op, internal only) |
| 8 | VCC   | 3V3 trace + `B-PWR`-1 |

**Off-board headers (what you plug into):**

```
   B-IN (4 pins — from programmer / level shifter LV side)
      1: CS      2: MISO     3: MOSI     4: CLK

   B-PWR (2 pins — from Module A's 3V3 port)
      1: 3V3     2: GND

   B-TAP (4 male pins — for HiLetgo logic analyzer hooks)
      1: CS      2: CLK      3: MOSI     4: MISO
```

**Build steps.**
1. **Inspect your W25Q64 module first.** Most MusRock-style W25Q breakouts use a 1×8 single-row header. Some use 2×4 staggered. **Pick a DUT socket that matches.** Test-fit the W25Q64 into the socket before soldering anything — it must plug in cleanly with pin 1 (marked with a dot on the chip body or a "1" silkscreen on the breakout) at a known corner.
2. Plan the layout in Sharpie on the component side: DUT socket centered, B-IN on the right edge, B-PWR on the top edge, B-TAP on the bottom edge (or wherever the logic analyzer probes will land naturally).
3. Tack and solder the 4 headers using the same corner-pin technique as Module A.
4. **Wire the GND trace.** Single black wire: DUT-socket pin 4 → `B-PWR`-2. Solder both pins to it.
5. **Wire the 3V3 trace.** Single red wire connecting `B-PWR`-1 → DUT-socket pin 8 (VCC) → DUT-socket pin 7 (HOLD) → DUT-socket pin 3 (WP). All four points on one continuous run. This is what makes WP+HOLD impossible to forget.
6. **Wire each SPI signal (4 separate wires, color-coded):**
   - **White** (CS): DUT-socket pin 1 → `B-IN`-1 → `B-TAP`-1.
   - **Blue** (MISO): DUT-socket pin 2 → `B-IN`-2 → `B-TAP`-4.
   - **Green** (MOSI): DUT-socket pin 5 → `B-IN`-3 → `B-TAP`-3.
   - **Yellow** (CLK): DUT-socket pin 6 → `B-IN`-4 → `B-TAP`-2.
7. Visual inspection: no bridges, no cold joints.
8. **Continuity test** (multimeter on beep, **no chip in socket, no power**):
   - DUT pin 4 ↔ `B-PWR`-2 → beep.
   - DUT pin 8 ↔ `B-PWR`-1 → beep. DUT pin 7 ↔ `B-PWR`-1 → beep. DUT pin 3 ↔ `B-PWR`-1 → beep. (All three through the same 3V3 trace.)
   - DUT pin 1 ↔ `B-IN`-1 → beep. DUT pin 1 ↔ `B-TAP`-1 → beep.
   - Same for pin 2 ↔ `B-IN`-2 ↔ `B-TAP`-4; pin 5 ↔ `B-IN`-3 ↔ `B-TAP`-3; pin 6 ↔ `B-IN`-4 ↔ `B-TAP`-2.
   - **No-short checks:** any signal pin to GND → silence. Any signal pin to 3V3 trace → silence. 3V3 trace to GND → silence.
9. **Bring-up test (no chip in socket):**
   - Plug `B-PWR` into a Module A 3V3 port via a 2-wire Dupont jumper.
   - PSU on at 3.30 V / 100 mA limit.
   - Multimeter at DUT-socket pin 8 → 3.30 V. Pin 7 → 3.30 V. Pin 3 → 3.30 V. Pin 4 → 0.00 V.
   - Any wrong reading → kill power, find the short BEFORE inserting the W25Q64.
10. Sharpie-label `B-IN`, `B-DUT`, `B-PWR`, `B-TAP`. Draw an arrow pointing to the DUT socket corner where the W25Q64's pin 1 lands.

### 4.C — I²C EEPROM DUT Jig

**Purpose.** Permanent home for a 24LC256 DIP-8 or a 24Cxx SOIC-on-carrier.

**Parts.**
- 1× small perf board (~4 × 5 cm).
- 1× 8-pin DIP socket (for 24LC256 DIP-8). Optional: 1× 8-pin female header instead, for the SOIC-on-carrier.
- 1× 1×4 female header labelled `C-IN` (SDA, SCL, GND, VCC from level shifter LV side).
- 1× 1×2 jumper position for WP (HIGH = read-only / LOW = writes allowed).
- 30 AWG wire.

**Pin map (24LC256 in DIP-8 socket):**

```
   +----------------------------------------+
   |   A0  ─ A1 ─ A2  ─ GND                 |
   |   ║    ║    ║     ║                    |
   |   GND  GND  GND  GND                   |
   |   (all three address pins tied LOW → slave 0x50) |
   |                                        |
   |   VCC ─ WP ─ SCL ─ SDA                 |
   |   ║    ║    ║     ║                    |
   |   3V3  JMP  C-IN  C-IN                 |
   |        ┌─┐  pin 3 pin 2                |
   |        │ │  CCL    SDA                 |
   |        └─┘                             |
   |   WP jumper:                           |
   |     position UP   → tied 3V3 (read-only)│
   |     position DOWN → tied GND (writes OK)│
   +----------------------------------------+
```

**Build steps.**
1. Place DIP socket. Place C-IN header. Place WP jumper position (2-pin header).
2. Wire DIP pins 1, 2, 3 (A0/A1/A2) and 4 (GND) all to C-IN pin 3 (GND).
3. Wire DIP pin 8 (VCC) to C-IN pin 1 (VCC, 3V3).
4. Wire DIP pin 5 (SDA) to C-IN pin 2 (SDA).
5. Wire DIP pin 6 (SCL) to C-IN pin 4 (SCL).
6. WP (DIP pin 7) → jumper header; jumper-up = VCC, jumper-down = GND. Default = UP (read-only).
7. Continuity test.
8. Sharpie-label everything.

> **Pull-up resistors:** the AITIAO 4-channel level shifter has 10 kΩ pull-ups built into each LV channel. SDA + SCL pull-ups are therefore handled by the level shifter, no resistors needed on Module C.

### 4.D — Microwire DUT Jig (optional, build later)

Defer until needed. 93Cxx work is rare; we'd use Bus Pirate directly via menu mode for the first attempts, then build this once we know the access pattern.

### 4.E — Level Shifter Stage

**Purpose.** Always-on 5 V ↔ 3.3 V translation for the four SPI signals. Module B's `B-IN` always receives 3.3 V logic; a 5 V programmer connects via Module E's HV side.

**Parts.**
- 1× AITIAO 4-channel level shifter (pre-assembled — no soldering of the module itself).
- 4× short jumper wires from Module A (3.3 V port) and Module A (5 V port) to Module E's LV and HV reference pins.

**No build — it's a pre-made breakout.** What you do:

1. Connect Module E `HV` pin → Module A `5V-1` port.
2. Connect Module E `LV` pin → Module A `3V3-1` port.
3. Connect Module E `GND` (both sides — it's the same net) → Module A GND port.
4. Park it permanently on the bench between the programmer dock and the DUT jig.
5. Pre-cut **8 × 10 cm jumpers** in the 4 SPI signal colors (white CS, yellow CLK, green MOSI, blue MISO). Keep them in a small parts bin labelled "Module E jumpers — DO NOT REPURPOSE."

**How to use during a session:**
- Programmer 5 V signal → HV1..4 (one channel per signal).
- LV1..4 → DUT jig `B-IN` pins 1, 6, 5, 2 (CS, CLK, MOSI, MISO).

> If a programmer is **3.3 V native** (FT232H, Pi Pico), bypass Module E and jumper straight to `B-IN`. The level shifter is for 5 V programmers (CH341A, Bus Pirate at 5 V).

### 4.F — In-Circuit Clip Rig

**Purpose.** Reading a chip that stays soldered to its host PCB (scrap ECU, etc.). Uses the CH341A's bundled SOIC-8 clip.

**No perf-board build.** What you set up:

1. Mount the SOIC-8 clip cable in a "third-hand" or PCB holder, oriented so the clip naturally lands on the chip.
2. Standardise the clip cable colors per Section 3.2 above. The AiTrip kit's clip cable is typically rainbow — re-mark with Sharpie if needed.
3. Confirm the clip's pin 1 mark (usually a coloured dot or arrow on the clip body).
4. The other end of the clip cable plugs into the CH341A ZIF socket OR via Dupont jumpers into the level shifter HV side.

> **Always power-off before clipping. Always power-off before unclipping.** This is the single most important habit on the bench.

---

## 5. Programmers — what's where, and how each plugs in

| Programmer | Speaks our app? | Native VCC | Best use | Plugs into |
|:-----------|:----------------|:----------:|:---------|:-----------|
| **CH341A** | yes (flashrom backend) | 5 V (some 3.3 V mods) | First-line SPI flash reads. **Always through Module E.** | HV side of Module E |
| **FT232H** | yes (flashrom backend) | 3.3 V | Safer 3.3 V SPI. **Bypass Module E** — jumper direct to B-IN. | B-IN directly |
| **Bus Pirate v3.6** | yes (flashrom SPI) | switchable 3.3/5 V | I²C / Microwire experiments via terminal mode. SPI is slow (~1 KB/s). | B-IN (3.3 V) or HV side of Module E (5 V) |
| **T48** | **no** — uses Xgpro | switchable | **Second-opinion programmer.** Read with T48 into a .bin, then drop that .bin into the app for offline comparison against an app-read dump. | T48 has its own ZIF; standalone |
| **Pi Pico** | not yet (Phase E/F) | 3.3 V | Future custom programmer firmware. | TBD |

### 5.1 CH341A pin map (ZIF socket, SPI-flash position)

```
        ┌───────────┐
   CS  1│●          │8 VCC   ← measure here first, every session
  MISO 2│           │7 HOLD
   WP  3│           │6 SCK
   GND 4│           │5 MOSI
        └───────────┘
```

Standard CH341A ships at 5 V on pin 8. **Measure with Klein every session.** Route through Module E.

### 5.2 FT232H (Adafruit) pin map — MPSSE SPI

| FT232H pin | SPI signal | DUT pin |
|:-----------|:-----------|:--------|
| D0 | SCK | 6 |
| D1 | MOSI | 5 |
| D2 | MISO | 2 |
| D3 | CS | 1 |
| GND | GND | 4 |
| 3V3 | VCC (low current — prefer external supply for chip) | — |

FT232H is 3.3 V native. Skip Module E. Jumper direct to `B-IN` 1, 2, 4, 5, 6.

### 5.3 Bus Pirate v3.6 cable colors (standard)

| Color | Signal |
|:------|:-------|
| Brown | CS |
| Red | +VCC (3.3 V or 5 V — software-selected) |
| Orange | MOSI |
| Yellow | CLK |
| Green | MISO |
| Purple | AUX |
| Grey | +3.3 V |
| White | +5 V |
| Black | GND |

Bus Pirate voltage is software-selectable. Default to 3.3 V; jumper direct to `B-IN`. Only go through Module E if you have a specific reason to use 5 V.

### 5.4 T48 standalone

T48 uses Xgpro on the laptop. Workflow:
1. Read chip in Xgpro → save `t48_dump.bin`.
2. Compute SHA-256 (PowerShell: `Get-FileHash t48_dump.bin -Algorithm SHA256`).
3. Compare with our app's SHA-256 for the same chip read. They should match exactly.

This is the **gold-standard cross-check** for any contested dump.

---

## 6. Standard Operating Procedures

### 6.1 Cold start (begin every session)

1. **ESD first.** Snap wrist strap to mat snap.
2. **Visual check:** no loose wires from previous session, no chips in any socket.
3. **PSU off.** Confirm output disable button is OFF.
4. **PSU set:** 3.30 V on channel A, 100 mA current limit (default). 5.00 V on channel B if used.
5. **Connect PSU → Module A** (if not permanently connected).
6. **Output ON.** Multimeter at Module A 3V3 and 5V outputs → confirm within ±0.05 V.
7. **Plug programmer into USB** (don't plug it into the DUT yet).
8. **Open the app.** Tool Status → confirm flashrom installed.
9. **Test programmer connection** in the Adapters page.
10. Bench is ready.

### 6.2 Reading a chip (any type)

1. Power up per 6.1.
2. Identify the chip family: SPI flash → Module B. I²C EEPROM → Module C. Microwire → Module D.
3. **Configure the DUT jig** for this specific chip (e.g., Module C WP jumper to UP for read-only).
4. Power down the PSU (output OFF) before inserting the chip.
5. **Insert chip** in the DUT jig socket. Orient pin 1 to the marked arrow.
6. **Wire programmer → (Module E if 5 V) → DUT jig `*-IN`** using the pre-cut signal jumpers.
7. Wire **DUT jig `*-PWR`** to a Module A 3V3 port.
8. **Power on.** Watch current — should be a few mA at idle.
9. **App: New Chip Job** → pick chip profile → pick programmer adapter → wiring confirm → safety check → Read 1.
10. **Read 2.** Verify. Hex preview. Save report.
11. **Power down.** Remove chip. Bench is back at neutral.

### 6.3 Cold shutdown (end every session)

1. **PSU output OFF.**
2. Unplug all programmers from USB.
3. Remove any chip from the DUT socket.
4. Coil jumpers, return Module E spares to the parts bin.
5. Wrist strap off (snap to mat is fine — leave it grounded for next time).
6. Cover with anti-static cloth if dusty environment.

### 6.4 Add a new chip to the app's database

When you encounter a chip that's NOT yet in `@ecu/chip-db`:

1. Confirm exact part marking (top of package).
2. Confirm package (SOIC-8, SOIC-16, TSOP, etc.).
3. Confirm protocol (SPI, I²C, Microwire) and capacity from the datasheet.
4. In a future code session, add to `packages/chip-db/src/catalog.ts` via the appropriate factory (`m95Profile`, `i2cEepromProfile`, `microwireProfile`, `spiNorProfile`) OR a custom JSON in `seedProfiles/`.
5. Re-run the workflow with the new profile.

---

## 7. Safety rules (drilled, non-negotiable)

1. **Wrist strap before chips.**
2. **Measure VCC before clipping.** Klein on DC volts at the ZIF / programmer / chip pin 8 — every session, no exceptions.
3. **Power down before clipping.** Power down before unclipping.
4. **Power sequencing:** GND → signal → VCC. Reverse for tear-down.
5. **Read-only by default.** Write path is gated by `ECL_OPERATION_MODE=read_write_experimental` AND a verified backup AND a verified donor archive AND typed confirmation. Never bypass these.
6. **Donor archive is sacred.** Never overwrite the donor pre-read dump.
7. **Current limit on the PSU.** Default 100 mA. Raise only when you understand why.
8. **Don't trust the chip pin 1 mark — verify with the datasheet.** Wrong-orientation insertion = magic smoke.
9. **One chip at a time.** No "I'll just read this one quickly" while another job is mid-flight.
10. **Log every read.** The app does this automatically; don't disable it.

---

## 8. Current Inventory (as of last update)

**Mounted on bench (permanent):**
- Module A — Power Distribution Strip — *to build*
- Module B — SPI Flash/EEPROM DUT Jig — *to build*
- Module C — I²C EEPROM DUT Jig — *to build*
- Module E — Level Shifter (AITIAO) — *to mount*

**Staged on bench (plug in as needed):**
- CH341A + SOIC-8 clip + 1.8 V adapter (AiTrip kit)
- FT232H (Adafruit) — *needs header pins soldered*
- Bus Pirate v3.6a
- XGecu T48 with 12-piece adapter pack
- 2× Raspberry Pi Pico (headers soldered)

**Diagnostic, parked on bench:**
- Klein 80196 multimeter
- HiLetgo 24 MHz 8-channel logic analyzer

**Power:**
- 30 V / 10 A variable bench PSU (encoder + current limit + USB-QC)

**Chip stock (parts bin):**
- 5× 24LC256-I/P (DIP-8)
- 10× MusRock W25Q64 modules (SOIC-8 on breakout)
- 5× NOYITO W25Q32 modules
- 100× assorted 24Cxx + 93Cxx (SOP — need adapter-board soldering)
- 9× spare AITIAO level shifters
- 2× spare Pi Pico

**Adapter / wiring stock:**
- 10× SOIC-8 → DIP-8 narrow adapter PCBs
- 174-pc PCB perf board kit (multiple sizes + 40-pin headers)
- Chanzon 120-pc Dupont jumpers (M/M + M/F + F/F, 30 cm)
- BOCEUC 18× mini-grabber clip leads (6 colors)
- Fermerry 30 AWG silicone hookup wire (25 ft × 6 colors)

**Workshop:**
- Soldering station + iron + solder + flux + IPA — *user-supplied, on hand*
- ESD mat + wrist strap — *user-supplied, on hand*

---

## 9. Roadmap (future modules — build when needed)

- **Module D — Microwire DUT Jig.** When first 93Cxx job appears.
- **Module G — ECU PCB holder + bench harness.** When first scrap ECU arrives.
- **Module H — Pi Pico custom programmer.** Phase E (after STM32/RP2040 JTAG practice).
- **Module I — JTAG/SWD probe** (OpenOCD-driven). Phase E.
- **Module J — OBD-II bench harness.** When first vehicle-bench job appears.

---

## 10. Build order (recommended)

1. **Module A (Power Distribution Strip)** — first, everything depends on it.
2. **Module B (SPI Flash DUT Jig)** — second, enables W25Q64 reads with our app.
3. **Module E (Level Shifter mounting)** — at the same time as B; trivial since the AITIAO board is pre-assembled.
4. First real read: CH341A → Module E → Module B → W25Q64. Verify in the app.
5. **Module C (I²C EEPROM DUT Jig)** — once SPI path is rock-solid.
6. Solder pin headers onto the FT232H — repeat Module B read with FT232H to cross-check SHA-256.
7. Solder 5 × SOP chips (24C02 / 93C46 / etc.) onto SOIC-8 → DIP carriers — practice soldering.
8. Module D / G / H / etc. as the project demands.

---

## 11. Changelog

- **v1** (2026-05-25) — Initial design. Modules A, B, C, E specified. Build order set.
