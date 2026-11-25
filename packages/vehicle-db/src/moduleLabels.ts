/**
 * Deep map, parts 5b and 5c. The sweep (5a, fixed code) says WHAT a module answers; here an AI
 * says what each identifier IS (5b, offline, from the recorded bytes), and code checks what it
 * says against measurements it was never shown (5c):
 *
 *   confirmed     a value follows an independent reading (supply voltage, engine speed) in two
 *                 different states of the car, e.g. engine off and idling
 *   consistent    nothing speaks against it: the kind fits how the bytes behave, values plausible
 *   unchecked     nothing to check it with
 *   contradicted  the bytes say otherwise (outside the data, implausible, a "fixed" value that
 *                 moves, a "supply voltage" that does not follow the supply)
 *
 * Only "confirmed" is knowledge. The rest are proposals.
 */
import type { ModuleSweep, SweepRefs } from "./moduleSweep.js";

export type { SweepRefs } from "./moduleSweep.js";

export type LabelKind = "identification" | "live" | "state" | "coding" | "counter" | "unknown";
export const LABEL_KINDS: LabelKind[] = ["identification", "live", "state", "coding", "counter", "unknown"];
export type CheckStatus = "confirmed" | "consistent" | "unchecked" | "contradicted";

/** One number inside an identifier's data: big-endian, `offset` counted from the first data byte. */
export interface LabelValue { name: string; offset: number; length: number; signed: boolean; factor: number; add: number; unit: string }
export interface ValueReading { name: string; unit: string; status: CheckStatus; note?: string; at: { condition: string; values: number[] }[] }
export interface LabelCheck { status: CheckStatus; notes: string[]; readings: ValueReading[] }
export interface LabelProposal { id: string; name: string; kind: LabelKind; confidence: "low" | "medium" | "high"; why: string; values: LabelValue[] }
export interface IdentifierLabel extends LabelProposal { check: LabelCheck }

export interface ModuleLabels {
  at: string;
  model: string;
  /** The sweeps the labels were made from. */
  sweeps: { condition: string; at: string }[];
  labels: IdentifierLabel[];
  /** Fields that follow the car's own readings in two states — found by code, no AI (findTracks). */
  tracks?: Track[];
  /** How many such fields made-up readings would find on average: the share of luck in `tracks`. */
  luck?: { volts: number; rpm: number };
  /** Identifiers the AI named that this module never answered — dropped, kept here as a count of inventions. */
  invented: string[];
  tokensIn: number;
  tokensOut: number;
}

/** A field that follows a measured quantity of the car. */
export interface Track { id: string; offset: number; length: number; factor: number; quantity: "supply voltage" | "engine speed"; at: { condition: string; values: number[] }[] }

export interface ConditionReads { condition: string; reads: string[]; refs?: SweepRefs }

/** Every read of every identifier, per condition (real and simulated sweeps are not mixed: pass one kind). */
export function readsOf(sweeps: ModuleSweep[] | undefined): Map<string, ConditionReads[]> {
  const out = new Map<string, ConditionReads[]>();
  for (const sw of sweeps ?? []) for (const h of sw.hits) {
    if (h.gated) continue;
    const list = out.get(h.id) ?? [];
    list.push({ condition: sw.condition, reads: [h.bytes, h.again ?? h.bytes], ...(sw.refs ? { refs: sw.refs } : {}) });
    out.set(h.id, list);
  }
  return out;
}

export function varies(reads: ConditionReads[]): boolean {
  return new Set(reads.flatMap((r) => r.reads)).size > 1;
}

/** The value in these bytes, or null when the bytes do not reach that far. */
export function valueAt(hex: string, v: Pick<LabelValue, "offset" | "length" | "signed" | "factor" | "add">): number | null {
  if (!Number.isInteger(v.offset) || v.offset < 0 || ![1, 2, 3, 4].includes(v.length)) return null;
  const part = hex.slice(v.offset * 2, (v.offset + v.length) * 2);
  if (part.length !== v.length * 2 || !/^[0-9A-Fa-f]+$/.test(part)) return null;
  let n = parseInt(part, 16);
  if (v.signed && n >= 2 ** (v.length * 8 - 1)) n -= 2 ** (v.length * 8);
  const x = n * v.factor + v.add;
  return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
}

