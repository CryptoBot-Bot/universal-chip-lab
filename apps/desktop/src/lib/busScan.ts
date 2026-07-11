import { moduleTemplateFor, readMethodFor, decodeVin, type VehicleProfile } from "@ecu/vehicle-db";

import type { EcuObservation, VehicleScan, VehicleMapResult } from "./api";
import type { VehicleSimulator } from "./vehicleSim";

/**
 * Turn the simulated Toyota bus into a RAW scan the way a real scanner does:
 * SWEEP the diagnostic address space and record whoever answers (we never read
 * the vehicle profile's module list — that would be cheating on discovery). The
 * result feeds the AI mapper; compareMap then grades the AI against ground truth.
 */

/** Physical 11-bit request ids a tool sweeps. The full enhanced-diagnostic space is
 * 0x600–0x7FF: legislated powertrain 7E0–7E7, plus manufacturer ranges — VAG 0x7xx,
 * Ford 0x7xx, and crucially BMW's 0x6xx body/chassis modules. Sweeping only 0x7xx
 * would silently skip every BMW-style ECU. */
const DIAG_SWEEP: string[] = (() => {
  const ids: string[] = [];
  for (let a = 0x600; a <= 0x7ff; a++) ids.push(a.toString(16).toUpperCase());
  return ids;
})();

export const DIAG_SWEEP_COUNT = DIAG_SWEEP.length;
export const DIAG_SWEEP_LABEL = "0x600–0x7FF";

export interface ScanMeta { probed: number; answered: number; range: string; }

export function buildScan(profile: VehicleProfile, sim: VehicleSimulator): VehicleScan {
  const d = decodeVin(sim.vin);
  // Genuine discovery: probe every candidate address, keep only responders.
  const found = sim.scanBus(DIAG_SWEEP);
  const ecus: EcuObservation[] = found.map((e) => ({
    responseId: e.responseId,
    requestId: e.requestId,
    supportedPids: e.supportedPids,
    identifiers: e.identifiers,
    dtcs: e.dtcs,
    liveSample: e.liveSample,
  }));
  // profile is used ONLY for VIN decode/context here — not to enumerate modules.
  void profile;
  return {
    vin: sim.vin,
    year: d.year,
    make: d.make,
    country: d.country,
    ecus,
    notes: `HS-CAN @ 500k · swept ${DIAG_SWEEP_COUNT} physical addresses ${DIAG_SWEEP_LABEL} · ${ecus.length} ECUs answered ISO-TP`,
  };
}

export function scanMeta(scan: VehicleScan): ScanMeta {
  return { probed: DIAG_SWEEP_COUNT, answered: scan.ecus.length, range: DIAG_SWEEP_LABEL };
}

export interface CompareRow {
  responseId: string;
  expLabel: string; expCat: string; expRead: string; expSupplier: string;
  aiName: string; aiCat: string; aiRead: string; aiSupplier: string; aiProtocol: string; aiCaps: string[];
  conf: string;
  found: boolean; catOk: boolean; readOk: boolean; supOk: boolean;
}

export interface Comparison {
  rows: CompareRow[]; missed: string[]; extra: string[];
  found: number; total: number; catAcc: number; readAcc: number; supAcc: number;
  identity: { expYmm: string; aiYmm: string; ok: boolean; makeOk: boolean; yearOk: boolean; modelOk: boolean };
  vehicleName: string;
}

