/**
 * Shared types for per-chip assets (operator-uploaded instruction/schematic
 * images) and the AI-generated connection & soldering guide. Pure types with no
 * runtime deps so both the Electron main process and the renderer can import
 * them from @ecu/chip-db.
 */

export type ChipAssetKind =
  | "instruction"
  | "schematic"
  | "pinout"
  | "solder"
  | "photo"
  | "other";

export interface ChipAsset {
  id: string;
  fileName: string;
  kind: ChipAssetKind;
  mediaType: string;
  sizeBytes: number;
  savedAt: string;
  caption?: string;
}

export interface ChipWiringRow {
  /** Chip pin number/name, e.g. "1 (CS)". */
  pin: string;
  /** Signal/role, e.g. "Chip select". */
  signal: string;
  /** Where it connects on the tool, e.g. "PicoForge GP17 / CS". */
  connectTo: string;
  /** Optional caveat for this pin. */
  note: string;
}

export interface ChipConnectGuide {
  summary: string;
  /** How to physically locate pin 1 on this package. */
  pin1: string;
  wiring: ChipWiringRow[];
  /** ASCII top-view pinout the operator can eyeball against the part. */
  asciiPinout: string;
  soldering: string[];
  cautions: string[];
  /** Tool-specific notes (PicoForge / T48 / debug probe). */
  toolNotes: string;
  /** ISO-8601 timestamp the guide was generated. */
  generatedAt: string;
  /** Model id that produced it. */
  model: string;
}
