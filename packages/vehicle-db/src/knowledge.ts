/**
 * The knowledge base: what is known about vehicles from outside sources, each item with where
 * it came from, its licence and how far it is trusted. Sources fill the map quickly; our own
 * recordings decide what holds on a given car (see `testSignal`).
 *
 *   standard   a public standard (SAE J1979 OBD-II): true for every car that supports it
 *   community  decoded by people for some model (OBDb): true for that model, a candidate elsewhere
 *   maker      the vehicle maker's own data (not loaded yet)
 *   observed   seen on a real car through a trusted scan tool (not built yet)
 *   ai         proposed by an AI from recorded bytes (moduleLabels.ts)
 *   proven     follows the car's own measurements in two states (moduleLabels.ts)
 *
 * Browser-safe: no file or network access here — the main process builds and loads the data.
 */
import { stateCheck, valueAt } from "./moduleLabels.js";
import type { ModuleSweep, SweepRefs } from "./moduleSweep.js";

export type Trust = "standard" | "community" | "maker" | "observed" | "ai" | "proven";

export interface KnowledgeSource {
  id: string;
  name: string;
  url: string;
  /** SPDX id, e.g. "CC-BY-SA-4.0", "CC0-1.0". */
  licence: string;
  /** What the licence asks of us, in one line. */
  terms: string;
  retrievedAt: string;
  version?: string;
}

/** One value inside one diagnostic answer, as a source describes it. */
export interface SignalDef {
  key: string;                 // unique: source/vehicle/request/id
  source: string;              // KnowledgeSource.id
  trust: Trust;
  /** Which vehicles the source says it is for; absent = any vehicle (a standard). */
  vehicle?: { make: string; model?: string; years?: [number, number][] };
  tx: string;                  // request header, "7E0"
  rx?: string;                 // answer header, "7E8"
  /** Extended (sub-)address some makers use (BMW); this device does not send those yet. */
  eax?: string;
  service: string;             // "01", "22", "21"
  pid: string;                 // "0C", "0163"
  bit: number;                 // first bit, counted from the first data byte after the echo
  bits: number;
  signed?: boolean;
  mul: number; div: number; add: number;
  unit: string;
  min?: number; max?: number; nullmin?: number; nullmax?: number;
  map?: Record<string, string>;
  name: string;
  group?: string;
  description?: string;
}

export interface DtcDef { code: string; title: string; description?: string; category?: string; source: string }

export interface KnowledgeVehicle { make: string; model?: string; years?: [number, number][]; source: string; set: string; signals: number; /** distinct module addresses the set covers */ modules?: number }

export interface KnowledgeBase {
  builtAt: string;
  sources: KnowledgeSource[];
  vehicles: KnowledgeVehicle[];
  signals: SignalDef[];
  dtcs: DtcDef[];
}

