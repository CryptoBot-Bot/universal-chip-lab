# Universal Chip Lab — "SUPER DEVICE" AS-BUILT

**The open, AI-driven, self-documenting vehicle + silicon workstation.**
One box that spans **OBD bus → bench boot-mode → raw memory chip**, with a growing
knowledge base and a hard safety ceremony. This is the definitive build document:
architecture, bill of materials, wiring, power, software, and the "did we miss
anything" register. It is a **living AS-BUILT** — check off each subsystem as it is
built (see §12).

> Status: DESIGN / BUILD-IN-PROGRESS · Owner: CryptoBot · Companion docs:
> `docs/WORKSTATION.md` (bench v1), `hardware/obd-reader/BUILD.md` (Pico reader),
> `picoforge/` (memory programmer), `hardware/mcu-debugger/`, `hardware/transponder-reader/`.

---

## 0. Why this is new

Commercial tools are **siloed**: a J2534 pass-thru flashes over the bus; a
BDM/boot tool (KTAG/Autotuner) reads an ECU on the bench; a chip programmer
(T48/CH341) reads raw memory; a scan tool reads DTCs. **Nobody ships one open,
transparent, AI-assisted workstation that covers all three domains, remembers
everything it has ever seen, and enforces a lawful clone ceremony in software.**

That unification — **Bus domain + Bench-Memory domain + Bench-MCU domain under one
brain with a self-growing Vehicle Intelligence knowledge base** — is the thing that
does not yet exist. This document builds it.

---

## 1. Safety & legal charter (read first, non-negotiable)

This device is powerful enough to brick modules and to read protected memory. The
following are **hard invariants** baked into the build and the software:

1. **Lawful scope only.** Your own vehicles/modules, or written-authorized units.
   Purpose: byte-exact **clone-to-donor for burned-module recovery** and diagnostics.
2. **No immobiliser/anti-theft defeat.** We do not bypass immo, roll back odometers,
   or defeat security for theft. Read-side transponder/immo work is for *recovery of
   your own* keys/modules only.
3. **The 5-part write gate + donor-archive-rollback** (existing Cloning Ceremony)
   governs every write. Never weakened. Before ANY write to ANY target:
   archive the donor image, checksum it, store it, and keep a verified rollback.
4. **Never write on an unstable supply.** Flashing on a sagging/cranking supply is how
   ECUs die. The UPS ride-through (§7) and a "supply-OK" software interlock exist for
   exactly this.
5. **Read before you trust.** Every write is verify-read-back + checksum compared.

---

## 2. System architecture

```
                       ┌──────────────────────────────────────────────┐
   LAPTOP (ECU Lab app)│  Raspberry Pi 5  —  "the brain"              │
   React UI + AI  ◄────┼─ USB-gadget serial  OR  Ethernet/socket       │
   knowledge base      │  Linux + SocketCAN + daemon (write gate here) │
                       └───┬───────────────┬───────────────┬──────────┘
                           │ 40-pin header │  PCIe/USB      │ USB hub (powered)
                           ▼               ▼                ▼
                 ┌───────────────┐  ┌────────────┐   ┌─────────────────────────┐
                 │ 2-CH ISOLATED │  │ NVMe SSD   │   │  MODULAR PROTOCOL PODS   │
                 │ CAN-FD HAT    │  │ (logging)  │   │  each = transceiver+USB  │
                 │ MCP2518FD ×2  │  │  + UPS     │   ├─────────────────────────┤
                 │ HS-CAN │ MS-CAN│  └────────────┘   │ K-Line pod (L9637D)      │
                 └──┬────────┬───┘                    │ LIN pod (opt)            │
                    │        │                        │ USB-CAN-FD bus 3/4 (opt) │
                    ▼        ▼                        │ J1850 / SW-CAN (opt)     │
              ┌─────────────────────────────┐        │ DoIP T1 media conv (opt) │
              │  FRONT PANEL / OBD BREAKOUT  │        ├─────────────────────────┤
              │  keyed OBD-II + banana taps  │        │ BENCH-MEMORY: T48,       │
              │  120Ω termination jumpers    │        │   PicoForge, SOIC clips  │
              └─────────────────────────────┘        │ BENCH-MCU: JTAG/SWD/BDM  │
                    ▲                                 │   probe + boot harness   │
      VEHICLE 12V ──┘ (fused, TVS, reverse-prot)      └─────────────────────────┘
```

