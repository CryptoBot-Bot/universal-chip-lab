import type { ChipProfile } from "./chipProfile.schema.js";
import type { ChipTool } from "./tooling.js";

/**
 * ACCESS TYPE — *how you physically reach a chip's memory*, independent of the
 * tool brand. This is the architectural axis the Chip Database is organised by:
 * it answers "what do I have to do to get bytes in/out of this part?".
 *
 *   serial_clip     — 3/4-wire serial bus, reachable with a SOIC clip or socket.
 *   parallel_socket — wide address+data bus, needs a universal-programmer socket.
 *   debug_port      — live in-circuit MCU debug (JTAG/SWD/BDM).
 *   bootloader      — the MCU's factory boot ROM over UART/bootstrap.
 */
export type AccessType = "serial_clip" | "parallel_socket" | "debug_port" | "bootloader";

export interface WiringStep {
  step: string;
}

export interface AccessTypeGuide {
  id: AccessType;
  label: string;
  icon: string;
  tagline: string;
  /** The tool that primarily drives this access type (see tooling.ts). */
  primaryTool: ChipTool;
  /** Buses/protocols this access type covers. */
  buses: string[];
  /** Plain-language "when does a chip land here". */
  whenToUse: string;
  /** Generic step-by-step connection guidance (the per-chip AI guide refines it). */
  steps: string[];
  /** Safety cautions specific to this access method. */
  cautions: string[];
  /** "Build your own magic box": what to buy + how to assemble a rig for this access type. */
  buildYourRig: {
    /** Shopping list. */
    bom: string[];
    /** Assembly / bring-up steps. */
    assembly: string[];
  };
}

/** Maps a chip profile to its access type from family + protocol. */
export function accessTypeForChip(profile: ChipProfile): AccessType {
  switch (profile.family) {
    case "24xxx_i2c_eeprom":
    case "25xxx_spi_eeprom":
    case "93xxx_microwire_eeprom":
    case "spi_nor_flash":
      return "serial_clip";
    case "parallel_nor_flash":
    case "parallel_eeprom":
    case "parallel_eprom":
    case "nand_flash":
      return "parallel_socket";
    case "mcu_internal_flash":
    case "mcu_internal_eeprom":
      return profile.protocol === "uart" ? "bootloader" : "debug_port";
  }
}

