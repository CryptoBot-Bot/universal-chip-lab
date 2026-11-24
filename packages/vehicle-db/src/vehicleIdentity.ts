/**
 * Vehicle identity resolution — the STANDARD for "which car is this?".
 *
 * A VIN never names a model by itself: the WMI (pos 1-3) is the manufacturer +
 * vehicle type, so "JTD" covers every Toyota sedan and "1FT" every Ford truck.
 * Matching a library profile on WMI alone is how the cockpit used to pick the
 * wrong car. This module replaces that with four evidence layers, strongest
 * first, and NEVER binds a profile below the "certain" bar:
 *
 *   1. exact VIN      — this unit was read before (profile.knownVins)      → certain
 *   2. VIN pattern    — the "squish" (pos 1-8 + pos 10 = WMI + VDS + year) of a
 *                       unit previously CONFIRMED on this YMM matches         → certain
 *   3. confirmed YMM  — the operator / shop DB / AI resolved Year+Make+Model  → certain
 *   4. hints          — same make (+year) / same WMI: CANDIDATES for the
 *                       operator or the AI, shown with a low score, never bound.
 *
 * Every real VIN that gets bound to a profile teaches the profile its squish
 * pattern (learnVin), so the next unit of the same shape resolves at layer 2
 * with no AI and no operator input. Browser + node safe, pure.
 */

import { decodeVin, type VinDecode } from "./vinDecode.js";
import { PIDS } from "./obdPids.js";
import { profileMatchesYmm, recordVinRead, type VehicleProfile, type VehicleFingerprint, type OnlineVinDecode, type BodyType } from "./vehicleProfile.schema.js";

export type IdentityMatchKind = "vin" | "pattern" | "ymm" | "wmi-hint" | "make-hint";

export interface IdentityMatch {
  profile: VehicleProfile;
  kind: IdentityMatchKind;
  confidence: number;   // 0..1 — ≥ BIND_THRESHOLD means we may load this profile without asking
  reason: string;       // human line for the UI
}

export interface IdentityResolution {
  vin: string;
  decode: VinDecode;
  /** The profile we may bind right now (layer 1-3), or null. */
  bound: IdentityMatch | null;
  /** Everything worth showing, strongest first (includes `bound` when present). */
  candidates: IdentityMatch[];
}

/** Below this we only SUGGEST. */
export const BIND_THRESHOLD = 0.9;

/**
 * Squish pattern for a VIN: positions 1-8 (WMI + VDS: model / body / engine /
 * restraint codes) + position 10 (model year). Position 9 (check digit) and the
 * plant/serial (11-17) are wildcarded. Two units with the same squish are the
 * same year/make/model/trim shape — the industry-standard VIN-to-model key.
 */
export function squishPattern(vin: string): string | null {
  const v = (vin || "").trim().toUpperCase();
  if (v.length !== 17) return null;
  const esc = (s: string) => s.replace(/[^A-Z0-9]/g, "");
  return `^${esc(v.slice(0, 8))}.${esc(v.slice(9, 10))}`;
}

export function vinMatchesPattern(vin: string, pattern: string): boolean {
  try { return new RegExp(pattern, "i").test((vin || "").trim().toUpperCase()); } catch { return false; }
}

function allPatterns(p: VehicleProfile): string[] {
  const out = [...(p.vinPatterns ?? [])];
  if (p.vinPattern) out.push(p.vinPattern);
  return out;
}

/**
 * Resolve a VIN against the library. `confirmed` is an OPTIONAL Year/Make/Model
 * some trusted source already established (operator, shop garage decoder, AI) —
 * it enables layer 3. Pure.
 */
