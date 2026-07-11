/**
 * Vehicle Profile — the unit the library is keyed on: one YEAR / MAKE / MODEL.
 *
 * A profile bundles everything we know about a vehicle so that the NEXT time we
 * plug into one, a VIN decode can find it and load the whole map instantly —
 * skipping AI re-mapping. Profiles are the "memory that travels with publishes":
 * seed (ships) + learned (disk) + community (baked), same pattern as bus knowledge.
 *
 * Renderer + node safe. Reuses `RiskLevel` from the bus schema; its own category
 * enum is named `VehicleSystemCategory` to avoid colliding with the barrel's
 * `ModuleCategory` (from moduleProfile.schema).
 */

import type { RiskLevel } from "./busKnowledge.schema.js";

export type BodyType =
  | "sedan" | "suv" | "truck" | "van" | "minivan" | "hatchback" | "coupe" | "wagon";

export type VehicleSystemCategory =
  | "powertrain" | "transmission" | "chassis" | "body" | "infotainment"
  | "safety" | "network" | "hvac" | "other";

/** Where a module physically lives — used to place its hotspot on the 3D mesh. */
export type ModuleLocation =
  | "engine" | "cabin_front" | "cabin_rear" | "dash" | "trunk"
  | "front_left" | "front_right" | "rear_left" | "rear_right"
  | "wheel_fl" | "wheel_fr" | "wheel_rl" | "wheel_rr" | "roof" | "underbody";

export type VehicleProfileSource = "seed" | "bench_observed" | "ai_suggested" | "vin_decoded" | "user" | "community";

export interface VehicleBus {
  id: string;                 // "hs-can" | "ms-can" | "k-line" | ...
  label: string;              // "HS-CAN (powertrain)"
  protocol: "CAN" | "CAN-FD" | "K-Line" | "J1850" | "SW-CAN" | "LIN" | "DoIP";
  bitrate: number;            // bps (0 for non-CAN where N/A)
  obdPins?: string;           // "6/14"
}

/** Brand-correct identifying evidence for one module — overrides the generic
 * sample values on the shared ModuleTemplate so each make carries its real
 * supplier and part-number scheme (the strongest signal the AI mapper reads). */
export interface ModuleIdentity {
  supplier: string;   // e.g. "Bosch" | "ZF" | "Continental" | "Hitachi"
  partNo: string;     // brand part-number scheme → DID F187
  sw?: string;        // software version → F195
  hw?: string;        // hardware number → F191
  serial?: string;    // serial → F18C
}

export interface VehicleModule {
  id: string;                 // "ecm" | "tcm" | "abs" | ...
  label: string;              // "Engine Control Module"
  category: VehicleSystemCategory;
  bus: string;                // VehicleBus.id it lives on
  location: ModuleLocation;   // 3D hotspot placement
  addressing?: { request?: string; response?: string }; // e.g. "7E0" / "7E8"
  identity?: ModuleIdentity;  // brand-correct supplier + part numbers (per-vehicle overlay)
  online?: boolean;           // runtime flag (not persisted in seed)
  busKnowledgeId?: string;    // links to a BusModuleKnowledge entry (AI/bench detail)
}

export interface VehicleCapability {
  id: string;
  label: string;              // "Read stored DTCs"
  category: VehicleSystemCategory | "diagnostic";
  risk: RiskLevel;            // read = always safe; write/caution gated by the Ceremony
  bus: string;                // which bus
  module?: string;            // target module id
  sequence: string[];         // ordered request commands (e.g. ["10 81", "19 02 FF"])
  note?: string;
}

export interface VehicleProvenance {
  source: VehicleProfileSource;
  confidence: number;         // 0..1
  createdAt: string;          // ISO
  updatedAt?: string;
  model?: string;             // AI model, if ai_suggested
  observedOn?: string;        // e.g. bench VIN / plate (user's own)
  contributor?: string;       // for community entries
}

export interface VehicleProfile {
  id: string;                 // stable slug, e.g. "2020-toyota-corolla"
  year: number | null;
  make: string;
  model: string;
  trim?: string;
  bodyType: BodyType;
  market?: string;            // "US" | "EU" | ...
  wmi?: string[];             // WMIs that map here (VIN → profile fast path)
  vinPattern?: string;        // optional regex over full VIN for finer matches
  buses: VehicleBus[];
  modules: VehicleModule[];
  supportedPids?: number[];   // standard J1979 PIDs known present
  capabilities: VehicleCapability[];
  notes?: string;
  provenance: VehicleProvenance;
}

// ---- helpers -------------------------------------------------------------

/** Stable id from identity. */
export function profileId(year: number | null, make: string, model: string): string {
  return [year ?? "unknown", make, model]
    .join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** Does this profile match a decoded VIN? WMI first, then optional regex. */
export function profileMatchesVin(p: VehicleProfile, vin: string, wmi: string): boolean {
  if (p.wmi && p.wmi.includes(wmi)) return true;
  if (p.vinPattern) {
    try { return new RegExp(p.vinPattern, "i").test(vin); } catch { /* bad pattern */ }
  }
  return false;
}

/** Match by identity (year/make/model), case-insensitive; year optional. */
export function profileMatchesYmm(p: VehicleProfile, year: number | null, make: string, model: string): boolean {
  const eq = (a?: string | null, b?: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  const yearOk = year == null || p.year == null || p.year === year;
  return yearOk && eq(p.make, make) && eq(p.model, model);
}

export function validateVehicleProfile(p: Partial<VehicleProfile>): string[] {
  const errs: string[] = [];
  if (!p.id) errs.push("missing id");
  if (!p.make) errs.push("missing make");
  if (!p.model) errs.push("missing model");
  if (!p.bodyType) errs.push("missing bodyType");
  if (!Array.isArray(p.buses) || p.buses.length === 0) errs.push("no buses");
  if (!Array.isArray(p.modules)) errs.push("modules must be an array");
  if (!p.provenance) errs.push("missing provenance");
  return errs;
}
