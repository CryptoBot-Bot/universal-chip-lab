/**
 * Module census — the pure half. After a discovery scan the AI names every
 * responder (the census itself runs in the node side, electron/resolver/
 * vehicleIdentifier.ts); these two functions build its input from a profile and
 * fold its answer back in. They live here so the cockpit UI and the
 * command-line runner apply a census the exact same way. Browser + node safe.
 */

import type { DiscoveredModuleInput, ModuleLocation, VehicleModule, VehicleProfile, VehicleSystemCategory } from "./vehicleProfile.schema.js";

/** One module as the census names it (mirrors the electron CensusModule). */
export interface CensusModuleInput {
  responseId: string;
  label: string;
  category: string;
  supplier?: string;
  summary: string;
  protocol: "uds" | "kwp2000" | "obd2" | "unknown";
  memoryRead: "obd" | "obd_partial" | "bench";
}

/** Where a module of each category sits on the 3D car until someone places it better. */
export const CENSUS_LOCATION_FOR: Record<string, ModuleLocation> = {
  powertrain: "engine", transmission: "engine", chassis: "underbody", body: "dash", infotainment: "dash",
  safety: "cabin_front", network: "dash", hvac: "dash", other: "cabin_front",
};

const respNorm = (s?: string) => (s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");

/** What the census is asked: the vehicle, every responder with what it said it
 * was, and the modules the library already names (so it keeps those identities). */
export function censusInputFor(profile: VehicleProfile, discovered: DiscoveredModuleInput[]) {
  return {
    vehicle: { year: profile.year, make: profile.make, model: profile.model, trim: profile.trim, engine: profile.decoded?.engine },
    ecus: discovered.map((f) => ({ responseId: f.responseId.toUpperCase(), requestId: f.requestId, label: f.name, ...(f.ident ?? {}) })),
    known: profile.modules
      .filter((m) => m.addressing?.response && !m.id.startsWith("resp-"))
      .map((m) => ({ responseId: respNorm(m.addressing!.response), label: m.label, category: m.category })),
  };
}

/**
 * Fold a census into a profile's module list. A stub (a `resp-*` module, or one
 * never censused) takes the census's name, category and default location; a
 * module that already has an identity keeps it and only gains the summary /
 * protocol / memory-read estimate. Pure — returns a new profile.
 */
export function applyCensus(profile: VehicleProfile, census: CensusModuleInput[], now: string): VehicleProfile {
  const byResp = new Map(census.map((c) => [respNorm(c.responseId), c]));
  const modules = profile.modules.map((m): VehicleModule => {
    const c = byResp.get(respNorm(m.addressing?.response));
    if (!c) return m;
    const stub = m.id.startsWith("resp-") || !m.summary;
    return {
      ...m,
      label: stub ? c.label : m.label,
      category: (stub ? c.category : m.category) as VehicleSystemCategory,
      location: stub ? (CENSUS_LOCATION_FOR[c.category] ?? m.location) : m.location,
      summary: c.summary, protocol: c.protocol, memoryRead: c.memoryRead, censusAt: now,
      identity: m.identity ? { ...m.identity, supplier: m.identity.supplier || c.supplier || "" } : (c.supplier ? { supplier: c.supplier, partNo: "" } : m.identity),
    };
  });
  return { ...profile, modules };
}