**Design rule that makes it clean and expandable:** the **CAN HAT owns the 40-pin
header**; **everything else hangs off a powered USB hub as modular pods.** Add a
protocol by adding a pod — no re-stacking, no header contention. Each pod is a
transceiver + a USB-UART (or an existing USB programmer).

**Integration model:** *hybrid VCI* — the rich app stays on the laptop (screen, AI,
Anthropic API); the Pi is the real-time bus/bench interface. They speak your existing
command protocol first (drop-in), a streaming socket later. See the migration plan
(companion doc) for the daemon↔app mapping.

---

## 3. Bill of materials

Prices are **rough** (USD) for budgeting; they drift. "Own?" references your existing
kit (CH341A, FT232H, Bus Pirate, T48, 2× Pico, level shifters, Klein 80196, W25Q,
MCP2515s, SN65HVD230, LM2596, iron+ESD).

### 3.1 CORE — build this first (the working universal reader)

| Item | Spec / suggested part | Qty | Role | Own? |
|---|---|---|---|---|
| Raspberry Pi 5 | 8 GB (16 GB if budget allows) | 1 | The brain | buy |
| Active Cooler | Official Pi 5 active cooler | 1 | Pi 5 throttles hot, esp. in a car | buy |
| PSU (bench) | Official 27 W USB-C PD | 1 | Bench power | buy |
| Boot media | High-endurance microSD 64 GB (A2) | 1 | OS boot | buy |
| **2-CH Isolated CAN-FD HAT** | Waveshare, MCP2518FD ×2 + MCP2562FD, 40 MHz xtal, isolated | 1 | HS + MS, galvanically isolated | **buy (this unit)** |
| OBD-II cable | Male OBD-II → flying leads, 16-pin, fused | 1 | Vehicle tap | buy |
| OBD-II breakout | Female J1962 breakout board / box, all 16 pins to test points | 1 | Wire any protocol to the right pin | buy/DIY |
| Termination | 120 Ω 1% resistors + 2-pin jumpers | 4 | Bench CAN termination (no vehicle harness) | have/buy |
| Powered USB hub | USB 3.0, per-port, quality (not the cheap ones) | 1 | Feeds all pods + programmers | buy |
| Wiring | PTFE hookup, JST/Dupont, ferrules, heat-shrink | kit | Harness | have |

### 3.2 POWER & SURVIVAL — do not skip (this is where builds die)

| Item | Spec / suggested part | Qty | Role | Own? |
|---|---|---|---|---|
| Automotive buck 12→5 V | **5 V @ 5 A** (Pi 5 is hungry), wide-input | 1 | Run Pi from car | have (LM2596 = 3A, likely need beefier) |
| UPS / ride-through | Pi 5 UPS HAT **or** supercap module w/ GPIO shutdown | 1 | Survive crank sag + **prevent SD/NVMe corruption** on power yank | buy |
| Load-dump TVS | Automotive TVS (e.g. SMBJ33A / SM6T39) on 12 V in | 1–2 | Clamp load-dump/spikes | buy |
| Reverse-polarity | P-MOSFET ideal-diode (or Schottky) on 12 V in | 1 | Survive backwards clips | buy |
| Fuse | Blade fuse holder + 5 A fuses | 1 | Vehicle feed protection | have/buy |
| RTC battery | Pi 5 RTC coin cell | 1 | Offline timestamped logs | buy |

### 3.3 LEGACY / EXTRA-BUS PODS — universality (add as needed)

| Item | Spec / suggested part | Qty | Role | Own? |
|---|---|---|---|---|
| K-Line pod | **L9637D** (or MC33290) + FT232 USB-UART (3.3 V) + K pull-up (510 Ω–1 k to VBAT) + TVS | 1 | ISO 9141 / ISO 14230 KWP2000 (OBD pin 7) | partial (have FT232H) |
| LIN pod (opt) | TJA1021 / MCP2004A + USB-UART | 1 | LIN sub-buses (body/comfort actuators) | buy |
| 3rd/4th CAN (opt) | CANable 2.0 (CAN-FD, gs_usb) or Innomaker USB-CAN-FD | 1–2 | Tap more buses simultaneously | buy |
| J1850 / SW-CAN (opt) | STN2120-based board **or** discrete (MC33390 VPW / MC33897 SW-CAN) | 1 | Old GM/Ford (pins 2/10), GMLAN single-wire (pin 1) | buy |