export function resolveVehicleIdentity(
  profiles: VehicleProfile[],
  vinRaw: string,
  confirmed?: { year: number | null; make: string; model: string } | null,
): IdentityResolution {
  const decode = decodeVin(vinRaw);
  const vin = decode.vin;
  const seen = new Set<string>();
  const candidates: IdentityMatch[] = [];
  const add = (m: IdentityMatch) => { if (!seen.has(m.profile.id)) { seen.add(m.profile.id); candidates.push(m); } };

  // 1 — exact VIN
  for (const p of profiles) {
    if (p.knownVins?.some((k) => k.vin.toUpperCase() === vin)) {
      add({ profile: p, kind: "vin", confidence: 1, reason: "This exact VIN was read before and filed here." });
    }
  }
  // 2 — learned squish pattern (year must agree when both known)
  for (const p of profiles) {
    if (allPatterns(p).some((pat) => vinMatchesPattern(vin, pat))) {
      const yearOk = decode.year == null || p.year == null || p.year === decode.year;
      if (yearOk) add({ profile: p, kind: "pattern", confidence: 0.95, reason: "VIN shape (maker + model codes + year) matches a unit already confirmed on this vehicle." });
    }
  }
  // 3 — confirmed YMM from a trusted source
  if (confirmed?.make && confirmed.model) {
    for (const p of profiles) {
      if (profileMatchesYmm(p, confirmed.year, confirmed.make, confirmed.model)) {
        add({ profile: p, kind: "ymm", confidence: 0.92, reason: `Year/Make/Model confirmed as ${confirmed.year ?? ""} ${confirmed.make} ${confirmed.model}.` });
      }
    }
  }
  // 4 — hints only
  if (decode.valid) {
    for (const p of profiles) {
      if (p.wmi?.includes(decode.wmi)) {
        const sameYear = decode.year != null && p.year === decode.year;
        add({ profile: p, kind: "wmi-hint", confidence: sameYear ? 0.4 : 0.25, reason: `Same manufacturer code (${decode.wmi})${sameYear ? " and model year" : ""} — could be this or a sibling model.` });
      }
    }
    if (decode.make) {
      for (const p of profiles) {
        if (p.make.toLowerCase() === decode.make.toLowerCase()) {
          const sameYear = decode.year != null && p.year === decode.year;
          add({ profile: p, kind: "make-hint", confidence: sameYear ? 0.3 : 0.15, reason: `Same make (${decode.make})${sameYear ? " and year" : ""} — prior knowledge for the AI, not a match.` });
        }
      }
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const bound = candidates.find((c) => c.confidence >= BIND_THRESHOLD) ?? null;
  return { vin, decode, bound, candidates };
}

/**
 * Teach a profile a real unit: record the VIN read AND learn its squish pattern
 * (+ WMI hint). Call this every time a VIN is CONFIRMED to belong to the
 * profile — never on a guess. Pure; returns the new profile.
 */
export function learnVin(profile: VehicleProfile, vin: string, now: string): { profile: VehicleProfile; vinIsNew: boolean } {
  const r = recordVinRead(profile, vin, now);
  const p = r.profile;
  const pat = squishPattern(vin);
  const d = decodeVin(vin);
  const vinPatterns = [...(p.vinPatterns ?? [])];
  if (pat && !vinPatterns.includes(pat)) vinPatterns.push(pat);
  const wmi = [...(p.wmi ?? [])];
  if (d.valid && d.wmi && !wmi.includes(d.wmi)) wmi.push(d.wmi);
  return { profile: { ...p, vinPatterns, wmi }, vinIsNew: r.vinIsNew };
}

/** How a just-read VIN was tied to the library (see bindVinIdentity). */
export interface VinBinding {
  /** The profile to save, with this unit learned — or null when nothing may be bound yet. */
  profile: VehicleProfile | null;
  /** "vin" / "pattern" / "ymm": an existing profile; "new": filed from the online decode; null: unresolved. */
  kind: "vin" | "pattern" | "ymm" | "new" | null;
  vinIsNew: boolean;
  resolution: IdentityResolution;
}

/**
 * The standard "VIN read → which library vehicle" step, in one pure function:
 * the trusted online decode (NHTSA) confirms Year/Make/Model, which binds an
 * existing profile (exact VIN / learned pattern / that YMM) or files a new one;
 * either way the unit is learned on it. With no certain match and no usable
 * decode it returns profile null — the AI Identify stage is the fallback, never
 * a guess. Mirrors the cockpit's read-VIN flow so the command-line runner and
 * the UI bind identically.
 */
export function bindVinIdentity(profiles: VehicleProfile[], vin: string, online: OnlineVinDecode | null, now: string): VinBinding {
  const confirmed = online?.ok ? { year: online.year, make: online.make, model: online.model } : null;
  const resolution = resolveVehicleIdentity(profiles, vin, confirmed);
  if (resolution.bound) {
    const { profile, vinIsNew } = learnVin(resolution.bound.profile, vin, now);
    const kind = resolution.bound.kind as "vin" | "pattern" | "ymm";
    return { profile: online?.ok && !profile.decoded ? { ...profile, decoded: online } : profile, kind, vinIsNew, resolution };
  }
  if (online?.ok) {
    const { profile } = learnVin(profileFromOnlineDecode(online, now), vin, now);
    return { profile, kind: "new", vinIsNew: true, resolution };
  }
  return { profile: null, kind: null, vinIsNew: false, resolution };
}

/** Jaccard overlap of two responder sets (0..1) — how alike two buses look. */
export function fingerprintSimilarity(a?: VehicleFingerprint | null, b?: VehicleFingerprint | null): number {
  const A = new Set((a?.responders ?? []).map((x) => x.toUpperCase()));
  const B = new Set((b?.responders ?? []).map((x) => x.toUpperCase()));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Responder set implied by a profile's module map (for profiles never fingerprinted). */
export function profileResponders(p: VehicleProfile): string[] {
  return p.modules.map((m) => (m.addressing?.response ?? "").toUpperCase().replace(/[^0-9A-F]/g, "")).filter(Boolean);
}

/** NHTSA "Body Class" → our 3D body type. Null when it doesn't map. */
export function bodyTypeFromClass(bodyClass?: string): BodyType | null {
  const b = (bodyClass || "").toLowerCase();
  if (!b) return null;
  if (b.includes("pickup") || b.includes("truck")) return "truck";
  if (b.includes("minivan")) return "minivan";
  if (b.includes("van") || b.includes("cargo") || b.includes("bus")) return "van";
  if (b.includes("sport utility") || b.includes("suv") || b.includes("mpv") || b.includes("crossover")) return "suv";
  if (b.includes("hatchback") || b.includes("liftback")) return "hatchback";
  if (b.includes("coupe") || b.includes("convertible") || b.includes("roadster")) return "coupe";
  if (b.includes("wagon")) return "wagon";
  if (b.includes("sedan") || b.includes("saloon")) return "sedan";
  return null;
}

/** "TOYOTA" → "Toyota", "MERCEDES-BENZ" → "Mercedes-Benz", "BMW" stays. */
export function prettyMake(raw: string): string {
  const KEEP = new Set(["BMW", "GMC", "MINI", "FIAT", "SRT", "SAAB", "MG"]);
  const SPECIAL: Record<string, string> = { RAM: "Ram", KIA: "Kia", INFINITI: "Infiniti", MCLAREN: "McLaren" };
  const up = (raw || "").trim().toUpperCase();
  if (!up) return "";
  if (KEEP.has(up)) return up;
  if (SPECIAL[up]) return SPECIAL[up];
  return up.split(/(\s+|-)/).map((w) => (/^(\s+|-)$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase())).join("");
}

/**
 * Build a NEW library profile from a trusted online decode. The module map is
 * the universal OBD floor (ECM); discovery + census fill the rest. Pure.
 */
export function profileFromOnlineDecode(d: OnlineVinDecode, now: string): VehicleProfile {
  const make = prettyMake(d.make);
  const model = (d.model || "").trim();
  const off = decodeVin(d.vin);
  const body: BodyType = d.bodyType ?? (off.bodyTypeHint !== "unknown" ? (off.bodyTypeHint as BodyType) : "sedan");
  const notes = [
    `Filed from the NHTSA vPIC decode.`,
    d.trim ? `Trim ${d.trim}.` : "", d.series ? `Series ${d.series}.` : "",
    d.engine ? `Engine ${d.engine}.` : "", d.driveType ? `${d.driveType}.` : "",
    d.plantCity || d.plantCountry ? `Built in ${[d.plantCity, d.plantCountry].filter(Boolean).join(", ")}.` : "",
    "Discover + census the bus to fill the module map.",
  ].filter(Boolean).join(" ");
  return {
    id: ymmProfileId(d.year, make, model),
    year: d.year, make, model, trim: d.trim || d.series || undefined, bodyType: body,
    market: /united states|usa/i.test(d.plantCountry || "") ? "US" : undefined,
    wmi: off.valid ? [off.wmi] : [],
    decoded: d,
    buses: [{ id: "hs-can", label: "HS-CAN", protocol: "CAN", bitrate: 500000, obdPins: "6/14" }],
    modules: [
      { id: "ecm", label: "Engine Control Module", category: "powertrain", bus: "hs-can", location: "engine", addressing: { request: "7E0", response: "7E8" } },
    ],
    supportedPids: PIDS.map((p) => p.pid),
    capabilities: [
      { id: "live-data", label: "Live engine data", category: "diagnostic", risk: "read", bus: "hs-can", module: "ecm", sequence: ["01 0C", "01 0D", "01 05"] },
      { id: "read-dtcs", label: "Read stored DTCs", category: "diagnostic", risk: "read", bus: "hs-can", module: "ecm", sequence: ["03"] },
      { id: "read-vin", label: "Read VIN", category: "diagnostic", risk: "read", bus: "hs-can", module: "ecm", sequence: ["09 02"] },
    ],
    notes,
    provenance: { source: "vin_decoded", confidence: 0.85, createdAt: now, observedOn: d.vin },
  };
}

/** Library key for a NEW profile from a resolved identity. */
export function ymmProfileId(year: number | null, make: string, model: string): string {
  return [year ?? "unknown", make, model].join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