const PLAUSIBLE: [RegExp, number, number][] = [
  [/^m?v$/i, -1000, 60000], [/^°?c$|^deg ?c$/i, -60, 1300], [/^rpm$|^1\/min$/i, -20, 9000], [/^%$/, -200, 250],
  [/^km\/h$/i, -5, 350], [/^bar$/i, -2, 2600], [/^(hpa|mbar)$/i, -2000, 2.6e6], [/^kpa$/i, -200, 2.6e5], [/^a$/i, -2000, 2000], [/^nm$/i, -3000, 6000],
];
const plausible = (unit: string, x: number): boolean => {
  if (/^v$/i.test(unit.trim())) return x >= -2 && x <= 60;
  const p = PLAUSIBLE.find(([re]) => re.test(unit.trim()));
  return !p || (x >= p[1] && x <= p[2]);
};

const SUPPLY = /\b(supply|battery|ubat|u_bat|board|vehicle|system|operating)\b.*\bvoltage\b|\bvoltage\b.*\b(supply|battery|ubat|board net|kl\.? ?(15|30|87)|terminal ?(15|30|87))|\b(terminal|kl\.?|cl\.?) ?(15|30|87)\w?\b.*\bvolt|\bubat\b/i;
const NOT_SUPPLY = /sensor|reference|5 ?v|pedal|throttle|lambda|heater|output|setpoint|threshold|limit|minimum|maximum|difference/i;
const ENGINE_SPEED = /\bengine (speed|rpm)\b|^rpm$|\bcrankshaft speed\b/i;
const NOT_ENGINE_SPEED = /desired|target|set ?point|limit|max|min\b|threshold|gradient|turbine|output|input|idle speed|nominal/i;
const COOLANT = /\b(engine )?coolant temp|\bengine temperature\b/i;

/** Check one value against the car's own readings. Two states that really differ are needed to confirm. */
function checkValue(v: LabelValue, reads: ConditionReads[]): ValueReading {
  const at: ValueReading["at"] = [];
  for (const r of reads) {
    const xs: number[] = [];
    for (const hex of r.reads) {
      const x = valueAt(hex, v);
      if (x === null) return { name: v.name, unit: v.unit, status: "contradicted", note: `bytes ${v.offset}–${v.offset + v.length - 1} are outside the data`, at: [] };
      xs.push(x);
    }
    at.push({ condition: r.condition, values: xs });
  }
  const out = (status: CheckStatus, note?: string): ValueReading => ({ name: v.name, unit: v.unit, status, ...(note ? { note } : {}), at });
  const bad = at.flatMap((a) => a.values).find((x) => !plausible(v.unit, x));
  if (bad !== undefined) return out("contradicted", `${bad} ${v.unit} is not plausible`);

  const against = (pick: (r: SweepRefs) => [number, number] | undefined, ok: (x: number, lo: number, hi: number) => boolean, wrong: (x: number, lo: number, hi: number) => boolean, apart: number, what: string): ValueReading | null => {
    const pairs = reads.map((r, i) => ({ ref: r.refs ? pick(r.refs) : undefined, xs: at[i].values, condition: r.condition })).filter((p): p is { ref: [number, number]; xs: number[]; condition: string } => !!p.ref);
    if (!pairs.length) return null;
    const off = pairs.find((p) => p.xs.some((x) => wrong(x, p.ref[0], p.ref[1])));
    if (off) return out("contradicted", `${off.condition}: ${off.xs.join(" / ")} ${v.unit}, but the ${what} was ${off.ref[0]}–${off.ref[1]}`);
    if (!pairs.every((p) => p.xs.every((x) => ok(x, p.ref[0], p.ref[1])))) return out("unchecked", `near the ${what}, not close enough to confirm`);
    const mids = pairs.map((p) => (p.ref[0] + p.ref[1]) / 2);
    return Math.max(...mids) - Math.min(...mids) >= apart ? out("confirmed", `follows the ${what} in ${pairs.length} states`) : out("consistent", `matches the ${what} in one state only`);
  };

  if (/^m?v$/i.test(v.unit.trim()) && SUPPLY.test(v.name) && !NOT_SUPPLY.test(v.name)) {
    const k = /^mv$/i.test(v.unit.trim()) ? 0.001 : 1;
    const r = against((x) => x.volts, (x, lo, hi) => x * k >= lo - 0.3 && x * k <= hi + 0.3, (x, lo, hi) => x * k < lo - 1 || x * k > hi + 1, 1, "measured supply voltage");
    if (r) return r;
  }
  if (/^(rpm|1\/min)$/i.test(v.unit.trim()) && ENGINE_SPEED.test(v.name) && !NOT_ENGINE_SPEED.test(v.name)) {
    const r = against((x) => x.rpm, (x, lo, hi) => x >= lo * 0.97 && x <= hi * 1.03, (x, lo, hi) => x < lo * 0.75 - 100 || x > hi * 1.25 + 100, 300, "measured engine speed");
    if (r) return r;
  }
  if (/^°?c$|^deg ?c$/i.test(v.unit.trim()) && COOLANT.test(v.name)) {
    const r = against((x) => x.coolant, (x, lo, hi) => x >= lo - 4 && x <= hi + 4, (x, lo, hi) => x < lo - 12 || x > hi + 12, 15, "measured coolant temperature");
    if (r) return r;
  }
  return out("consistent");
}