export function compareMap(result: VehicleMapResult, profile: VehicleProfile): Comparison {
  const gt = profile.modules.filter((m) => m.addressing?.response);
  const aiById = new Map(result.modules.map((m) => [m.responseId.toUpperCase(), m]));
  const rows: CompareRow[] = [];
  let found = 0, catOk = 0, readOk = 0, supOk = 0;
  for (const m of gt) {
    const rid = m.addressing!.response!.toUpperCase();
    const tpl = moduleTemplateFor(m.id, m.category);
    const expRead = readMethodFor(m.id);
    const expSupplier = m.identity?.supplier ?? tpl?.supplier ?? "unknown";
    const ai = aiById.get(rid);
    const f = !!ai;
    const co = !!ai && ai.category === m.category;
    const ro = !!ai && ai.memoryRead === expRead;
    const su = !!ai && ai.supplier.toUpperCase() === expSupplier.toUpperCase();
    if (f) found++; if (co) catOk++; if (ro) readOk++; if (su) supOk++;
    rows.push({
      responseId: rid, expLabel: m.label, expCat: m.category, expRead, expSupplier,
      aiName: ai?.name ?? "—", aiCat: ai?.category ?? "—", aiRead: ai?.memoryRead ?? "—",
      aiSupplier: ai?.supplier ?? "—", aiProtocol: ai?.protocol ?? "—", aiCaps: ai?.capabilities ?? [],
      conf: ai?.confidence ?? "—", found: f, catOk: co, readOk: ro, supOk: su,
    });
    aiById.delete(rid);
  }
  const total = gt.length;
  const expYmm = `${profile.year} ${profile.make} ${profile.model}`;
  const aiYmm = `${result.vehicle.year} ${result.vehicle.make} ${result.vehicle.model}`.trim();
  // Normalize away honest qualifiers like "(inferred)" before comparing — we ASK the
  // mapper to flag inferences, so it must not be penalized for doing so.
  const normId = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
  const makeOk = normId(result.vehicle.make) === normId(profile.make);
  const em = normId(profile.model), am = normId(result.vehicle.model);
  const modelOk = !!em && !!am && (em === am || am.includes(em) || em.includes(am));
  const yearOk = String(result.vehicle.year).trim() === String(profile.year ?? "").trim();
  // Make + year are reliably VIN-derivable; exact model/trim (e.g. 340i vs 330i) is
  // often NOT encoded in the VIN, so it's reported but not required for an identity pass.
  return {
    rows, missed: rows.filter((r) => !r.found).map((r) => r.responseId), extra: [...aiById.keys()],
    found, total,
    catAcc: total ? Math.round((catOk / total) * 100) : 0,
    readAcc: total ? Math.round((readOk / total) * 100) : 0,
    supAcc: total ? Math.round((supOk / total) * 100) : 0,
    identity: { expYmm, aiYmm, ok: makeOk && yearOk, makeOk, yearOk, modelOk },
    vehicleName: expYmm,
  };
}

/**
 * The RAW, copy-pasteable calibration report — deliberately exhaustive so it can
 * be pasted straight back to Claude to tune the mapper: discovery stats, the full
 * scan (every ECU's identifiers + live), the AI's full output, a per-axis delta,
 * a confidence audit, and the exact JSON in/out for reproduction.
 */
