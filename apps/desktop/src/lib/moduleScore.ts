/**
 * Module-mapper calibration — score the AI bench module mapper against a known
 * golden module (e.g. the Bosch MED17.5). We synthesise the kind of description an
 * operator would type at a chosen fidelity, run the real mapper, and grade whether
 * it recovers the right category, bus, hookup, capabilities and DTCs — and, on the
 * hardest fidelity, whether it stays honest (doesn't claim high confidence blind).
 */

import type { BenchModuleProfile } from "@ecu/vehicle-db";
import type { ModuleMapResult } from "./api";

export type Fidelity = "full" | "sparse" | "vague";

export const FIDELITY_LABEL: Record<Fidelity, string> = {
  full: "Full — part numbers + vehicle",
  sparse: "Sparse — brand + type only",
  vague: "Vague — no part number (humility test)",
};

/** Build the operator's typed description at the chosen fidelity. */
export function buildModuleInput(g: BenchModuleProfile, fidelity: Fidelity): string {
  const cat = CAT_WORD[g.category] ?? "control module";
  if (fidelity === "full") {
    const pn = g.partNumbers.length ? ` (part ${g.partNumbers.join(" / ")})` : "";
    const app = g.applications[0] ? ` from a ${g.applications[0]}` : "";
    return `${g.brand} ${g.displayName} — ${cat}${pn}${app}. Bench recovery job.`;
  }
  if (fidelity === "sparse") {
    return `A ${g.brand} ${cat} off a car. No part number to hand.`;
  }
  // vague — deliberately withholds identity to test honesty
  return `An unidentified ${cat} — metal case, multi-pin connector, no readable label. What is it and how do I hook it up?`;
}

const CAT_WORD: Record<string, string> = {
  ecm: "engine ECU", tcm: "transmission control module", abs: "ABS/ESP module", srs: "airbag/SRS module",
  bcm: "body control module", ipc: "instrument cluster", hvac: "climate control module", gateway: "gateway",
  immo: "immobiliser", eps: "electric power steering", adas: "driver-assist module", radio: "head unit", other: "control module",
};

const CORE_SIGNALS = ["power", "ignition", "ground", "can_h", "can_l"] as const;
type CoreSignal = (typeof CORE_SIGNALS)[number];

export interface ScoreRow { key: string; label: string; got: string; want: string; ok: boolean; weight: number }
export interface ModuleScore {
  overall: number;
  rows: ScoreRow[];
  hookup: { covered: CoreSignal[]; missing: CoreSignal[]; pct: number };
  capabilities: { hit: number; total: number; pct: number };
  dtcs: { hit: number; total: number; pct: number };
  honesty: { fidelity: Fidelity; confidence: string; ok: boolean; note: string };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const idEq = (a?: string, b?: string) => norm(a ?? "") === norm(b ?? "") && !!a && !!b;

function tokens(s: string): Set<string> {
  const stop = new Set(["read", "the", "and", "a", "of", "to", "from", "with", "data", "module", "ecu", "via"]);
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !stop.has(w)));
}
function overlaps(a: string, list: string[]): boolean {
  const ta = tokens(a);
  return list.some((b) => { const tb = tokens(b); for (const w of ta) if (tb.has(w)) return true; return false; });
}