/** 5c: what the bytes say about a proposal. The proposal's author never saw the reference readings. */
export function checkLabel(p: LabelProposal, reads: ConditionReads[]): LabelCheck {
  const notes: string[] = [];
  const moving = varies(reads);
  let status: CheckStatus = "unchecked";
  if (p.kind === "identification" || p.kind === "coding") {
    if (moving) { status = "contradicted"; notes.push(`called ${p.kind}, but the bytes change`); }
    else { status = "consistent"; notes.push("the bytes never change"); }
  } else if (p.kind === "live") {
    if (moving) { status = "consistent"; notes.push("the bytes change"); }
    else notes.push("called live, but the bytes did not change in these sweeps");
  } else if (p.kind === "counter" || p.kind === "state") {
    if (moving) { status = "consistent"; notes.push("the bytes change"); } else notes.push("did not change in these sweeps");
  }
  const readings = p.values.map((v) => checkValue(v, reads));
  const wrong = readings.filter((r) => r.status === "contradicted");
  for (const r of wrong) notes.push(`${r.name}: ${r.note ?? "contradicted"} — rejected`);
  if (wrong.length && wrong.length === readings.length) status = "contradicted";
  if (readings.some((r) => r.status === "confirmed") && status !== "contradicted") {
    status = "confirmed";
    for (const r of readings) if (r.status === "confirmed") notes.push(`${r.name}: ${r.note ?? "confirmed"}`);
  }
  // an unknown identifier is never "confirmed" by accident of a stray value
  if (p.kind === "unknown" && status !== "contradicted") status = "unchecked";
  return { status, notes, readings };
}

/** Check every proposal; identifiers the module never answered are dropped and reported as invented. */
export function checkLabels(proposals: LabelProposal[], sweeps: ModuleSweep[] | undefined): { labels: IdentifierLabel[]; invented: string[] } {
  const reads = readsOf(sweeps);
  const labels: IdentifierLabel[] = []; const invented: string[] = []; const seen = new Set<string>();
  for (const p of proposals) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const r = reads.get(p.id);
    if (!r) { invented.push(p.id); continue; }
    labels.push({ ...p, check: checkLabel(p, r) });
  }
  return { labels, invented };
}

export interface LabelSummary { answered: number; named: number; unknown: number; /** named with at least one number in it, or fixed text/identity */ specific: number; confirmed: number; consistent: number; unchecked: number; contradicted: number; missing: number }
export function labelSummary(l: ModuleLabels | undefined, sweeps: ModuleSweep[] | undefined): LabelSummary {
  const answered = readsOf(sweeps).size;
  const named = (l?.labels ?? []).filter((x) => x.kind !== "unknown");
  const n = (s: CheckStatus) => named.filter((x) => x.check.status === s).length;
  return {
    answered, named: named.length, specific: named.filter((x) => x.values.length || x.kind === "identification").length, unknown: (l?.labels ?? []).length - named.length,
    confirmed: n("confirmed"), consistent: n("consistent"), unchecked: n("unchecked"), contradicted: n("contradicted"),
    missing: Math.max(0, answered - (l?.labels ?? []).length),
  };
}