### 3.4 BENCH-MEMORY DOMAIN — the clone endgame (chip off the board)

| Item | Spec / suggested part | Qty | Role | Own? |
|---|---|---|---|---|
| Universal programmer | **T48** (XGecu) | 1 | Socketed EEPROM/FLASH/MCU, huge library | **have** |
| In-circuit programmer | **PicoForge** (3.3 V-safe, SPI/I²C/Microwire) | 1 | Clip-on in-circuit reads | **have** |
| SOIC clips | **Pomona 5250 (SOIC-8)** + **5252 (SOIC-16)** — buy quality, knockoffs slip | 2 | Clip onto memory chips | buy quality |
| ZIF adapters | SOIC/TSSOP/SOP → DIP adapters for T48 | set | Program desoldered chips | have some |
| Memory stock | W25Q / 25/24-series modules | have | Practice + donor spares | **have** |

### 3.5 BENCH-MCU DOMAIN — internal-MCU cloning (Phase F, advanced)

| Item | Spec / suggested part | Qty | Role | Own? |
|---|---|---|---|---|
| JTAG/SWD probe | FT2232H board + OpenOCD (ARM Cortex, many) | 1 | On-chip debug read/write | have FT232H (FT2232H better) |
| BDM harness | Your `mcu-debugger` (MPC5xx/HC12 BDM) | 1 | Motorola/NXP ECU BDM | **have (project)** |
| Boot-mode kit | Chip-specific boot/BSL resistors + harness leads | set | Force boot mode for read | DIY per target |
| Transponder pod (opt) | Your `transponder-reader` (EM4095 LF) | 1 | Lawful read of *your* immo/keys | **have (project)** |

> **Honest limit:** modern locked automotive MCUs (e.g. Infineon **Tricore** EDC17/MED17,
> encrypted/RSA-signed) are **not fully open**. Open JTAG/BDM covers older/unlocked MCUs
> and serial memory; Tricore-class internal reads often need proprietary boot tricks and
> may be **partially out of reach**. We build what is reachable and are honest about the rest.

### 3.6 FRONTIER — DoIP / Automotive Ethernet (newest cars, optional)

| Item | Spec / suggested part | Qty | Role | Own? |
|---|---|---|---|---|
| 100BASE-T1 media converter | RAD-Moon (Intrepid) or BroadR-Reach media converter | 1 | Bridge car T1 pair ↔ Pi Gigabit Ethernet | buy (pricey) |

> Very few DIY tools reach DoIP. Adding this later is what keeps the device relevant on
> next-decade vehicles. Not needed for CAN/K-line cars.

### 3.7 INSTRUMENTATION & ENCLOSURE

| Item | Spec / suggested part | Qty | Role | Own? |
|---|---|---|---|---|
| Logic analyzer | 8–16 ch (Saleae clone / DSLogic) | 1 | Debug SPI/UART/CAN at the wire | have? |
| Scope | USB or handheld, ≥ 20 MHz, 2-ch | 1 | CAN differential / K-line waveforms | bench |
| Bench PSU | Adjustable, current-limited (for DUT 12 V) | 1 | Power a pulled module safely | have |
| Enclosure | Project case big enough for Pi+HAT+pods, standoffs | 1 | Make it a *device*, not a rat's nest | buy |
| Front-panel connectors | Keyed automotive conn + banana/BNC jacks + labels | set | Prevent 12 V-into-signal mistakes | buy |
| ESD mat + strap | | 1 | Chip handling | **have** |

---

## 4. Subsystem build & wiring

### 4.1 CAN core (the HAT)

1. Seat the **2-CH Isolated CAN-FD HAT** on the Pi 40-pin header.
2. It uses **SPI0**, chip-selects **CE0/CE1**, and two interrupt GPIOs. **Confirm the
   exact interrupt GPIOs, oscillator (40 MHz), and termination jumper positions against
   the Waveshare wiki for your board revision** — silk/rev varies.
3. **Bus 0 → HS-CAN** (OBD 6 = CANH, 14 = CANL). **Bus 1 → MS-CAN** (commonly OBD 3/11
   on Ford/Mazda; manufacturer-specific — the breakout box lets you re-pin).