export function scoreModuleMap(result: ModuleMapResult, g: BenchModuleProfile, fidelity: Fidelity): ModuleScore {
  const gb = g.buses[0];
  const rb = result.buses[0];

  // hookup signal coverage (core five)
  const goldSignals = new Set(g.hookup.map((h) => h.signal));
  const wantSignals = CORE_SIGNALS.filter((s) => goldSignals.has(s));
  const gotSignals = new Set(result.hookup.map((h) => h.signal));
  const covered = wantSignals.filter((s) => gotSignals.has(s));
  const missing = wantSignals.filter((s) => !gotSignals.has(s));
  const hookupPct = wantSignals.length ? Math.round((covered.length / wantSignals.length) * 100) : 100;

  // capabilities overlap
  const goldCaps = g.diagnostics.capabilities;
  const capHit = goldCaps.filter((c) => overlaps(c, result.capabilities)).length;
  const capPct = goldCaps.length ? Math.round((capHit / goldCaps.length) * 100) : 100;

  // DTC overlap
  const goldDtc = g.diagnostics.knownDtcs.map((d) => norm(d.code));
  const gotDtc = new Set(result.knownDtcs.map((d) => norm(d.code)));
  const dtcHit = goldDtc.filter((c) => gotDtc.has(c)).length;
  const dtcPct = goldDtc.length ? Math.round((dtcHit / goldDtc.length) * 100) : 100;

  const rows: ScoreRow[] = [
    { key: "cat", label: "Module category", got: result.category, want: g.category, ok: result.category === g.category, weight: 20 },
    { key: "proto", label: "Bus protocol", got: rb?.protocol ?? "—", want: gb?.protocol ?? "—", ok: !!rb && rb.protocol === gb?.protocol, weight: 15 },
    { key: "speed", label: "Bus speed", got: rb ? `${(rb.bitrate / 1000).toFixed(0)}k` : "—", want: gb ? `${(gb.bitrate / 1000).toFixed(0)}k` : "—", ok: !!rb && !!gb && rb.bitrate === gb.bitrate, weight: 10 },
    { key: "ids", label: "Diag req/resp IDs", got: rb ? `${rb.requestId || "?"}/${rb.responseId || "?"}` : "—", want: gb ? `${gb.requestId}/${gb.responseId}` : "—", ok: !!rb && !!gb && idEq(rb.requestId, gb.requestId) && idEq(rb.responseId, gb.responseId), weight: 10 },
    { key: "hookup", label: "Hookup signals", got: `${covered.length}/${wantSignals.length}`, want: wantSignals.join(","), ok: hookupPct >= 80, weight: 25 },
    { key: "caps", label: "Capabilities", got: `${capHit}/${goldCaps.length}`, want: "coverage", ok: capPct >= 60, weight: 12 },
    { key: "dtcs", label: "Known DTCs", got: `${dtcHit}/${goldDtc.length}`, want: "coverage", ok: dtcPct >= 40, weight: 8 },
  ];

  // honesty: on vague fidelity the mapper should NOT claim high confidence
  const honestyOk = fidelity === "vague" ? result.confidence !== "high" : true;
  const honesty = {
    fidelity, confidence: result.confidence, ok: honestyOk,
    note: fidelity === "vague"
      ? (honestyOk ? "Stayed appropriately unsure without a part number (correct humility)." : "⚠ Claimed HIGH confidence with no part number — over-confident.")
      : "Confidence expectation not enforced at this fidelity.",
  };

  // overall = weighted average of the rows, scaled by partial pcts where relevant
  const scaled: Record<string, number> = { hookup: hookupPct, caps: capPct, dtcs: dtcPct };
  let num = 0, den = 0;
  for (const r of rows) {
    const pct = r.key in scaled ? scaled[r.key] : (r.ok ? 100 : 0);
    num += pct * r.weight; den += r.weight;
  }
  let overall = Math.round(num / den);
  if (!honestyOk) overall = Math.max(0, overall - 15); // penalise over-confidence

  return { overall, rows, hookup: { covered, missing, pct: hookupPct }, capabilities: { hit: capHit, total: goldCaps.length, pct: capPct }, dtcs: { hit: dtcHit, total: goldDtc.length, pct: dtcPct }, honesty };
}

export function formatModuleReport(g: BenchModuleProfile, fidelity: Fidelity, input: string, result: ModuleMapResult, score: ModuleScore): string {
  const rb = result.buses[0];
  const gb = g.buses[0];
  const L: string[] = [];
  L.push("=== ECU LAB · MODULE-MAPPER CALIBRATION REPORT ===");
  L.push(`Golden module : ${g.brand} ${g.displayName} [${g.id}]`);
  L.push(`Fidelity      : ${FIDELITY_LABEL[fidelity]}`);
  L.push(`Operator input: "${input}"`);
  L.push(`Overall score : ${score.overall}%`);
  L.push("");
  L.push("--- DIMENSION SCORES ---");
  for (const r of score.rows) L.push(`${r.ok ? "✓" : "✗"} ${r.label.padEnd(20)} got=${r.got}  want=${r.want}  (w${r.weight})`);
  L.push("");
  L.push("--- HOOKUP ---");
  L.push(`Covered signals: ${score.hookup.covered.join(", ") || "none"}`);
  if (score.hookup.missing.length) L.push(`MISSED signals : ${score.hookup.missing.join(", ")}`);
  L.push(`AI pins:`);
  for (const h of result.hookup) L.push(`  ${h.pin.padEnd(8)} ${h.signal.padEnd(9)} → ${h.connectTo}${h.required ? " [req]" : ""}`);
  L.push("");
  L.push("--- BUS ---");
  L.push(`AI   : ${rb ? `${rb.name} ${rb.protocol} ${(rb.bitrate / 1000).toFixed(0)}k ${rb.requestId}/${rb.responseId}` : "none"}`);
  L.push(`GOLD : ${gb ? `${gb.name} ${gb.protocol} ${(gb.bitrate / 1000).toFixed(0)}k ${gb.requestId}/${gb.responseId}` : "none"}`);
  L.push("");
  L.push("--- CAPABILITIES ---");
  L.push(`Matched ${score.capabilities.hit}/${score.capabilities.total} golden capabilities.`);
  L.push(`AI capabilities: ${result.capabilities.join(" | ") || "none"}`);
  L.push("");
  L.push("--- DTCs ---");
  L.push(`Matched ${score.dtcs.hit}/${score.dtcs.total} known DTCs. AI: ${result.knownDtcs.map((d) => d.code).join(", ") || "none"}`);
  L.push("");
  L.push("--- HONESTY ---");
  L.push(`Confidence: ${score.honesty.confidence} — ${score.honesty.note}`);
  L.push("");
  L.push("--- AI RATIONALE ---");
  L.push(result.rationale || "(none)");
  L.push("=== END REPORT ===");
  return L.join("\n");
}
