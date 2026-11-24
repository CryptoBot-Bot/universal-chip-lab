/**
 * The completeness sweep (deep map, part 5a): fixed code reads EVERY identifier in
 * the standard ranges of one module — no AI choosing what to try — and records what
 * answers, twice, so values that move (live data) stand apart from fixed ones.
 *
 * It is the yardstick the AI map is measured against: coverage = what the AI map
 * kept ÷ what the module actually answers. Reads only (22 / 21 / 1A and harmless
 * session switches) — and never on an airbag / immobiliser module.
 */
import type { VehicleModule } from "./vehicleProfile.schema.js";

export interface SweepHit {
  /** "22 0163", "21 05", "1A 87". */
  id: string;
  /** Session it answered in: "01" default, "03" extended, or a KWP session such as "89". */
  session: string;
  /** Data bytes of the first read (hex, after the positive-response header; capped). */
  bytes: string;
  /** Data bytes of the second read, when it differed. */
  again?: string;
  /** Changed between the two reads (a live value). */
  moving: boolean;
  /** Mostly printable text (identification-like). */
  ascii?: string;
  /** Refused with NRC 0x33 — exists, but behind security access. */
  gated?: boolean;
}

export interface ModuleSweep {
  at: string;
  /** What the car was doing: "ignition on, engine off", "engine idling"… (operator's words). */
  condition: string;
  /** The simulator that answered instead of a car, if one did. */
  sim?: string;
  protocol: "uds" | "kwp2000";
  /** Sessions asked and how each answered. */
  sessions: { id: string; ok: boolean; nrc?: number }[];
  /** The ranges read, e.g. "22 0100–03FF @03". */
  ranges: string[];
  hits: SweepHit[];
  counts: { asked: number; answered: number; moving: number; gated: number; ms: number };
}

export interface SweepRange {
  /** "22" (UDS ReadDataByIdentifier), "21" (KWP ReadDataByLocalIdentifier), "1A" (KWP ReadEcuIdentification). */
  sid: "22" | "21" | "1A";
  from: number;
  to: number;
}

const r = (sid: SweepRange["sid"], from: number, to: number): SweepRange => ({ sid, from, to });

/**
 * What to read on a module. UDS: the measurement block 0100–03FF and the
 * identification block F100–F1FF everywhere, the OBD mirror F400–F4FF on engine /
 * gearbox modules; `wide` adds 0400–0FFF. KWP: every local identifier and every
 * identification option.
 */
export function sweepPlan(protocol: "uds" | "kwp2000", category: string, opts: { wide?: boolean } = {}): SweepRange[] {
  if (protocol === "kwp2000") return [r("21", 0x00, 0xff), r("1A", 0x80, 0x9f)];
  const out = [r("22", 0x0100, 0x03ff), r("22", 0xf100, 0xf1ff)];
  if (category === "powertrain" || category === "transmission") out.push(r("22", 0xf400, 0xf4ff));
  if (opts.wide) out.push(r("22", 0x0400, 0x0fff));
  return out;
}

export function rangeRequests(rg: SweepRange): string[] {
  const out: string[] = [];
  const w = rg.sid === "22" ? 4 : 2;
  for (let n = rg.from; n <= rg.to; n++) out.push(`${rg.sid}${n.toString(16).toUpperCase().padStart(w, "0")}`);
  return out;
}

export function rangeLabel(rg: SweepRange, session: string): string {
  const w = rg.sid === "22" ? 4 : 2;
  const h = (n: number) => n.toString(16).toUpperCase().padStart(w, "0");
  return `${rg.sid} ${h(rg.from)}–${h(rg.to)} @${session}`;
}

/** "22F190" → "22 F190"; "2105" → "21 05". */
export function requestId(req: string): string {
  const q = req.replace(/\s+/g, "").toUpperCase();
  return `${q.slice(0, 2)} ${q.slice(2)}`;
}

/** Data bytes of a positive answer to a 22 / 21 / 1A read, or null. */
export function dataOf(req: string, responseHex?: string | null): string | null {
  const q = req.replace(/\s+/g, "").toUpperCase();
  const r2 = (responseHex ?? "").replace(/\s+/g, "").toUpperCase();
  if (!r2 || r2.startsWith("7F")) return null;
  const sid = parseInt(q.slice(0, 2), 16);
  const want = (sid + 0x40).toString(16).toUpperCase().padStart(2, "0");
  const echo = want + q.slice(2);                // 62 F190 · 61 05 · 5A 87
  if (!r2.startsWith(echo)) return null;
  return r2.slice(echo.length);
}

