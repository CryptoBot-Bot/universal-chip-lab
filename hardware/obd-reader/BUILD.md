# OBD-II CAN Reader — Build & Solder Guide

A car-powered CAN-bus reader: plugs into a vehicle's OBD-II port, powers itself
from the car's 12–14 V battery (via an **LM2596** buck → 5 V), reads the **CAN
bus**, measures **battery voltage**, and streams everything to the laptop over
**USB (data only)**. The brain is a **Raspberry Pi Pico**.

> ⚠️ **CARS BITE.** The 12 V line spikes to 40 V+ (load dump) and reverse polarity
> kills everything. The protection section is **not optional** — it's the
> reverse-polarity-on-the-M95 lesson at car scale.

---

## Bill of materials

**Modules (you have / ordered):**
- Raspberry Pi Pico (RP2040)
- LM2596 adjustable buck module
- SN65HVD230 CAN transceiver module (3.3 V) — chip = LCSC **C12084**
- **2× SN65HVD230** if you want both CAN buses (HS-CAN + MS-CAN)
- OBD-II (J1962) male plug → bare-wire pigtail

**Optional front-ends (multi-protocol — see "Going further" below):**
- 2nd SN65HVD230 module → **MS-CAN** (body bus, OBD pins 3/11)
- **L9637D** ISO-9141/KWP2000 transceiver (SO-8) → **K-line** (OBD pin 7)
- K-line support parts: 510 Ω pull-up, 1N4007 series diode, 3.3 V↔5 V level shifter

**Protection + sense parts (pennies):**
| Ref | Part | Job |
| --- | --- | --- |
| F1 | Inline fuse 0.5–1 A + holder | protects the wiring |
| D1 | Schottky 3 A 40 V (SS34 / 1N5822) | reverse-polarity block |
| D2 | TVS, ~24 V (SMBJ24A / P6KE30A) | clamps load-dump spikes |
| R1 | 47 kΩ 1 % | battery-sense divider, top |
| R2 | 10 kΩ 1 % | battery-sense divider, bottom |
| C1 | 100 nF | ADC noise filter |
| D3 | 3.3 V Zener (1N4728 / BZX) | ADC over-voltage clamp |

---

## Schematic (topology)

```
 OBD-16 (+12V) ──[F1 fuse]──┬───────[D1 Schottky]───► LM2596 IN+ ──► OUT (set 5.1V) ─► Pico VSYS (pin39)
                            │                                         LM2596 IN- ─┐
                       [D2 TVS]                                                    │
                            │                                                      │
                           GND ◄──────────────── OBD-5 (GND) ──────────────────────┤  ← common ground
                            │                                                      │
   (battery sense)          │                                                      │
 node A ──[R1 47k]──┬───────► Pico GP28 / ADC2 (pin34)                             │
                    ├──[R2 10k]──► GND                                             │
                    ├──[C1 100n]─► GND                                             │
                    └──[D3 Zener 3.3]─► GND                                        │
                                                                                   │
 Pico 3V3 (pin36) ─────────────────► SN65HVD230 VCC                                │
 Pico GP5 (pin7)  ──CAN TX─────────► SN65HVD230 D (TXD)                            │
 Pico GP4 (pin6)  ◄─CAN RX───────── SN65HVD230 R (RXD)                             │
                                     SN65HVD230 RS ──► GND                          │
                                     SN65HVD230 GND ──────────────────────────────┘
                                     SN65HVD230 CANH ──► OBD-6  (CAN-H)
                                     SN65HVD230 CANL ──► OBD-14 (CAN-L)

 Pico USB ──► laptop   (DATA ONLY — Pico's onboard diode blocks back-feed)
```
*"node A" = the point right after the fuse. The TVS clamps everything downstream.*

---

## Connection table (solder this exactly)

