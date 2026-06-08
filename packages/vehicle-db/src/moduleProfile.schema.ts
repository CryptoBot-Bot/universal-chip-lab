export type VehicleBrand =
  | "VAG"           // VW / Audi / Seat / Skoda
  | "BMW"
  | "Mercedes"
  | "GM"
  | "Ford"
  | "Stellantis"    // Chrysler / Dodge / Jeep / Ram / Fiat
  | "Toyota"
  | "Honda"
  | "Hyundai_Kia"
  | "Nissan"
  | "Subaru"
  | "Mazda"
  | "Volvo"
  | "Other";

export type ModuleCategory =
  | "ECU"   // Engine Control Unit
  | "TCU"   // Transmission Control Unit
  | "BCM"   // Body Control Module
  | "IC"    // Instrument Cluster
  | "IMMO"  // Immobiliser / CAS / EWS / EZS / KESSY
  | "ABS"   // Anti-lock Brakes / ESP
  | "SRS"   // Airbag
  | "HVAC"
  | "RADIO"
  | "AC"    // Air Conditioner (sometimes separate)
  | "OTHER";

export type AccessMethod =
  | "soic_clip"      // External chip, in-circuit clip read
  | "desolder"       // External chip, must be removed
  | "obd_kline"      // OBD-II K-line bootmode
  | "obd_can"        // OBD-II CAN bootmode
  | "bench_boot"     // Bench bootmode (pull boot pins, BSL/BDM)
  | "jtag"
  | "swd"
  | "bdm"
  | "nexus";         // Freescale Nexus debug (MPC56x)

export type CloneAccessibility =
  | "external_only"   // Everything needed lives in external EEPROM / Flash
  | "external_plus_obd_clone"
  | "internal_required"
  | "mixed";

export interface ModuleMemoryRef {
  /** Free-form label used inside the module profile. */
  role:
    | "immo_eeprom"
    | "adaptation_eeprom"
    | "calibration_flash"
    | "main_program_flash"
    | "mcu_internal_flash"
    | "mcu_internal_eeprom"
    | "vin_eeprom"
    | "mileage_eeprom"
    | "secondary_eeprom"
    | "boot_flash"
    | "tracker";
  /** Reference into `@ecu/chip-db` by chipProfileId. */
  chipProfileId: string;
  /** Optional override of how the chip is reached on this PCB. */
  accessMethod: AccessMethod;
  /** Free-form note: where on the PCB, what to expect, gotchas. */
  note?: string;
}

export interface ImmoBindingInfo {
  /** Where the immobiliser pairing data lives on this module. */
  storedIn: "external_eeprom" | "internal_mcu" | "internal_eeprom" | "paired_with_cluster" | "paired_with_immo_box" | "none";
  /** Whether a byte-exact clone of this module's memories yields a working car. */
  clonableByteExact: "yes" | "usually" | "sometimes" | "no" | "depends_on_brand_era";
  /** Free-form notes for the operator. */
  notes: string;
}

export interface ModuleProfile {
  moduleProfileId: string;
  displayName: string;
  brand: VehicleBrand;
  manufacturer: string;            // OEM that built the module: Bosch, Continental, …
  category: ModuleCategory;
  ecuCode?: string;                // "EDC16U34", "MSV80", "ME9.7", …
  partNumberPattern?: string;      // human-readable hint, not a regex
  yearRange: [number, number];
  applications: string[];          // example vehicle fitments

  mcu: {
    family: string;                // "Infineon Tricore", "Freescale MPC555", …
    variants?: string[];           // ["TC1796", "TC1797"]
    package?: string;              // "BGA-292"
    accessMethods: AccessMethod[]; // ordered: easiest to hardest
  };

  memories: ModuleMemoryRef[];
  immo: ImmoBindingInfo;
  cloneAccessibility: CloneAccessibility;
  donorCompatibilityNote: string;
  knownGotchas: string[];

  /** Curation maturity. "verified" = personally bench-confirmed. */
  status: "verified" | "documented" | "placeholder";
}

export type ModuleProfileMap = Record<string, ModuleProfile>;

export function validateModuleProfile(p: unknown): asserts p is ModuleProfile {
  if (typeof p !== "object" || p === null) {
    throw new Error("Module profile must be an object.");
  }
  const m = p as Record<string, unknown>;
  for (const k of [
    "moduleProfileId",
    "displayName",
    "brand",
    "manufacturer",
    "category",
    "yearRange",
    "applications",
    "mcu",
    "memories",
    "immo",
    "cloneAccessibility",
    "donorCompatibilityNote",
    "knownGotchas",
    "status",
  ]) {
    if (!(k in m)) throw new Error(`Module profile missing field: ${k}`);
  }
  if (!Array.isArray(m.memories)) {
    throw new Error("Module profile memories must be an array.");
  }
}
