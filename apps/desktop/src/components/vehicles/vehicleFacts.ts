/**
 * Pure helpers for the Vehicles Database page — turn what the library holds about a
 * year/make/model (its profile, its known VINs, the shop garage) into the facts the
 * B1 page shows. No React, no device access.
 */
import { explorationFaults, protectedModule } from "@ecu/vehicle-db";
import type { CarInventory, InventoryChange, ProtectedVerdict, VehicleModule, VehicleProfile, VehicleScanRecord } from "@ecu/vehicle-db";

import type { GarageVehicle } from "../../lib/api";
import { addressedSystems } from "../../lib/diag";

/** One real unit (VIN) of a model: read here, in the shop garage, or both. */
export interface UnitRow {
  vin: string;
  localReads?: number;
  firstReadAt?: string;
  lastReadAt?: string;
  scans?: VehicleScanRecord[];
  /** This car's module inventory (part numbers, serial numbers…) from its last identity read. */
  inventory?: CarInventory;
  inventoryChanges?: InventoryChange[];
  inGarage: boolean;
  garage?: GarageVehicle;
}

/** One year/make/model: the library profile (if it is mapped here) + every unit of it. */
export interface ModelBucket {
  key: string;
  make: string;
  year: number | null;
  model: string;
  profile: VehicleProfile | null;
  units: UnitRow[];
}

export const makeKeyOf = (make: string) => make.toLowerCase();
export const yearKeyOf = (year: number | null) => String(year ?? "null");
export const modelKeyOf = (model: string) => model.toLowerCase();
export const bucketKey = (make: string, year: number | null, model: string) => `${makeKeyOf(make)}|${yearKeyOf(year)}|${modelKeyOf(model)}`;