export function formatRawReport(scan: VehicleScan, result: VehicleMapResult, cmp: Comparison, hardSection?: string): string {
  const meta = scanMeta(scan);
  const L: string[] = [];
  L.push("=== ECU LAB · AI VEHICLE-MAP CALIBRATION REPORT ===");
  L.push(`VIN ${scan.vin} · decoded ${scan.year ?? "?"} ${scan.make ?? "?"} (${scan.country})`);
  L.push(`Discovery: probed ${meta.probed} physical addresses (${meta.range}) → ${meta.answered} answered.`);
  L.push(`Model: claude-opus-4-8 · schema-forced JSON · scan given WITHOUT the answer key.${hardSection ? " · HARD MODE (adversarial)" : ""}`);
  L.push("");

  // --- compact scan (one line per ECU) ---
  L.push(`--- RAW BUS SCAN · compact · ${scan.ecus.length} ECUs ---`);
  for (const e of scan.ecus) {
    L.push(`${e.responseId}${e.requestId ? `(req ${e.requestId})` : ""}: svc[${e.supportedPids.join(" ") || "—"}] ids{${e.identifiers.map((i) => `${i.did}=${i.ascii}`).join(", ") || "—"}} dtc[${e.dtcs.join(",") || "none"}]`);
  }
  L.push("");

  // --- full scan (identifiers + live per ECU — what the mapper actually saw) ---
  L.push(`--- RAW BUS SCAN · full (mapper input) ---`);
  for (const e of scan.ecus) {
    L.push(`${e.responseId} (req ${e.requestId ?? "?"})`);
    L.push(`    services: ${e.supportedPids.join(" ") || "—"}`);
    L.push(`    identifiers: ${e.identifiers.map((i) => `${i.did}="${i.ascii}"`).join(", ") || "—"}`);
    L.push(`    DTCs: ${e.dtcs.join(", ") || "none"}`);
    L.push(`    live: ${e.liveSample.map((l) => `${l.name}=${l.value}`).join(", ") || "—"}`);
  }
  L.push("");

  // --- AI output ---
  L.push(`--- AI OUTPUT · ${result.vehicle.year} ${result.vehicle.make} ${result.vehicle.model} (${result.vehicle.platform}) ---`);
  L.push(result.vehicle.summary);
  for (const m of result.modules) {
    L.push(`${m.responseId} → ${m.name} [${m.category}] supplier=${m.supplier} protocol=${m.protocol} mem=${m.memoryRead} conf=${m.confidence}`);
    L.push(`    can: ${m.capabilities.join("; ") || "—"}`);
    if (m.rationale) L.push(`    why: ${m.rationale}`);
  }
  L.push("");

  // --- local score ---
  L.push(`--- LOCAL SCORE vs known ${cmp.vehicleName} ---`);
  L.push(`found ${cmp.found}/${cmp.total} · category ${cmp.catAcc}% · memory-read ${cmp.readAcc}% · supplier ${cmp.supAcc}%`);
  L.push(`identity: expected "${cmp.identity.expYmm}" → AI "${cmp.identity.aiYmm}" ${cmp.identity.ok ? "✓" : "✗"} (make ${cmp.identity.makeOk ? "✓" : "✗"} · year ${cmp.identity.yearOk ? "✓" : "✗"} · model ${cmp.identity.modelOk ? "✓" : "~ (not VIN-encoded)"})`);
  if (cmp.missed.length) L.push(`MISSED (in truth, absent from AI): ${cmp.missed.join(", ")}`);
  if (cmp.extra.length) L.push(`EXTRA/hallucinated (AI id not in truth): ${cmp.extra.join(", ")}`);
  for (const r of cmp.rows) {
    L.push(`${r.found ? "✓" : "✗"} ${r.responseId} exp:${r.expLabel}[${r.expCat}/${r.expRead}/${r.expSupplier}] → ai:${r.aiName}[${r.aiCat}/${r.aiRead}/${r.aiSupplier}] ${r.catOk ? "cat✓" : "cat✗"} ${r.readOk ? "mem✓" : "mem✗"} ${r.supOk ? "sup✓" : "sup✗"} (conf ${r.conf})`);
  }
  L.push("");

  // --- deltas only: exactly what to fix, per axis ---
  const deltas: string[] = [];
  for (const r of cmp.rows) {
    if (!r.found) { deltas.push(`${r.responseId}: MISSED entirely (truth=${r.expLabel}).`); continue; }
    const parts: string[] = [];
    if (!r.catOk) parts.push(`category ai=${r.aiCat} truth=${r.expCat}`);
    if (!r.readOk) parts.push(`memoryRead ai=${r.aiRead} truth=${r.expRead}`);
    if (!r.supOk) parts.push(`supplier ai=${r.aiSupplier} truth=${r.expSupplier}`);
    if (parts.length) deltas.push(`${r.responseId} (${r.expLabel}): ${parts.join("; ")} [conf ${r.conf}]`);
  }
  L.push(`--- CALIBRATION DELTAS (${deltas.length}) — the only things to reconcile ---`);
  L.push(deltas.length ? deltas.join("\n") : "None — every graded axis matched.");
  L.push("");

  // --- confidence audit: was high confidence earned? ---
  const overconf = cmp.rows.filter((r) => r.conf === "high" && (!r.catOk || !r.readOk || !r.supOk));
  const underconf = cmp.rows.filter((r) => r.conf === "low" && r.catOk && r.readOk && r.supOk);
  L.push(`--- CONFIDENCE AUDIT ---`);
  L.push(`over-confident (high but ≥1 axis wrong): ${overconf.map((r) => r.responseId).join(", ") || "none"}`);
  L.push(`under-confident (low but all axes right): ${underconf.map((r) => r.responseId).join(", ") || "none"}`);
  L.push("");

  // --- hard-mode robustness (only present on an adversarial run) ---
  if (hardSection) {
    L.push("NOTE: this was a HARD-MODE run — the standard score above is measured on the de-aliased result, and supplier mismatches on stripped ECUs are EXPECTED (and rewarded as honesty below), not errors.");
    L.push("");
    L.push(hardSection);
    L.push("");
  }

  // --- exact JSON for reproduction ---
  L.push(`--- SCAN JSON (exact mapper input) ---`);
  L.push(JSON.stringify(scan));
  L.push("");
  L.push(`--- AI JSON (exact mapper output) ---`);
  L.push(JSON.stringify(result));
  L.push("");

  L.push(`Paste this whole report back to Claude to compare against the gold ${cmp.vehicleName} and tune the mapper.`);
  L.push("=== END REPORT ===");
  return L.join("\n");
}