const hex = (s?: string | null) => (s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");
const norm = (s?: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The value of a signal in the data bytes of one answer; null when the data is too short or the value is "no value". */
export function decodeSignal(def: Pick<SignalDef, "bit" | "bits" | "signed" | "mul" | "div" | "add" | "nullmin" | "nullmax" | "map">, dataHex: string): number | string | null {
  const h = hex(dataHex);
  if (!Number.isInteger(def.bit) || def.bit < 0 || !Number.isInteger(def.bits) || def.bits < 1 || def.bits > 48) return null;
  if (Math.ceil((def.bit + def.bits) / 8) > h.length / 2) return null;
  const first = Math.floor(def.bit / 8), last = Math.floor((def.bit + def.bits - 1) / 8);
  const chunk = BigInt("0x" + h.slice(first * 2, (last + 1) * 2));
  const width = (last - first + 1) * 8;
  let raw = Number((chunk >> BigInt(width - (def.bit - first * 8) - def.bits)) & ((1n << BigInt(def.bits)) - 1n));
  if (def.signed && raw >= 2 ** (def.bits - 1)) raw -= 2 ** def.bits;
  if (def.map && def.map[String(raw)] !== undefined) return def.map[String(raw)];
  if (def.nullmax !== undefined && raw >= def.nullmax) return null;
  if (def.nullmin !== undefined && raw <= def.nullmin) return null;
  const v = (raw * (def.mul || 1)) / (def.div || 1) + (def.add || 0);
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}

/** "22 0163" — the form sweeps and labels use. */
export const requestKey = (d: Pick<SignalDef, "service" | "pid">) => `${hex(d.service)} ${hex(d.pid)}`;

export interface VehicleQuery { make: string; model?: string; year?: number | null }

/** Signals the sources say are for this vehicle, by how closely they match. */
export function signalsFor(kb: Pick<KnowledgeBase, "signals">, v: VehicleQuery): { standard: SignalDef[]; model: SignalDef[]; make: SignalDef[]; otherModels: SignalDef[] } {
  const out = { standard: [] as SignalDef[], model: [] as SignalDef[], make: [] as SignalDef[], otherModels: [] as SignalDef[] };
  const mk = norm(v.make), md = norm(v.model);
  for (const s of kb.signals) {
    if (!s.vehicle) { out.standard.push(s); continue; }
    if (norm(s.vehicle.make) !== mk) continue;
    if (!s.vehicle.model) { out.make.push(s); continue; }
    const sameModel = md && (norm(s.vehicle.model) === md || norm(s.vehicle.model).startsWith(md) || md.startsWith(norm(s.vehicle.model)));
    const inYears = !v.year || !s.vehicle.years?.length || s.vehicle.years.some(([a, b]) => v.year! >= a && v.year! <= b);
    if (sameModel && inYears) out.model.push(s); else out.otherModels.push(s);
  }
  return out;
}

export interface DtcMeaning { code: string; title?: string; description?: string; source?: string; makerSpecific: boolean }

/** P0xxx, P2xxx, P3400–P3999… are open (SAE); P1xxx, B1xxx, C1xxx, U1xxx… belong to the maker. */
export function isMakerSpecificDtc(code: string): boolean {
  const c = hex(code.slice(1)).length ? code.toUpperCase() : "";
  const m = /^([PCBU])([0-3])([0-9A-F])/.exec(c);
  if (!m) return true;
  if (m[2] === "1") return true;
  if (m[1] === "P" && m[2] === "3") return parseInt(m[3], 16) < 4;
  if (m[1] !== "P" && m[2] === "2") return true;
  return false;
}

export function dtcMeaning(kb: Pick<KnowledgeBase, "dtcs">, code: string, index?: Map<string, DtcDef>): DtcMeaning {
  const base = code.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 5);
  const d = index ? index.get(base) : kb.dtcs.find((x) => x.code === base);
  return { code: base, makerSpecific: isMakerSpecificDtc(base), ...(d ? { title: d.title, description: d.description, source: d.source } : {}) };
}

// ---- does a borrowed definition hold on THIS car? ----

export type SignalVerdict = "proven" | "fits" | "no-answer" | "too-short" | "out-of-range" | "not-swept";
export interface SignalTest { key: string; verdict: SignalVerdict; note: string; at: { condition: string; values: (number | string | null)[] }[] }

const QUANTITY: { unit: RegExp; name: RegExp; not?: RegExp; ref: keyof SweepRefs; tol: (lo: number, hi: number) => [number, number]; apart: number }[] = [
  { unit: /^volts?$/i, name: /battery|system voltage|supply|module voltage|12v/i, not: /sensor|reference|cell|hv|high voltage/i, ref: "volts", tol: (lo, hi) => [lo - 0.3, hi + 0.3], apart: 1 },
  { unit: /^rpm$/i, name: /^engine (speed|rpm)$|^rpm$|engine rpm/i, not: /desired|target|idle/i, ref: "rpm", tol: (lo, hi) => [lo * 0.97, hi * 1.03], apart: 300 },
  { unit: /^(celsius|°c)$/i, name: /coolant/i, ref: "coolant", tol: (lo, hi) => [lo - 4, hi + 4], apart: 15 },
];

/**
 * Test one definition against what this car's module answered in its sweeps. "proven" needs two
 * states whose own readings differ, and the value following them; "fits" = present, every read
 * decodes, nothing out of range. A definition for another model is only a candidate until then.
 */
export function testSignal(def: SignalDef, module: { addressing?: { request?: string }; sweeps?: ModuleSweep[] } | undefined): SignalTest {
  const key = def.key;
  const sweeps = (module?.sweeps ?? []).filter((s) => !s.sim);
  if (!module || !sweeps.length) return { key, verdict: "not-swept", note: "this module has no sweep on file", at: [] };
  const id = requestKey(def);
  const at: SignalTest["at"] = [];
  let seen = false;
  for (const sw of sweeps) {
    const h = sw.hits.find((x) => x.id === id && !x.gated);
    if (!h) continue;
    seen = true;
    at.push({ condition: sw.condition, values: [h.bytes, h.again ?? h.bytes].map((b) => decodeSignal(def, b)) });
  }
  if (!seen) return { key, verdict: "no-answer", note: `${id} did not answer on this car`, at };
  if (at.some((a) => a.values.some((v) => v === null))) {
    const short = at.some((a) => a.values.every((v) => v === null));
    if (short) return { key, verdict: "too-short", note: "the answer is shorter than this definition", at };
  }
  const nums = at.flatMap((a) => a.values).filter((v): v is number => typeof v === "number");
  const lo = def.min ?? -Infinity, hi = def.max ?? Infinity;
  const bad = nums.find((x) => x < lo || x > hi);
  if (bad !== undefined) return { key, verdict: "out-of-range", note: `${bad} ${def.unit} is outside ${def.min ?? "…"}–${def.max ?? "…"}`, at };
  const q = QUANTITY.find((x) => x.unit.test(def.unit) && x.name.test(def.name) && !(x.not && x.not.test(def.name)));
  if (q) {
    const pairs = sweeps.map((sw) => ({ ref: sw.refs?.[q.ref], a: at.find((x) => x.condition === sw.condition) })).filter((p) => p.ref && p.a && p.a.values.every((v) => typeof v === "number"));
    if (pairs.length >= 2) {
      const ok = pairs.every((p) => { const [l, h] = q.tol(p.ref![0], p.ref![1]); return p.a!.values.every((v) => (v as number) >= l && (v as number) <= h); });
      const mids = pairs.map((p) => (p.ref![0] + p.ref![1]) / 2);
      if (ok && Math.max(...mids) - Math.min(...mids) >= q.apart) return { key, verdict: "proven", note: `follows the measured ${q.ref === "volts" ? "supply voltage" : q.ref === "rpm" ? "engine speed" : "coolant temperature"} in ${pairs.length} states`, at };
      if (!ok) return { key, verdict: "out-of-range", note: `does not follow the measured ${q.ref}`, at };
    }
  }
  void valueAt;
  if (def.map && at.some((a) => a.values.some((x) => typeof x === "number"))) return { key, verdict: "out-of-range", note: "a value that is not one of the states this definition names", at };
  const st = stateCheck(def.name, def.unit, sweeps.map((sw) => ({ values: (at.find((a) => a.condition === sw.condition)?.values ?? []).filter((x): x is number => typeof x === "number"), refs: sw.refs })));
  if (st?.verdict === "contradicted") return { key, verdict: "out-of-range", note: st.note, at };
  return { key, verdict: "fits", note: st ? `answers on this car; ${st.note}` : "answers and decodes plausibly on this car", at };
}