4. **Termination:** on a *vehicle* the harness already has 2×120 Ω. On the *bench* with a
   lone module, you must provide it — set the HAT's on-board 120 Ω jumper **or** add a
   120 Ω across CANH/CANL. Getting this wrong = "bus is dead" for no reason.

Because the HAT is **isolated**, the car's CAN ground is galvanically separated from the
Pi/laptop — your ground-loop hazard is handled in hardware. Still run the laptop on
**battery** in a live car as belt-and-suspenders.

### 4.2 K-Line pod (L9637D → USB-UART)

Functional wiring (match numbers to the **L9637D datasheet**, SO-8):

- **VS** ← vehicle **12 V** (through the reverse-polarity + fuse of the main feed).
- **GND** ← common ground.
- **K** ↔ OBD **pin 7**, with a **K-line pull-up (~510 Ω–1 k) to VBAT** and a series/clamp
  for protection. (**L** ↔ OBD pin 15 only if a car needs the L-line for init — rare.)
- **TX** ← USB-UART **TXD** (Pi drives K-line via the chip).
- **RX** → USB-UART **RXD** — **keep this line at the UART's logic level**; if the L9637D
  RX output can exceed 3.3 V, buffer it (the same island rule as the CAN saga).
- **EN** per datasheet (enable).

Firmware/daemon does 5-baud slow-init **or** fast-init, then KWP2000 framing. Your KWP
payload knowledge (7E1/7E9 services) is reused — only the *transport* is new.

### 4.3 Bench-Memory pod (clone reads)

- **In-circuit:** SOIC clip → PicoForge (3.3 V-safe) for a live read without desoldering.
  Confirm the host board isn't fighting the clip (may need to isolate/hold the module MCU
  in reset, or desolder if contention).
- **Desoldered:** hot-air the chip, seat in a ZIF adapter → **T48** for the widest library.
- **Always:** read → checksum → archive as the **donor image** before any thought of a
  write (Ceremony §1).

### 4.4 Bench-MCU pod (internal cloning, advanced)

- ARM/Cortex ECUs: FT2232H + **OpenOCD** over SWD/JTAG.
- Motorola/NXP: your **BDM** `mcu-debugger` harness.
- Boot-mode: pull the target's boot/BSL strap per its datasheet, provide clean 12 V + wake.
- Verify-read-back after any write; never on a sagging supply.

### 4.5 Bench DUT harness (talk to a pulled module)

Many modules won't speak without **ignition + wake**. Build a small harness that provides:
**12 V (fused), ground, an ignition/switched-12 V toggle, CANH/CANL (+120 Ω), and K-line**,
mapped to the module's connector or via micro-hook probes. This is the difference between
"module is dead" and "module just wasn't woken."

---

## 5. Front panel / enclosure

Make it a **device**: everything routed to a labeled, keyed panel.

