# MCU Debugger / Internal-Memory Reader — Build & Solder Guide (Layer 3, Phase F)

A **level-shifted, Vref-referenced, protected** breakout that connects a debug
probe to an ECU's microcontroller and reads its **internal flash / EEPROM** over
**SWD / JTAG / BDM / serial-bootloader**. The probe brain is a **Raspberry Pi
Pico** (or an FT232H). This is the doorway to byte-exact internal-MCU cloning.

> ⚖️ **Lawful recovery only.** For reading modules you own / are authorized to
> service — burned-ECU clone-to-donor. It is the *physical interface*; it does not
> defeat a chip's read-protection (that is chip-specific and out of scope).

> 🔌 **Two voltage domains, always.** The probe is 3.3 V; targets run 1.8 / 3.3 /
> 5 V. **Every** target line goes through a level shifter whose HV side tracks the
> target's **VTref**, plus a series resistor. Connect 3.3 V straight to a 1.8 V
> core and you kill the ECU. Match the domains.

---

## Bill of materials

**Brain — pick one:**
- **Raspberry Pi Pico** + `debugprobe` firmware → CMSIS-DAP (SWD; JTAG via Free-DAP)
- **FT232H / FT2232H** breakout → OpenOCD (JTAG/SWD for the widest target set)

**Interface board:**
| Ref | Part | Job |
| --- | --- | --- |
| U1,U2 | **2× 4-ch BSS138 level shifter** (AITIAO) | 3.3 V ↔ target VTref, 8 lines |
| R1–R8 | **33–100 Ω** series, one per target line | protection / signal integrity |
| Rp | **10 kΩ** pull-ups on TMS, TCK, nRESET, BKGD | idle-state defaults |
| J1 | ARM **Cortex Debug 10-pin** (1.27 mm) | SWD + JTAG |
| J2 | **JTAG 20-pin** (2.54 mm) | legacy JTAG |
| J3 | **BDM 6-pin** (2×3, 2.54 mm) | Freescale S12/HC12 |
| J4 | **BSL/UART 6-pin** | boot pin + TX/RX/RESET |

---

## Probe pin map (Pico brain)

| Pico | Line | Goes to (via shifter + series R) |
| --- | --- | --- |
| GP2 | TCK / SWCLK | target clock |
| GP3 | TMS / SWDIO | target mode / SWD data |
| GP4 | TDI | JTAG data in |
| GP5 | TDO / SWO | JTAG data out / SWD trace |
| GP6 | nRESET | target reset |
| GP7 | nTRST / BKGD | JTAG reset **or** BDM single-wire (jumper) |
| GP0 | UART_TX | → target bootloader RX |
| GP1 | UART_RX | ← target bootloader TX |
| 3V3 | shifter LV | probe-side reference |
| GND | common | tie probe + board + target grounds |

> The HV side of both shifters is **VTref from the target** — the board adapts to
> whatever the MCU runs at. Never assume 3.3 V.

## Connector pinouts (solder J1–J4 to these)

**J1 — ARM Cortex Debug (10-pin, 1.27 mm):**
```
 1 VTref      2 SWDIO/TMS
 3 GND        4 SWCLK/TCK
 5 GND        6 SWO/TDO
 7 KEY(n/c)   8 TDI
 9 GNDDetect 10 nRESET
```
**J3 — BDM (6-pin, Freescale S12/HC12):**
```
 1 BKGD   2 GND
 3 n/c    4 nRESET
 5 n/c    6 VDD (VTref sense)
```
**J4 — BSL / UART:** `VTref · TX · RX · BOOT · nRESET · GND`
(pull/strap **BOOT** to enter the on-chip serial bootloader.)

## Target families & how you read them
| MCU family (typical ECU) | Interface | Tool |
| --- | --- | --- |
| ARM Cortex-M (many newer modules) | **SWD** | debugprobe + OpenOCD/pyOCD |
| Infineon **TriCore** (Bosch MED17/EDC17) | **JTAG/DAP** | FT232H + OpenOCD |
| NXP/Freescale **S12/HC12** | **BDM** (BKGD) | OpenOCD / usbdm |
| Power Arch **MPC55xx/56xx** (ME9/EDC16) | **JTAG/Nexus** | FT232H + OpenOCD |
| ST / Renesas / others | **serial BSL** | strap BOOT, talk UART |

> Read-protected ECUs need a chip-specific unlock / boot-mode procedure before
> the memory is readable — that is per-MCU homework, not a wiring problem.

## Build order
1. Solder the **two level shifters**: LV → Pico 3V3, GND common, **HV → VTref**.
2. Solder **series resistors** (one per line) between shifter HV and each connector.
3. Add **pull-ups** on TMS/TCK/nRESET/BKGD.
4. Wire the **connectors** J1–J4 to the matching shifter HV lines per the maps above.
5. **BKGD/TRST jumper:** route GP7 to either J3-BKGD *or* J2/J1-TRST — never both at once.

## Test plan
1. **Continuity / domains:** with no target, confirm LV side = 3.3 V; HV side
   follows an injected VTref (try 1.8 / 3.3 / 5 V) and the shifter passes it.
2. **ARM target first:** flash `debugprobe`, connect a 3.3 V Cortex-M dev board to
   J1, run `openocd -f interface/cmsis-dap.cfg -f target/<mcu>.cfg` → halt → dump
   flash. That proves the whole chain.
3. **Move up** to JTAG (FT232H + OpenOCD) and BDM as your targets require.
