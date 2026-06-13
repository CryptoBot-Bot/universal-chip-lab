# 125 kHz Transponder Reader — Build & Solder Guide (Layer 2)

Reads the **125 kHz RFID transponder** inside a car key (the immobilizer band).
Brain is a **Raspberry Pi Pico**; the RF heavy-lifting is an **EM4095** analog
front-end driving a tuned **125 kHz antenna**.

> ⚖️ **Legitimate use only.** This is for lawful key/immobilizer work on vehicles
> you own or are authorized to service (locksmith / module recovery). It does not
> defeat anti-theft — it reads/decodes transponders.

> 🔌 **Voltage domains bite.** The EM4095 runs at **5 V**; its DEMOD/RDYCLK pins
> swing to 5 V. The Pico is **not 5 V tolerant**. The 4-channel level shifter is
> **mandatory** — same lesson as the car build's protection block.

---

## Bill of materials

**Modules:**
- Raspberry Pi Pico (RP2040)
- 4-channel bidirectional level shifter (BSS138 — your AITIAO module)

**Front-end (solder these):**
| Ref | Part | Job |
| --- | --- | --- |
| U1 | **EM4095** (SOIC-16) | 125 kHz carrier + demodulator |
| L1 | 125 kHz antenna coil ~**1.2 mH** | the read field (pre-made or hand-wound) |
| Cres | **1.5 nF C0G/NP0** | resonant cap (tunes L1 to 125 kHz) |
| Rser | **5–10 Ω** | antenna series/damping |
| Cfcap | per datasheet (a few pF) | sets the carrier frequency |
| Cdec | **100 nF + 4.7 µF** | EM4095 VDD decoupling |
| LED+R | green LED + **330 Ω** | status |

> Get the **EM4095 datasheet** and copy its *typical application* figure for the
> exact pin numbers and the CFCAP / Cdec values — those are part-specific.

---

## Topology

```
 Pico VBUS(5V) ─────────────► EM4095 VDD            ┌─ L1 (1.2mH) ─┐
 Pico GND ──────────────────► EM4095 VSS       ANT1─┤   ‖ Cres     ├─ANT2   (LC tank @125kHz)
                                                     └──[Rser]──────┘
 EM4095 DEMOD ─►─[shift HV1|LV1]─►─ Pico GP10   (data, 5V→3.3V)
 EM4095 RDYCLK─►─[shift HV2|LV2]─►─ Pico GP11   (clock,5V→3.3V)
 Pico GP12 ─►─[shift LV3|HV3]─►─ EM4095 SHD     (enable, 3.3V→5V)
 Pico GP13 ─►─[shift LV4|HV4]─►─ EM4095 MOD     (write,  3.3V→5V)

 Level shifter:  LV ← Pico 3V3 ,  HV ← Pico VBUS(5V) ,  GND ← common
```

## Connection table (solder this)

| From | → To | Net | Notes |
| --- | --- | --- | --- |
| Pico **VBUS** | EM4095 **VDD** | 5V | USB 5 V powers the front-end |
| Pico **GND** | EM4095 **VSS** | GND | |
| Pico **3V3** | shifter **LV** | ref | low-voltage reference |
| Pico **VBUS** | shifter **HV** | ref | high-voltage reference (5 V) |
| EM4095 **ANT1/ANT2** | antenna **L1 + Cres + Rser** | tank | tune to 125 kHz |
| EM4095 **DEMOD** | shifter **HV1** → **LV1** → Pico **GP10** | data | 5 V → 3.3 V |
| EM4095 **RDYCLK** | shifter **HV2** → **LV2** → Pico **GP11** | clk | 5 V → 3.3 V |
| Pico **GP12** | shifter **LV3** → **HV3** → EM4095 **SHD** | enable | 3.3 V → 5 V |
| Pico **GP13** | shifter **LV4** → **HV4** → EM4095 **MOD** | write | 3.3 V → 5 V |
| Pico **GP15** | 330 Ω → LED → GND | status | |

## Antenna tuning
`f = 1 / (2π·√(L·Cres))`. With **L = 1.2 mH** and **Cres = 1.5 nF** → ~118 kHz.
Trim Cres (try 1.3–1.5 nF) until a scope on the tank shows peak amplitude at
**125 kHz**. A bigger coil needs a smaller cap. Read range is a few cm.

## Firmware
`wokwi/main.py` enables the field (SHD=0) and samples DEMOD on RDYCLK edges. The
per-tag-family **decode** (Manchester/biphase → ID) is the part you extend.

## Reality check
- **Out of the box:** reads EM4100-class / simple LF tags — great for learning the
  full RF→bits chain.
- **Automotive crypto keys** (Hitag2, Megamos/ID48, DST80): the *front-end* is the
  same, but the **protocol + keys** are the hard part. The proven tool there is a
  **Proxmark3 RDV4** (~$80). Build this to learn and to read basic tags; reach for
  the Proxmark when you need real key crypto.

## Test plan
1. **Power:** VBUS = 5 V at EM4095 VDD, shifter LV=3.3 V / HV=5 V. LED heartbeats.
2. **Field:** scope the antenna tank — you should see a ~125 kHz sine. Trim Cres.
3. **Tag:** hold a 125 kHz tag/transponder to the coil → serial prints "tag
   activity" → add the decode for your tag family.