| From | → To | Net | Notes |
| --- | --- | --- | --- |
| OBD pin 16 (+12V) | F1 fuse → node A | CAR_12V | fuse in the +12 V wire |
| node A | D1 anode | — | D1 cathode → LM2596 IN+ |
| node A | D2 (TVS) → GND | clamp | clamps load-dump |
| D1 cathode | LM2596 **IN+** | PROT_12V | |
| OBD pin 5 (GND) | LM2596 **IN−** / common GND | GND | the one mandatory ground |
| LM2596 **OUT+** (5.1 V) | Pico **VSYS** (pin 39) | 5V | **set to 5.1 V first!** |
| LM2596 **OUT−** | common GND | GND | |
| node A | R1 (47k) → ADC node | sense | |
| ADC node | R2 (10k) → GND | sense | divider bottom |
| ADC node | C1 (100n) → GND | filter | |
| ADC node | D3 (3.3 V Zener) → GND | clamp | cathode to ADC node |
| ADC node | Pico **GP28 / ADC2** (pin 34) | ADC_BAT | |
| Pico **3V3** (pin 36) | SN65HVD230 **VCC** | 3V3 | |
| Pico **GP5** (pin 7) | SN65HVD230 **D / TXD** | CAN_TX | Pico drives |
| SN65HVD230 **R / RXD** | Pico **GP4** (pin 6) | CAN_RX | Pico reads |
| SN65HVD230 **RS** | common GND | — | high-speed mode |
| SN65HVD230 **GND** | common GND | GND | |
| SN65HVD230 **CANH** | OBD pin 6 | CANH | keep short, paired |
| SN65HVD230 **CANL** | OBD pin 14 | CANL | keep short, paired |
| Pico **USB** | laptop | DATA | comms only |

> **Module labels vary.** Match by chip function: **D** = data *from* Pico (TX);
> **R** = data *to* Pico (RX).
> **No 120 Ω terminator** when tapping a car — the bus is already terminated.
> If your transceiver module has a 120 Ω jumper, **leave it OFF**.

---

## 🛑 STEP 1 — set the LM2596 to 5.1 V *before* connecting the Pico
LM2596 modules ship with the pot at a random setting — often near *input*
voltage. Wiring it to the Pico unset can dump 12 V into VSYS and **kill the Pico
instantly.**
1. Feed the LM2596 from a 12 V source.
2. Turn the pot while **measuring OUT+ with your multimeter** until it reads **5.1 V**.
3. Confirm 5.1 V, then — and only then — connect OUT+ to Pico VSYS.

*(5.1 V > USB's diode-dropped ~4.7 V, so the buck wins cleanly; the Pico's
onboard VBUS Schottky blocks any back-feed into the laptop.)*

---

## Battery-voltage math
`V_battery = V_adc × (R1 + R2) / R2 = V_adc × 5.7`
- 12.0 V → 2.11 V at GP28 · 14.4 V (charging) → 2.53 V · safe up to ~18.8 V before D3 clamps.
- **Calibrate the ×5.7 once** against your multimeter (resistor tolerance) — store the factor in firmware.

## Pico pin map
| Pico | Physical pin | Use |
| --- | --- | --- |
| VSYS | 39 | 5.1 V power in (from LM2596) |
| GND | 38 | common ground |
| 3V3(OUT) | 36 | transceiver VCC |
| GP28 / ADC2 | 34 | battery-voltage sense |
| GP4 | 6 | HS-CAN RX (← transceiver R) |
| GP5 | 7 | HS-CAN TX (→ transceiver D) |
| GP6 | 9 | MS-CAN RX (← 2nd transceiver R) — optional |
| GP7 | 10 | MS-CAN TX (→ 2nd transceiver D) — optional |
| GP8 | 11 | K-line TX (→ L9637D TX, via shifter) — optional |
| GP9 | 12 | K-line RX (← L9637D RX, via shifter) — optional |
| USB | — | data to laptop |

---

## ⚡ Grounding — the one risk of car-power + laptop-USB
Car-GND, Pico-GND and laptop-USB-GND all become tied.
- **Free fix (do this):** run the **laptop on its own battery** (unplugged from the
  wall) while testing → its ground floats → single clean reference.
- **Robust fix (PCB era):** a USB isolator (ADuM4160) or isolated CAN (ISO1050).

---

## Going further — multi-protocol front-ends

A car uses **one** diagnostic protocol on the standard pins, but adding a 2nd CAN
and a K-line front-end means you can plug into almost anything on the road.

### MS-CAN (body / comfort bus) — OBD pins 3 & 11
Many cars (esp. Ford / Mazda) run powertrain on HS-CAN (6/14, 500 kbit/s) and a
slower body bus on **3 (CAN-H) / 11 (CAN-L)** at 125 kbit/s, behind a gateway.
Reaching modules that aren't on the powertrain bus needs a **second SN65HVD230**.