export const yearLabel = (y: number | null) => (y == null ? "Unknown year" : String(y));
export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : "—");
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Fold the local library (with each profile's read history) and the shop garage into
 * one year/make/model index, merging units by VIN. */
export function buildBuckets(profiles: VehicleProfile[], garage: GarageVehicle[]): ModelBucket[] {
  const map = new Map<string, ModelBucket>();
  const bucket = (mk: string, y: number | null, md: string) => {
    const k = bucketKey(mk, y, md);
    let b = map.get(k);
    if (!b) { b = { key: k, make: mk, year: y, model: md, profile: null, units: [] }; map.set(k, b); }
    return b;
  };
  for (const p of profiles) {
    const b = bucket(p.make || "Unknown", p.year, p.model || "Unknown");
    b.profile = p;
    for (const v of p.knownVins ?? []) {
      b.units.push({ vin: v.vin, localReads: v.reads, firstReadAt: v.firstReadAt, lastReadAt: v.lastReadAt, scans: v.scans, inventory: v.inventory, inventoryChanges: v.inventoryChanges, inGarage: false });
    }
  }
  for (const g of garage) {
    const b = bucket(g.make || "Unknown", g.year, g.model || "Unknown");
    const hit = g.vin ? b.units.find((u) => u.vin && u.vin === g.vin) : undefined;
    if (hit) { hit.inGarage = true; hit.garage = g; }
    else b.units.push({ vin: g.vin, inGarage: true, garage: g });
  }
  return [...map.values()];
}

/** A scan answered by the desk simulator playing back a recording of a real car ("replay of …"). */
export const isReplayScan = (s: VehicleScanRecord) => !!s.sim && /^replay\b/i.test(s.sim);

/** A unit only a made-up virtual vehicle (a simulator template, not a recording) ever answered for.
 * A replayed recording answers with the real car's VIN, so its unit still counts as a real car. */
export function isVirtualUnit(u: UnitRow): boolean {
  return !u.inGarage && (u.scans?.length ?? 0) > 0 && u.scans!.every((s) => !!s.sim && !isReplayScan(s));
}

/** The newest scan of this model that a replayed recording answered — i.e. a golden recording exists. */
export function lastReplay(units: UnitRow[]): VehicleScanRecord | null {
  let best: VehicleScanRecord | null = null;
  for (const u of units) for (const s of u.scans ?? []) if (isReplayScan(s) && (!best || s.at > best.at)) best = s;
  return best;
}

export function unitCounts(units: UnitRow[]): { real: number; virtual: number } {
  const virtual = units.filter(isVirtualUnit).length;
  return { real: units.length - virtual, virtual };
}

/** Most recent thing that happened to a model (a read, a scan or a garage entry). */
export function lastActivity(b: ModelBucket): string {
  let best = b.profile?.provenance?.updatedAt ?? "";
  for (const u of b.units) {
    for (const t of [u.lastReadAt, u.garage?.createdAt, u.scans?.[u.scans.length - 1]?.at]) if (t && t > best) best = t;
  }
  return best;
}

/** "Mercedes-Benz" → "MB", "Toyota" → "TO", "BMW" → "BMW". */
export function monogram(make: string): string {
  const words = make.split(/[\s-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] ?? "?";
  if (w.length <= 3 && w === w.toUpperCase()) return w;
  return w.slice(0, 2).toUpperCase();
}

/**
 * A system's short name and plain name from its library label:
 *   "EZS — Electronic Ignition Switch (EIS, immobiliser)" → EZS · Electronic Ignition Switch
 *   "IPMA / CMR — Image Processing Module A (…)"           → IPMA · Image Processing Module A
 *   "CDI Engine Control Unit (ECM, OM642 …)"               → ECM · CDI Engine Control Unit
 *   "SAM Rear / Load-Compartment … Module"                 → SAM · Rear / Load-Compartment … Module
 *   "Combination Meter Assembly"                            → Combination · Combination Meter Assembly
 * Close to the Auto Diagnostic tiles' rule; the plain-name fallback is not cut at 10 letters here.
 */
export function splitLabel(label: string): { short: string; name: string } {
  const noParen = (s: string) => s.replace(/\s*\([^)]*\)/g, "").replace(/\s*\(.*$/, "").trim();
  const dash = /^(.*?)\s+[—–-]\s+(.+)$/.exec(label);
  const head = noParen(dash ? dash[1] : label);
  const desc = dash ? noParen(dash[2]) : "";
  const headAbbr = /^([A-Z][A-Za-z0-9-]{1,8})(?:\s*\/\s*[A-Z][A-Za-z0-9-]{1,8})*$/.exec(head);
  if (dash && headAbbr) return { short: headAbbr[1], name: desc || head };
  const paren = /\(([A-Z]{2,6})(?:[,)\s/])/.exec(label);
  if (paren) return { short: paren[1], name: head || label };
  const lead = /^([A-Z]{2,6})\b/.exec(label);
  if (lead) {
    const rest = head.replace(/^[A-Z]{2,6}\s*(\/\s*)?/, "").trim();
    return { short: lead[1], name: rest.length > 6 ? rest : desc || head };
  }
  const first = label.split(/[\s/(]+/)[0] || label;
  return { short: first.length > 14 ? `${first.slice(0, 13)}…` : first, name: head || label };
}

/** Airbag / immobiliser systems: never offered for AI mapping. */
export const guardOf = (m: VehicleModule): ProtectedVerdict | null => protectedModule({ category: m.category, label: m.label });

export type SystemTag = "protected" | "mapped" | "part" | "address";
export const TAG_TEXT: Record<SystemTag, string> = {
  protected: "protected", mapped: "mapped", part: "part no. only", address: "address only",
};

export interface SystemKnowledge {
  identity: boolean;
  live: boolean;
  codes: boolean;
  tag: SystemTag;
  guard: ProtectedVerdict | null;
  counts: { ident: number; live: number; codes: number };
}

/** What the library has learned about one system: identity / live data / fault codes. */
export function knowledgeOf(m: VehicleModule): SystemKnowledge {
  const x = m.explored;
  const guard = guardOf(m);
  const counts = { ident: x?.identification?.length ?? 0, live: x?.liveData?.length ?? 0, codes: explorationFaults(x?.dtcs).length };
  return {
    identity: !!(m.identity?.partNo || counts.ident || (x?.identity && x.identity !== "unknown")),
    live: counts.live > 0,
    codes: counts.codes > 0,
    tag: guard ? "protected" : x ? "mapped" : m.identity?.partNo ? "part" : "address",
    guard,
    counts,
  };
}

// ---- the spec strip -----------------------------------------------------------------------

export interface Spec { value: string; source?: string }

export function engineSpec(p: VehicleProfile): Spec | null {
  const d = p.decoded;
  if (!d?.engine) return null;
  let v = d.engine;
  if (d.fuel && !v.toLowerCase().includes(d.fuel.toLowerCase())) v += ` ${d.fuel.toLowerCase()}`;
  return { value: v, source: "NHTSA decode" };
}

/** Gearbox: the NHTSA decode if it says, else what the transmission module calls itself. */
export function gearboxSpec(p: VehicleProfile): Spec | null {
  if (p.decoded?.transmission) return { value: p.decoded.transmission, source: "NHTSA decode" };
  const tcm = addressedSystems(p).find((m) => m.category === "transmission" && !/transfer|driveline|4wd|awd/i.test(m.label))
    ?? p.modules.find((m) => m.category === "transmission" && !/transfer|driveline|4wd|awd/i.test(m.label));
  if (!tcm) return null;
  const source = "from the transmission module";
  const paren = /\(([^)]+)\)/.exec(tcm.label)?.[1]?.trim();
  if (paren && paren.length > 6 && /\d|speed|automatic|manual|cvt|dct|dsg/i.test(paren)) return { value: paren, source };
  const dash = /\s[—–-]\s(.+)$/.exec(tcm.label)?.[1];
  const v = (dash ?? tcm.label.replace(/\s*\(.*$/, ""))
    .replace(/\s*(transmission|transaxle)?\s*control\s*(module|unit|ecu)?\s*$/i, "").trim();
  return v ? { value: v, source } : null;
}

export function busSpec(p: VehicleProfile): Spec | null {
  const b = p.buses[0];
  if (!b) return null;
  const name = b.label.replace(/\s*\(.*\)\s*$/, "").trim() || b.protocol;
  let k = b.bitrate ? `${b.bitrate / 1000}k` : "";
  if (k && name.toLowerCase().includes(k)) k = "";
  const v = [k ? `${name} ${k}` : name, b.obdPins].filter(Boolean).join(" · ");
  return { value: v, source: p.buses.length > 1 ? `+ ${plural(p.buses.length - 1, "more bus", "more buses")}` : undefined };
}

const BODY_NOUN: Record<string, string> = { van: "van", minivan: "van", truck: "truck", suv: "SUV" };

export function carsSeenSpec(b: ModelBucket): Spec {
  const noun = BODY_NOUN[b.profile?.bodyType ?? ""] ?? "car";
  const reads = b.units.reduce((n, u) => n + (u.localReads ?? 0), 0);
  const inGarage = b.units.filter((u) => u.inGarage).length;
  const { virtual } = unitCounts(b.units);
  const extra = [inGarage ? `${inGarage} in the shop garage` : "", virtual ? `${virtual} virtual only` : ""].filter(Boolean).join(" · ");
  return { value: `${plural(b.units.length, noun)} · ${plural(reads, "read")}`, source: extra || undefined };
}

// ---- simulator ------------------------------------------------------------------------------

/** Does the virtual car that is answering ("2015 Sprinter 3500 diesel") look like this model? */
export function simMatches(simCar: string | null | undefined, p: { year: number | null; model: string }): boolean {
  if (!simCar) return false;
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const car = ` ${n(simCar)} `;
  const model = n(p.model);
  if (!model || !car.includes(` ${model} `)) return false;
  return p.year == null || car.includes(` ${p.year} `);
}

export function scanSummary(s: VehicleScanRecord): string {
  const faulty = s.systems.filter((x) => x.status === "fault");
  const codes = faulty.reduce((n, x) => n + x.dtcs.length, 0);
  return `${plural(s.systems.length, "system")} · ${faulty.length ? `${faulty.length} with faults (${plural(codes, "code")})` : "no faults"}`;
}

export const SOURCE_TEXT: Record<string, string> = {
  seed: "built-in map", bench_observed: "seen on the bus", ai_suggested: "AI suggestion",
  vin_decoded: "NHTSA decode", user: "entered by hand", community: "community map",
};