export const ACCESS_TYPES: readonly AccessTypeGuide[] = [
  {
    id: "serial_clip",
    label: "Serial — clip / socket",
    icon: "📎",
    tagline: "3-/4-wire serial memory you can reach with a clip — often no desolder needed.",
    primaryTool: "picoforge",
    buses: ["SPI", "I²C", "Microwire"],
    whenToUse:
      "24Cxx I²C, 25xx / M95 SPI EEPROM, 93Cxx Microwire, and 25-series SPI NOR flash — the bulk of ECU, cluster, BCM and immobiliser memory.",
    steps: [
      "Find pin 1 (dot or bevel) and meter VCC↔GND BEFORE applying any power.",
      "Clip an SOIC-8 test clip onto the chip, or seat it in a clamshell socket (more reliable than cheap clips).",
      "Wire CS · CLK · DI(MOSI) · DO(MISO) per the pinout. SPI: tie WP and HOLD HIGH. I²C: tie WP LOW.",
      "I²C only: add 4.7 kΩ pull-ups on SDA & SCL, and tie A0/A1/A2 to GND (address 0x50).",
      "Power at 3.3 V, read TWICE, and SHA-compare the two reads before trusting or writing.",
    ],
    cautions: [
      "Never reverse the clip — flipping an 8-pin chip swaps VCC↔GND and can cook it.",
      "All-0x00 read = clock too fast or HOLD floating, NOT a blank chip (blank reads 0xFF).",
      "3.3 V only on PicoForge/CH347 — a 5 V CH341A can destroy 3.3 V parts.",
    ],
    buildYourRig: {
      bom: [
        "Raspberry Pi Pico (RP2040) — the brain. (You already built this: PicoForge.)",
        "SOIC-8 test clip (Pomona 5250-style) AND a clamshell SOIC-8 ZIF socket — sockets beat clips for reliability.",
        "2× 4.7 kΩ resistors (I²C pull-ups), Dupont jumpers, a half breadboard.",
        "Optional: a 4-channel level shifter for 5 V parts, an SSD1306 OLED for the panel.",
      ],
      assembly: [
        "Flash PicoForge firmware (MicroPython UF2 + the .py files via Thonny).",
        "Wire SPI: CS=GP17 · SO=GP16 · SI=GP19 · SCK=GP18 · 3V3 · GND. I²C: SDA=GP26 · SCL=GP27 + 4.7k pull-ups.",
        "Continuity-check each chip LEG → Pico pin BEFORE power (avoid the IDC-vs-chip numbering trap).",
        "Connect over USB, select PicoForge in the app, and read a known chip to validate.",
      ],
    },
  },
  {
    id: "parallel_socket",
    label: "Parallel — ZIF socket",
    icon: "🧩",
    tagline: "Wide address + data bus parts that need a universal-programmer socket.",
    primaryTool: "t48",
    buses: ["Parallel NOR / EEPROM", "EPROM", "NAND"],
    whenToUse:
      "27Cxx EPROM, 28Cxx parallel EEPROM, 29F / 39SF parallel NOR, and TSOP NAND — older ECU program & map memory with dozens of bus pins.",
    steps: [
      "Desolder the chip (or use an in-circuit adapter) — a 4-wire clip cannot reach an address/data bus.",
      "Seat it in the T48 ZIF socket; PLCC/TSOP packages need the matching adapter — mind the pin-1 chamfer.",
      "Select the EXACT device in the programmer software (T48/minipro) and verify the chip ID first.",
      "Read twice and compare. Windowed (CERDIP) EPROM is UV-erase only; plastic OTP can't be erased at all.",
    ],
    cautions: [
      "Pin-1 orientation in the socket is the #1 mistake — double-check the chamfer/dot.",
      "Many parallel parts are 5 V — confirm the voltage before powering.",
      "NAND dumps include spare/OOB bytes and bad blocks — a raw dump is not a filesystem.",
    ],
    buildYourRig: {
      bom: [
        "XGecu T48 universal programmer — the heavy lifter for parallel parts.",
        "PLCC-32/44 → DIP and TSOP-40/48 → DIP adapters for the packages you'll meet.",
        "A PLCC extraction tool; a fine-tip iron + hot-air/desolder station to remove chips.",
        "Anti-static mat + wrist strap.",
      ],
      assembly: [
        "Install the T48 software (or use the bundled minipro once integrated).",
        "Desolder the chip or fit the correct adapter; seat in the ZIF, mind the pin-1 chamfer.",
        "Select the exact device, verify the chip ID, then read twice and compare.",
      ],
    },
  },
  {
    id: "debug_port",
    label: "Debug port — JTAG / SWD / BDM",
    icon: "🔌",
    tagline: "Live in-circuit access to a microcontroller's INTERNAL memory.",
    primaryTool: "mcu_debug",
    buses: ["JTAG", "SWD", "BDM"],
    whenToUse:
      "TriCore, HCS12, STM32, SH7058, ST10 — firmware that lives inside the MCU, not on an external memory chip (Phase F).",
    steps: [
      "Locate the debug header/pads: TCK·TMS·TDI·TDO (JTAG), SWCLK·SWDIO (SWD), or BKGD (BDM).",
      "Connect a CH347 / FT2232 or a dedicated probe; share GND and sense the target's VREF voltage.",
      "Run OpenOCD with the correct target config; halt the core, then read the internal flash/EEPROM.",
      "Expect protection: many automotive MCUs need an unlock or boot-mode step, or refuse readback outright.",
    ],
    cautions: [
      "Read-protect (RDP) fuses can block readback entirely — don't try to force past them.",
      "Wrong VREF or pin mapping on a live module can brick it — prove the wiring on a sacrificial board first.",
      "This is the deepest tier (Phase F) — practice before touching a real customer module.",
    ],
    buildYourRig: {
      bom: [
        "Waveshare CH347 (USB→JTAG/SWD/SPI/I²C, 3.3/5 V, fused + ESD-protected) — the planned magic box.",
        "Or an FT2232H breakout / dedicated probe (J-Link; ST-Link for SWD).",
        "Fine jumper leads, pogo pins, or a Tag-Connect cable for debug pads.",
        "A bench PSU to power the target at the correct VREF.",
      ],
      assembly: [
        "Install the CH347 driver (Zadig/WinUSB) and OpenOCD.",
        "Map TCK/TMS/TDI/TDO (or SWCLK/SWDIO) + nRESET + GND; sense VREF.",
        "Run OpenOCD with the target config, halt the core, dump internal flash/EEPROM.",
        "Practice on a sacrificial board before any live module.",
      ],
    },
  },
  {
    id: "bootloader",
    label: "Bootloader / bootstrap (UART)",
    icon: "⌨️",
    tagline: "Enter the chip's factory boot ROM and talk to it over serial.",
    primaryTool: "mcu_debug",
    buses: ["UART", "bootstrap"],
    whenToUse:
      "8051 / PIC / HC11-class parts and the STM32 system bootloader — when there's no open debug port but the silicon has a boot ROM.",
    steps: [
      "Strap the boot/mode pin(s) and reset the part into its ROM bootloader.",
      "Connect a 3.3 V UART (CH347): TX↔RX crossed, common GND, correct baud.",
      "Speak the part's bootloader protocol to read / erase / write the internal memory.",
      "Check for lock/code-protect bits first — they can block readback.",
    ],
    cautions: [
      "Boot-strap levels are part-specific; wrong straps simply won't enter the ROM (no harm, no access).",
      "Code-protect fuses can permanently block reads — confirm the part's state before relying on it.",
    ],
    buildYourRig: {
      bom: [
        "CH347 or any clean 3.3 V USB-UART adapter.",
        "Jumper leads to strap the boot/mode pins; a reset button.",
        "The part's bootloader tool (e.g. STM32CubeProgrammer for the STM32 system bootloader).",
      ],
      assembly: [
        "From the datasheet, identify the boot-strap pins and the UART RX/TX.",
        "Cross TX↔RX, share GND, strap into boot mode, then reset.",
        "Connect the bootloader tool at the correct baud and read / erase / write.",
      ],
    },
  },
] as const;

/** The access guide for a chip. */
export function accessGuideFor(profile: ChipProfile): AccessTypeGuide {
  const id = accessTypeForChip(profile);
  return ACCESS_TYPES.find((a) => a.id === id) ?? ACCESS_TYPES[0]!;
}