- **OBD-II port** (female) → internal breakout → routed to HAT (HS/MS) + K-line pod.
- **Keyed automotive connector** for the vehicle 12 V feed (so you can't reverse it).
- **Banana/BNC taps** for CANH/CANL/K-line/12 V/GND to probe with scope/LA.
- **Termination jumpers** on the panel (bench vs vehicle).
- **USB bench ports** exposed for T48 / PicoForge / JTAG pods.
- **Status LEDs**: power-OK, each bus active, write-armed (from the Ceremony interlock).
- **Label every connector.** A mislabeled 12 V-into-signal is a dead chip.

---

## 6. (removed — merged into §7)

## 7. Power & grounding (the part that quietly kills builds)

- **Bench:** Pi on its 27 W PSU; DUT on the adjustable, current-limited bench PSU.
- **Vehicle:** 12 V → fuse → reverse-polarity P-MOSFET → load-dump TVS → **5 V/5 A buck** →
  Pi (via UPS). Pi 5 wants a stiff 5 V; a 3 A buck will brown out — size for **5 A**.
- **UPS ride-through:** cranking drops battery to ~9 V for tenths of a second. The UPS/
  supercap keeps the Pi alive and, critically, **lets it shut down cleanly** on power loss.
  Pull the plug on a running Linux box repeatedly and you *will* corrupt the SD/NVMe.
  Wire the UPS "power-failing" line to a GPIO → clean-shutdown service.
- **Grounding:** single common ground on the controller side; the **isolated HAT** breaks
  the bus ground loop; laptop on battery in a live car.
- **Software interlock:** the daemon refuses to arm a write unless supply is within window.

---

## 8. Software stack (hardware-relevant summary)

- **OS:** Raspberry Pi OS 64-bit (Bookworm). Consider read-only rootfs / overlayfs for
  field robustness.
- **SocketCAN** via `/boot/firmware/config.txt` (confirm against Waveshare wiki):
  ```
  dtparam=spi=on
  dtoverlay=mcp251xfd,spi0-0,interrupt=<GPIO_for_CAN0>
  dtoverlay=mcp251xfd,spi0-1,interrupt=<GPIO_for_CAN1>
  ```
  Bring up: `sudo ip link set can0 up type can bitrate 500000 dbitrate 2000000 fd on`
  (classic HS: `bitrate 500000`; MS: `bitrate 125000`).

### 8.1 AS-CONFIGURED — Waveshare isolated 2-CH HAT on Pi 5 (verified 2026-07-10)

The generic two-`spi0` skeleton above did **not** work for this board on a Pi 5.
Key facts learned on the bench:

- The Waveshare **isolated** 2-CH CAN-FD HAT selects **Mode A (two separate SPI
  buses) by default**, set by four **0 Ω solder-jumpers** (item 13). CAN_0 → SPI0/CE0,
  **CAN_1 → SPI1** (GPIO 18/19/20/21). Mode B (shared SPI0 CE0/CE1) would need
  desoldering — avoided.
- On **Pi 5**, `dtoverlay=mcp251xfd,spi1-0` does **not** bring up the aux SPI1 (its
  pinctrl isn't RP1-ready), so CAN_1 never enumerated. `dtoverlay=spi1-1cs` *does*
  enable SPI1 — proving the bus works — so a **custom overlay** was written that
  enables SPI1 the same way and binds the mcp251xfd at CS0.
- **`dtparam=audio=off`** is required — onboard I2S otherwise holds GPIO 18–21.

Working `/boot/firmware/config.txt` tail:
```
dtparam=audio=off
dtparam=spi=on
dtoverlay=mcp251xfd,spi0-0,interrupt=25      # can0 = HS-CAN (SPI0 CE0)
dtoverlay=mcp-can1-spi1                        # can1 = MS-CAN (SPI1, custom overlay)
```
Custom overlay source + the web UI live in `hardware/super-device/webui/`
(`mcp-can1-spi1.dts` documented there). Both channels pass internal loopback.
- **Libraries:** `python-can`, kernel `can-isotp`, `udsoncan` (full UDS/ISO-14229 incl.
  SecurityAccess + RequestDownload/TransferData for lawful reflash), `cantools` (DBC/ARXML
  decode into named signals), `can-utils` (candump/canplayer for capture+replay).
- **Daemon:** systemd service that answers your **existing command protocol** (INFO,
  CANDUMP, ISOTP, OBD, CANBUS, SPEED…) backed by SocketCAN — the drop-in `.ino` replacement.
  The **Cloning Ceremony write gate lives here.**
- **App link:** Pi **USB-gadget serial** first (laptop sees a COM port, `picoSerial.ts`
  barely changes) → add a streaming **network socket** later for live decode + remote.
- **Version control:** the daemon + overlays live in git; the knowledge base keeps
  travelling with your publishes (unchanged).

---

## 9. "Did we miss anything?" register

Every item here is a thing real builds forget. All are addressed above.

- [x] **SD/NVMe corruption on power loss** → UPS/supercap + clean-shutdown GPIO (§7)
- [x] **Bench CAN termination** (no vehicle harness) → 120 Ω jumpers (§4.1)
- [x] **Reverse polarity + load dump** on 12 V feed → P-MOSFET + TVS + fuse (§7)
- [x] **Ground loop** laptop↔car → isolated HAT + laptop on battery (§4.1/§7)
- [x] **Thermal** in a hot car → Pi 5 active cooler (§3.1)
- [x] **Offline timestamps** → RTC + battery (§3.2)
- [x] **Module won't talk without ign/wake** → bench DUT harness (§4.5)
- [x] **Cranking brown-out during flash** → UPS ride-through + supply interlock (§7/§8)
- [x] **12 V into a signal pin** → keyed, labeled front panel (§5)
- [x] **Donor archive / rollback** before writes → Ceremony (§1)
- [x] **Immo/security boundary** → charter + software gate (§1)
- [x] **Legacy coverage** (J1850, SW-CAN, ISO9141, LIN) → pods (§3.3)
- [x] **Modern coverage** (CAN-FD now, DoIP later) → HAT + T1 converter (§3.1/§3.6)
- [x] **Verify-read-back + checksum** after every write → procedure (§1/§4.3)
- [x] **Header contention** from stacking HATs → USB-pod architecture (§2)
- [ ] **ESD discipline** for chip handling → mat/strap (have) — *habit, not hardware*
- [ ] **Consent/authorization record** per job → keep a written log — *process*

Open honest gaps: **Tricore-class locked MCUs** (§3.5) are only partially reachable;
**DoIP** (§3.6) is a later, pricier module.

---

## 10. Phased build order (build as gear arrives — your style)

- **Phase 1 — Core reader.** Pi 5 + CAN-FD HAT + SocketCAN + daemon speaking your
  protocol. Bring HS+MS up, isolated, no level shifters ever again. App plugs in via
  USB-gadget serial. *Milestone: read the bench TCM on both buses through the Pi.*
- **Phase 2 — Power & survival.** Automotive buck (5 A) + UPS + protection + RTC + case.
  *Milestone: run off car power, survive a crank, clean-shutdown on unplug.*
- **Phase 3 — K-Line pod.** L9637D + USB-UART + KWP init. *Milestone: read a K-line car.*
- **Phase 4 — Bench-Memory domain.** Integrate T48 + PicoForge + quality clips as USB
  pods; wire the Ceremony write gate. *Milestone: archive a donor memory image, verified.*
- **Phase 5 — Live decode + AI firehose.** Network socket + `cantools` DBC decode feeding
  Vehicle Intelligence. *Milestone: AI maps a full bus from decoded live traffic.*
- **Phase 6 — Frontier.** LIN / extra USB-CAN / J1850-SW-CAN / DoIP / Bench-MCU as needed.

---

## 11. OBD-II (J1962) pinout reference

| Pin | Signal | Pin | Signal |
|---|---|---|---|
| 1 | Mfr (often GM SW-CAN/GMLAN) | 9 | Mfr |
| 2 | J1850 Bus+ (VPW/PWM) | 10 | J1850 Bus− (PWM) |
| 3 | Mfr (often Ford/Mazda **MS-CAN+**) | 11 | Mfr (Ford/Mazda **MS-CAN−**) |
| 4 | Chassis ground | 12 | Mfr |
| 5 | Signal ground | 13 | Mfr |
| 6 | **HS-CAN High** (ISO 15765) | 14 | **HS-CAN Low** |
| 7 | **K-Line** (ISO 9141 / 14230) | 15 | L-Line (rare) |
| 8 | Mfr | 16 | **Battery +12 V** (always hot) |

---

## 12. Build state (living AS-BUILT — check off as built)

| Subsystem | State | Notes |
|---|---|---|
| Pi 5 + OS + SocketCAN | ☑ | Bookworm 64-bit, kernel 6.18, can-utils, headless SSH. 2026-07-10. |
| 2-CH CAN-FD HAT (HS+MS) | ☑ | can0=SPI0/INT25 (HS), can1=SPI1/INT24 (MS) via custom Mode-A overlay (§8.1). Both loopback-PASS. |
| Web control panel (CAN UI) | ☑ | `hardware/super-device/webui/`; systemd `superdevice-ui`; http://superdevice.local:8080. 2026-07-10. |
| Daemon speaking legacy protocol | ☐ | drop-in `.ino` replacement |
| App link (USB-gadget serial) | ☐ | |
| Power: buck 5 A + UPS + protection + RTC | ☐ | |
| Enclosure + keyed front panel | ☐ | |
| K-Line pod | ☐ | |
| LIN pod | ☐ | optional |
| Extra USB-CAN bus 3/4 | ☐ | optional |
| Bench-Memory: T48 + PicoForge + clips + gate | ☐ | Ceremony wired |
| Bench-MCU: JTAG/SWD + BDM | ☐ | advanced |
| DoIP T1 converter | ☐ | frontier |
| Live decode (cantools) → AI | ☐ | |

---

*This document is the source of truth for the Super Device. Update §12 as you build,
and add any newly discovered gap to §9 — the register is meant to grow.*