| From | → To | Net |
| --- | --- | --- |
| Pico **3V3** | 2nd SN65HVD230 **VCC** | 3V3 |
| Pico **GP7** | 2nd SN65HVD230 **D / TXD** | MSCAN_TX |
| 2nd SN65HVD230 **R / RXD** | Pico **GP6** | MSCAN_RX |
| 2nd SN65HVD230 **RS** | common GND | mode |
| 2nd SN65HVD230 **GND** | common GND | GND |
| 2nd SN65HVD230 **CANH** | OBD pin **3** | MSCANH |
| 2nd SN65HVD230 **CANL** | OBD pin **11** | MSCANL |

> Same rules as HS-CAN: **no 120 Ω terminator** on a live car (the bus is already
> terminated). MS-CAN pinout is OEM-specific — **verify on the actual car** before
> wiring; pins 3/11 are *typical* (Ford/Mazda), not guaranteed.

### K-line (ISO 9141 / KWP2000) — OBD pin 7
Late-90s → mid-2000s ECUs (and some modules still) talk K-line: a single 12 V
open-drain wire. You **cannot** drive it from the Pico directly. Use an **L9637D**
transceiver as the front-end.

```
            +12V (protected rail)
              │
            [510Ω]            ┌──────── L9637D ────────┐
              │      ┌─[1N4007]─┤ Vs (7)        Vcc (8) ├── +5V (from VSYS rail)
 OBD-7 ───────┴──────────────┤ K  (5)        GND (1) ├── GND
 (K-line)                     │                       │
                  Pico GP8 ─►─┤ TX (4)         RX (2) ├─►─ Pico GP9
                          (through a 3.3 V ↔ 5 V level shifter)
```

| From | → To | Notes |
| --- | --- | --- |
| OBD pin **7** | L9637D **K** (pin 5) | + 510 Ω pull-up to +12 V |
| +12 V rail | L9637D **Vs** (pin 7) | via 1N4007 series diode |
| +5 V (VSYS) | L9637D **Vcc** (pin 8) | logic supply |
| GND | L9637D **GND** (pin 1) | |
| Pico **GP8** | L9637D **TX** (pin 4) | **through level shifter** |
| L9637D **RX** (pin 2) | Pico **GP9** | **through level shifter** |

> ⚠️ **The level shifter is mandatory.** The L9637D logic pins swing to its 5 V
> Vcc — feeding 5 V straight into a Pico GPIO will damage it. Use one channel of
> your AITIAO/BSS138 shifter each way (Pico 3.3 V side ↔ L9637D 5 V side). This is
> the reverse-polarity-on-the-M95 lesson again: **match the voltage domains.**

In the Wokwi project the K-line front-end is the single **chip-kline** block
(L9637D + pull-up + diode + shifter bundled, same way `chip-carprotect` bundles
the protection parts). Its `V12` pin is the protected 12 V rail, `VCC` is the
3.3 V logic reference, `TX`/`RX` are the Pico-side logic, `K` goes to OBD-7.

---

## Build order
1. **Set LM2596 → 5.1 V** (multimeter). Don't skip.
2. Solder the **input protection** on the +12 V wire: `F1 → node A`, `D2 TVS → GND`, `D1 Schottky → LM2596 IN+`.
3. Solder **LM2596 OUT+ → VSYS**, all **grounds common**.
4. Solder the **battery divider** (R1/R2/C1/D3) → GP28.
5. Solder the **transceiver** (VCC/GND/D/R/RS) and **CANH/CANL** to the OBD pins.
6. Keep **CAN-H / CAN-L short and side-by-side** (twisted if you can).

## Test plan
1. **Bench (12 V supply, no car):** confirm **5.1 V at VSYS**, Pico boots over USB,
   firmware prints battery voltage ≈ supply ÷ 5.7 × 5.7 = supply. Tune the cal factor.
2. **Fake-ECU bench bus:** 2nd Pico + 2nd transceiver sending 500 kbps frames →
   reader logs them. *(For this 2-node bench bus, DO add 120 Ω at each end.)*
3. **Car:** fuse in, **laptop on battery**, plug OBD in → **ignition on, engine off**
   → read CAN + battery voltage → start engine → watch it climb 12 → ~14 V. 🔋