export function asciiOf(hex: string): string | undefined {
  const b = (hex.match(/../g) ?? []).map((x) => parseInt(x, 16));
  if (b.length < 4) return undefined;
  const printable = b.filter((n) => n >= 0x20 && n < 0x7f).length;
  if (printable / b.length < 0.8) return undefined;
  return b.map((n) => (n >= 0x20 && n < 0x7f ? String.fromCharCode(n) : " ")).join("").replace(/\s+/g, " ").trim() || undefined;
}

// ---- coverage: the AI map against the sweep -------------------------------------

/** Normalise an identifier as the AI map writes it ("22 0163", "0x0163", "DID 0163", "21 05"). */
export function normaliseId(id: string, protocolHint?: "uds" | "kwp2000"): string | null {
  const s = id.toUpperCase().replace(/\b(DID|LID|PID|ID|DATA)\b/g, " ").replace(/0X/g, "").replace(/[^0-9A-F ]/g, " ").trim();
  const parts = s.split(/\s+/).filter((x) => x.length >= 2);
  if (parts.length >= 2 && /^(22|21|1A)$/.test(parts[0])) {
    const rest = parts.slice(1).join("");
    if (parts[0] === "22" && /^[0-9A-F]{4}$/.test(rest)) return `22 ${rest}`;
    if (parts[0] !== "22" && /^[0-9A-F]{2}$/.test(rest)) return `${parts[0]} ${rest}`;
  }
  // "09 02", "01 0C": a service and its parameter (OBD and the like), not a data identifier
  if (parts.length === 2 && parts.every((x) => /^[0-9A-F]{2}$/.test(x))) return null;
  const one = parts.join("");
  if (/^[0-9A-F]{4}$/.test(one)) return `22 ${one}`;
  if (/^[0-9A-F]{2}$/.test(one) && protocolHint === "kwp2000") return `21 ${one}`;
  return null;
}

export interface Coverage {
  /** Identifiers the module answers (union of its sweeps). */
  answered: number;
  /** …of which the AI map knows about. */
  known: number;
  /** known ÷ answered, 0–1 (null with no sweep). */
  ratio: number | null;
  /** Values that move, and how many of them the AI map lists as live data. */
  moving: number;
  movingKnown: number;
  /** Answering identifiers the AI map never mentions (first 40). */
  missed: string[];
  /** Moving values the AI map does not list as live data (first 40) — the misses that matter most. */
  missedLive: string[];
  /** Identifiers the AI map claims that no sweep saw answer (possible inventions or other sessions). */
  unseen: string[];
}

/** Compare a module's AI map (explored) with its sweeps. */
export function coverageOf(m: Pick<VehicleModule, "explored" | "sweeps" | "protocol">): Coverage {
  const sweeps = m.sweeps ?? [];
  const hint = m.protocol === "kwp2000" ? "kwp2000" : "uds";
  const answered = new Map<string, SweepHit>();
  for (const sw of sweeps) for (const h of sw.hits) {
    const cur = answered.get(h.id);
    if (!cur || (!cur.moving && h.moving)) answered.set(h.id, h);
  }
  // a value that differs between two conditions (engine off / idle) is moving too
  const firstBytes = new Map<string, string>();
  for (const sw of sweeps) for (const h of sw.hits) {
    const prev = firstBytes.get(h.id);
    if (prev === undefined) firstBytes.set(h.id, h.bytes);
    else if (prev !== h.bytes) { const a = answered.get(h.id); if (a) answered.set(h.id, { ...a, moving: true }); }
  }
  const x = m.explored;
  const knownIds = new Set<string>();
  const liveIds = new Set<string>();
  for (const i of x?.identification ?? []) { const n = normaliseId(i.id, hint); if (n) knownIds.add(n); }
  for (const l of x?.liveData ?? []) { const n = normaliseId(l.id, hint); if (n) { knownIds.add(n); liveIds.add(n); } }
  const ans = [...answered.keys()];
  const known = ans.filter((id) => knownIds.has(id));
  const moving = ans.filter((id) => answered.get(id)!.moving);
  const movingKnown = moving.filter((id) => liveIds.has(id));
  return {
    answered: ans.length,
    known: known.length,
    ratio: ans.length ? known.length / ans.length : null,
    moving: moving.length,
    movingKnown: movingKnown.length,
    missed: ans.filter((id) => !knownIds.has(id)).slice(0, 40),
    missedLive: moving.filter((id) => !liveIds.has(id)).slice(0, 40),
    unseen: sweeps.length ? [...knownIds].filter((id) => !answered.has(id)).slice(0, 40) : [],
  };
}

/** Keep one sweep per condition (the newest), at most `cap` conditions. */
export function addSweep(list: ModuleSweep[] | undefined, sw: ModuleSweep, cap = 4): ModuleSweep[] {
  const rest = (list ?? []).filter((x) => x.condition !== sw.condition || !!x.sim !== !!sw.sim);
  return [...rest, sw].slice(-cap);
}
