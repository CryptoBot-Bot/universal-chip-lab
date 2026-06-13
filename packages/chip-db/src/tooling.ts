import type { ChipProfile } from "./chipProfile.schema.js";
import { picoModeForChip } from "./picoMode.js";

/**
 * Which bench tool reads/writes a chip. The Chip Database groups by the
 * PRIMARY tool so the operator can see, at a glance, "what do I reach this with".
 *
 *   picoforge  — our Pico universal programmer: serial only (SPI/I²C/Microwire),
 *                3.3 V-safe. The everyday driver.
 *   t48        — XGecu T48 universal programmer: serial + PARALLEL + many MCUs in
 *                a socket (with PLCC/TSOP adapters). The heavy lifter.
 *   mcu_debug  — the mcu-debugger board (BDM/JTAG/SWD/bootloader): the ONLY way
 *                into a microcontroller's internal flash/EEPROM.
 */
export type ChipTool = "picoforge" | "t48" | "mcu_debug";

export interface ToolMeta {
  id: ChipTool;
  label: string;
  blurb: string;
}

export const TOOLS: readonly ToolMeta[] = [
  {
    id: "picoforge",
    label: "PicoForge",
    blurb:
      "Our Pico programmer. Serial memories only — SPI flash, SPI/I²C/Microwire EEPROM. 3.3 V-safe, clip or socket.",
  },
  {
    id: "t48",
    label: "T48 programmer",
    blurb:
      "XGecu universal programmer. Everything PicoForge does PLUS parallel NOR/EEPROM, EPROM, NAND and socketed MCUs (PLCC/TSOP adapters).",
  },
  {
    id: "mcu_debug",
    label: "MCU debugger",
    blurb:
      "The BDM/JTAG/SWD/bootloader board. The only route into a microcontroller's internal flash/EEPROM (Phase F).",
  },
];

export interface ToolCapability {
  tool: ChipTool;
  label: string;
  canRead: boolean;
  canWrite: boolean;
  note?: string;
}

/**
 * All tools that can touch this chip, primary first. A chip can be reachable by
 * more than one tool (e.g. a serial EEPROM by both PicoForge and the T48).
 */
export function toolsForChip(profile: ChipProfile): ToolCapability[] {
  const caps: ToolCapability[] = [];
  const pico = picoModeForChip(profile);

  if (pico) {
    // Serial: PicoForge is primary; the T48 can also do it in a socket.
    const writable = profile.operations.write;
    const microwire5v =
      profile.family === "93xxx_microwire_eeprom"
        ? "Programming/erase needs ≥4.5 V — bench-power; the 3.3 V clip reads fine but may not write."
        : undefined;
    caps.push({
      tool: "picoforge",
      label: `MODE ${pico.mode} · ${pico.label}`,
      canRead: true,
      canWrite: writable,
      ...(microwire5v ? { note: microwire5v } : {}),
    });
    caps.push({
      tool: "t48",
      label: "socket / clip",
      canRead: true,
      canWrite: writable,
      note: "Also works on the T48 if you prefer a ZIF socket.",
    });
    return caps;
  }

  switch (profile.family) {
    case "parallel_nor_flash":
    case "parallel_eeprom":
    case "nand_flash":
      caps.push({
        tool: "t48",
        label: "parallel socket",
        canRead: profile.operations.read,
        canWrite: profile.operations.write,
        note: "Address+data bus via a ZIF/PLCC/TSOP adapter.",
      });
      return caps;
    case "parallel_eprom":
      caps.push({
        tool: "t48",
        label: "parallel socket",
        canRead: true,
        canWrite: false,
        note: "Read-only: UV-erase (windowed) or OTP. Cannot be written by the programmer.",
      });
      return caps;
    case "mcu_internal_flash":
    case "mcu_internal_eeprom":
      caps.push({
        tool: "mcu_debug",
        label: protoLabel(profile),
        canRead: profile.operations.read,
        canWrite: profile.operations.write,
        note: "Internal memory — debug interface only; may be read-protected.",
      });
      return caps;
  }

  return caps;
}

function protoLabel(profile: ChipProfile): string {
  switch (profile.protocol) {
    case "swd": return "SWD";
    case "jtag": return "JTAG / BDM";
    case "uart": return "bootloader";
    default: return profile.protocol.toUpperCase();
  }
}

/** The single recommended tool for a chip (first entry of {@link toolsForChip}). */
export function primaryToolForChip(profile: ChipProfile): ChipTool {
  const caps = toolsForChip(profile);
  return caps.length > 0 ? caps[0]!.tool : "t48";
}