// ---- no AI: which fields follow what the car measured? ----

const VOLT_FIELDS: [number, number][] = [[2, 0.001], [2, 0.01], [2, 0.02], [2, 0.025], [2, 0.005], [2, 0.0025], [2, 1 / 128], [2, 1 / 256], [1, 0.1], [1, 0.05], [1, 0.0625], [1, 0.08]];
const RPM_FIELDS: [number, number][] = [[2, 1], [2, 0.5], [2, 0.25], [2, 0.125], [2, 0.2], [2, 0.1]];

/**
 * Every field whose values follow the supply voltage (or engine speed) in ALL states, on every
 * read. Needs two states whose readings really differ; one fixed scale for all of them. `fake`
 * replaces the car's readings — searching with made-up ones shows how often luck alone matches.
 */
export function findTracks(reads: Map<string, ConditionReads[]>, fake?: (refs: SweepRefs) => SweepRefs): Track[] {
  const out: Track[] = [];
  for (const [id, list] of reads) {
    const rs = list.filter((r) => r.refs).map((r) => ({ ...r, refs: fake ? fake(r.refs!) : r.refs! }));
    if (rs.length < 2 || !varies(rs)) continue;
    const len = Math.min(...rs.flatMap((r) => r.reads.map((h) => h.length / 2)));
    const search = (fields: [number, number][], pick: (r: SweepRefs) => [number, number] | undefined, slack: (lo: number, hi: number, f: number) => number, apart: number, quantity: Track["quantity"]) => {
      const refs = rs.map((r) => pick(r.refs));
      if (refs.some((x) => !x)) return;
      const mids = refs.map((x) => (x![0] + x![1]) / 2);
      if (Math.max(...mids) - Math.min(...mids) < apart) return;
      const taken = new Set<number>();
      for (const [length, factor] of fields) for (let offset = 0; offset + length <= len; offset++) {
        if (taken.has(offset)) continue;
        const at = rs.map((r) => ({ condition: r.condition, values: r.reads.map((h) => valueAt(h, { offset, length, signed: false, factor, add: 0 })!) }));
        if (at.every((a, i) => a.values.every((x) => x >= refs[i]![0] - slack(refs[i]![0], refs[i]![1], factor) && x <= refs[i]![1] + slack(refs[i]![0], refs[i]![1], factor)))) {
          taken.add(offset);
          out.push({ id, offset, length, factor, quantity, at });
        }
      }
    };
    search(VOLT_FIELDS, (r) => r.volts, (_lo, _hi, f) => Math.max(0.2, f), 1, "supply voltage");
    search(RPM_FIELDS, (r) => r.rpm, (_lo, hi) => (hi < 50 ? 0 : hi * 0.02), 300, "engine speed");
  }
  return out;
}

/** The same search with readings no car had: the average number of matches luck gives. */
export function luckOfTracks(reads: Map<string, ConditionReads[]>): { volts: number; rpm: number } {
  const shift = (x: [number, number] | undefined, f: (v: number) => number): [number, number] | undefined => x && [f(x[0]), f(x[1])];
  const volts = [0.6, 0.7, 0.8, 1.25, 1.4, 1.6].map((k) => findTracks(reads, (r) => ({ volts: shift(r.volts, (v) => v * k) })).filter((t) => t.quantity === "supply voltage").length);
  const rpm = [0.45, 0.6, 0.8, 1.3, 1.7, 2.3].map((k) => findTracks(reads, (r) => ({ rpm: shift(r.rpm, (v) => v * k) })).filter((t) => t.quantity === "engine speed").length);
  const mean = (a: number[]) => Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10;
  return { volts: mean(volts), rpm: mean(rpm) };
}
