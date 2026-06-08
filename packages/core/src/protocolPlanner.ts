import type { ProgrammerAdapter } from "@ecu/adapters";
import type { ChipProfile, ChipPin } from "@ecu/chip-db";

export interface WireMapping {
  chipPin: number;
  chipPinName: string;
  chipRole: ChipPin["role"];
  adapterSignal: string;
  /** Optional note shown next to the row in the Pinout Viewer. */
  note?: string;
}

export interface OperationPlan {
  chipProfileId: string;
  adapterId: string;
  protocol: ChipProfile["protocol"];
  wiring: WireMapping[];
  /** Free-form human steps for the wiring/safety checklist. */
  steps: string[];
}

const SPI_SIGNALS: Record<string, string> = {
  chip_select: "CS",
  miso: "MISO",
  mosi: "MOSI",
  clock: "SCK",
  power: "VCC",
  ground: "GND",
  write_protect: "→ tie HIGH (VCC) via 10 kΩ",
  hold: "→ tie HIGH (VCC) via 10 kΩ",
};

const I2C_SIGNALS: Record<string, string> = {
  sda: "SDA (with 4.7 kΩ pull-up to VCC)",
  scl: "SCL (with 4.7 kΩ pull-up to VCC)",
  power: "VCC",
  ground: "GND",
  write_protect: "→ tie LOW (GND) for read-only sessions",
  address: "→ tie to GND for slave address 0",
};

const MICROWIRE_SIGNALS: Record<string, string> = {
  chip_select: "CS (active high)",
  clock: "SK",
  di: "DI",
  do: "DO",
  power: "VCC",
  ground: "GND",
  org: "→ tie LOW for x8, HIGH for x16",
  nc: "leave floating",
};

export class ProtocolPlanner {
  plan(chip: ChipProfile, adapter: ProgrammerAdapter): OperationPlan {
    const map = pickSignalMap(chip.protocol);
    const wiring: WireMapping[] = chip.pinout.map((pin) => ({
      chipPin: pin.pin,
      chipPinName: pin.name,
      chipRole: pin.role,
      adapterSignal: map[pin.role] ?? "—",
      ...(pin.note ? { note: pin.note } : {}),
    }));

    return {
      chipProfileId: chip.chipProfileId,
      adapterId: adapter.adapterId,
      protocol: chip.protocol,
      wiring,
      steps: buildSteps(chip, adapter),
    };
  }
}

function pickSignalMap(protocol: ChipProfile["protocol"]): Record<string, string> {
  switch (protocol) {
    case "spi":
      return SPI_SIGNALS;
    case "i2c":
      return I2C_SIGNALS;
    case "microwire":
      return MICROWIRE_SIGNALS;
    default:
      return {};
  }
}

function buildSteps(chip: ChipProfile, adapter: ProgrammerAdapter): string[] {
  const steps: string[] = [
    `Confirm the chip is ${chip.displayName} (${chip.package}, ${chip.protocol.toUpperCase()}, ${chip.sizeBytes} bytes).`,
    `Power down the target before any wiring change.`,
    `Connect ground first; ${chip.voltage.typical} V supply last.`,
  ];
  if (chip.protocol === "spi") {
    steps.push("Tie HOLD high and WP high before applying power.");
  }
  if (chip.protocol === "i2c") {
    steps.push("Verify 4.7 kΩ pull-up resistors on SDA and SCL.");
  }
  if (adapter.canMeasureVoltage) {
    steps.push("Measure VCC on the chip before issuing any command.");
  }
  steps.push("Run Read 1, then Read 2; do not write until SHA-256 matches.");
  return steps;
}
