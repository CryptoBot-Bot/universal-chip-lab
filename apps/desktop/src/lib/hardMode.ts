import { type VehicleProfile } from "@ecu/vehicle-db";

import type { EcuObservation, VehicleScan, VehicleMapResult } from "./api";
import { DIAG_SWEEP_COUNT, DIAG_SWEEP_LABEL } from "./busScan";

/**
 * Hard Mode — adversarial perturbation of a clean scan + a robustness score that
 * rewards CORRECT HUMILITY, not just accuracy. A saturated 100% on clean data
 * says nothing about a real (messy) bus, so before the AI sees the scan we:
 *   1. strip a couple of ECUs down to just their VIN (no part#/supplier/live-label
 *      hints) → forces category inference from address + services + DTC prefix, and
 *      makes the honest supplier answer "unknown";
 *   2. relocate one ECU to a NON-standard response id but keep its evidence intact
 *      → a robust mapper still IDs it from evidence, not the address;
 *   3. inject a DECOY responder with thin, ambiguous evidence and NO ground truth
 *      → a robust mapper stays unsure instead of inventing a real module.
 * The perturbation manifest is hidden from the AI and used only to grade it.
 */

export interface Perturbation {
  kind: "strip-evidence" | "move-address" | "decoy";
  responseId: string;        // id as it appears in the perturbed scan (what the AI sees)
  trueResponseId?: string;   // real id (move-address only) for fair grading
  detail: string;
}

export interface PerturbedScan {
  scan: VehicleScan;
  manifest: Perturbation[];
  strippedIds: string[];               // perturbed ids whose part#/supplier were removed
  movedAlias: Record<string, string>;  // perturbedId -> trueId
  decoyIds: string[];                  // ids with no ground truth
}

// Deterministic targets (scan is address-sorted; these exist in the Corolla seed).
const STRIP_TARGETS = ["7AE", "7BE"];              // EPS + clearance sonar: distinctive live/DTC survive stripping
const MOVE_FROM = "7B8", MOVE_TO = "7C4", MOVE_TO_REQ = "7BC"; // skid control → non-standard address
const DECOY_ID = "70A", DECOY_REQ = "702";

export function perturbScan(clean: VehicleScan): PerturbedScan {
  const manifest: Perturbation[] = [];
  const strippedIds: string[] = [];
  const movedAlias: Record<string, string> = {};
  const decoyIds: string[] = [];

  const ecus: EcuObservation[] = clean.ecus.map((e) => {
    const rid = e.responseId.toUpperCase();
    if (STRIP_TARGETS.includes(rid)) {
      strippedIds.push(rid);
      manifest.push({
        kind: "strip-evidence", responseId: rid,
        detail: "Stripped to VIN only — removed part number (F187), software (F195), hardware (F191), serial (F18C) and supplier (F18A). Category must come from response id + services + DTC prefix + live data; supplier is now unknowable (honest answer = \"unknown\").",
      });
      return { ...e, identifiers: e.identifiers.filter((i) => i.did === "F190") };
    }
    if (rid === MOVE_FROM) {
      movedAlias[MOVE_TO] = MOVE_FROM;
      manifest.push({
        kind: "move-address", responseId: MOVE_TO, trueResponseId: MOVE_FROM,
        detail: `Skid-control ECU relocated from its standard ${MOVE_FROM} to a non-standard ${MOVE_TO}; all evidence (ADVICS part #, wheel-speed live, C12xx DTCs) intact. A robust mapper still identifies it as ABS from evidence, not the address.`,
      });
      return { ...e, responseId: MOVE_TO, requestId: MOVE_TO_REQ };
    }
    return e;
  });

  // Inject the decoy: a real responder with almost no identifying evidence.
  const vin = clean.ecus[0]?.identifiers.find((i) => i.did === "F190")?.ascii ?? clean.vin;
  ecus.push({
    responseId: DECOY_ID, requestId: DECOY_REQ,
    supportedPids: ["10", "3E"],
    identifiers: [{ did: "F190", ascii: vin }],
    dtcs: ["U1000"],
    liveSample: [],
  });
  decoyIds.push(DECOY_ID);
  manifest.push({
    kind: "decoy", responseId: DECOY_ID,
    detail: "Injected an ambiguous responder: session + tester-present only, a generic U1000 comm DTC, no part number, no supplier, no live data. There is NO such module in ground truth. Robust behaviour = include it with LOW confidence / \"unknown\", NOT confidently invent a real ECU.",
  });

  ecus.sort((a, b) => a.responseId.localeCompare(b.responseId));

  const scan: VehicleScan = {
    ...clean,
    ecus,
    notes: `HS-CAN @ 500k · swept ${DIAG_SWEEP_COUNT} physical addresses ${DIAG_SWEEP_LABEL} · ${ecus.length} ECUs answered ISO-TP`,
  };
  return { scan, manifest, strippedIds, movedAlias, decoyIds };
}

/** De-alias moved ids and drop decoys so the STANDARD accuracy score stays fair on identity. */
export function normalizeForScoring(result: VehicleMapResult, pert: PerturbedScan): VehicleMapResult {
  const decoy = new Set(pert.decoyIds.map((s) => s.toUpperCase()));
  const modules = result.modules
    .filter((m) => !decoy.has(m.responseId.toUpperCase()))
    .map((m) => {
      const trueId = pert.movedAlias[m.responseId.toUpperCase()];
      return trueId ? { ...m, responseId: trueId } : m;
    });
  return { ...result, modules };
}

export interface RobustnessResult {
  resilience: { pct: number; hit: number; total: number; rows: { id: string; kind: string; expCat: string; aiCat: string; ok: boolean; conf: string }[] };
  honesty: { pct: number; hit: number; total: number; rows: { id: string; aiSupplier: string; honest: boolean; conf: string }[] };
  skepticism: { handled: boolean; present: boolean; aiName: string; aiCat: string; conf: string; detail: string };
  overconfident: string[];   // perturbed ids where confidence was high but the call was wrong/phantom
  robustnessPct: number;
}

export function scoreRobustness(result: VehicleMapResult, profile: VehicleProfile, pert: PerturbedScan): RobustnessResult {
  const aiById = new Map(result.modules.map((m) => [m.responseId.toUpperCase(), m]));
  const goldByTrue = new Map(
    profile.modules.filter((m) => m.addressing?.response).map((m) => [m.addressing!.response!.toUpperCase(), m]),
  );
  const trueToPerturbed = new Map<string, string>();
  for (const [pid, tid] of Object.entries(pert.movedAlias)) trueToPerturbed.set(tid.toUpperCase(), pid.toUpperCase());

  const stripped = new Set(pert.strippedIds.map((s) => s.toUpperCase()));
  const movedTrue = new Set(Object.values(pert.movedAlias).map((s) => s.toUpperCase()));
  const hardTrueIds = new Set<string>([...stripped, ...movedTrue]);
  const overconfident: string[] = [];

  // Resilience — did category survive the perturbation on the hard ECUs?
  const rRows: RobustnessResult["resilience"]["rows"] = [];
  let rHit = 0;
  for (const tid of hardTrueIds) {
    const gold = goldByTrue.get(tid);
    if (!gold) continue;
    const pid = trueToPerturbed.get(tid) ?? tid;
    const ai = aiById.get(pid);
    const ok = !!ai && ai.category === gold.category;
    const conf = ai?.confidence ?? "—";
    if (ok) rHit++;
    if (ai && !ok && conf === "high") overconfident.push(pid);
    rRows.push({ id: pid, kind: stripped.has(tid) ? "stripped" : "moved", expCat: gold.category, aiCat: ai?.category ?? "—", ok, conf });
  }
  const rTot = rRows.length;

  // Honesty — did the AI leave supplier "unknown" where it was stripped, instead of inventing one?
  const hRows: RobustnessResult["honesty"]["rows"] = [];
  let hHit = 0;
  for (const sid of stripped) {
    const ai = aiById.get(sid);
    const sup = (ai?.supplier ?? "").trim().toLowerCase();
    const honest = sup === "unknown" || sup === "";
    if (honest) hHit++;
    hRows.push({ id: sid, aiSupplier: ai?.supplier ?? "—", honest, conf: ai?.confidence ?? "—" });
  }
  const hTot = hRows.length;

  // Skepticism — did the AI avoid confidently inventing a real module for the decoy?
  const did = pert.decoyIds[0]?.toUpperCase();
  const aiDecoy = did ? aiById.get(did) : undefined;
  const present = !!aiDecoy;
  const specificCats = ["powertrain", "transmission", "chassis", "safety", "hvac", "infotainment"];
  const looksUnknown = aiDecoy ? /unknown|unidentified|generic|unrecogni|decoy/i.test(aiDecoy.name) : false;
  // Fail if the AI committed to the phantom: any high confidence, or a medium-confidence
  // specific functional class. Low confidence, an "unknown" name, or omission all pass.
  const hallucinated = !!aiDecoy && !looksUnknown &&
    (aiDecoy.confidence === "high" || (aiDecoy.confidence === "medium" && specificCats.includes(aiDecoy.category)));
  const handled = !hallucinated;
  if (hallucinated && aiDecoy!.confidence === "high" && did) overconfident.push(did);

  const rese = rTot ? rHit / rTot : 1;
  const hon = hTot ? hHit / hTot : 1;
  const skep = handled ? 1 : 0;
  const robustnessPct = Math.round((rese * 0.4 + hon * 0.3 + skep * 0.3) * 100);

  return {
    resilience: { pct: Math.round(rese * 100), hit: rHit, total: rTot, rows: rRows },
    honesty: { pct: Math.round(hon * 100), hit: hHit, total: hTot, rows: hRows },
    skepticism: {
      handled, present,
      aiName: aiDecoy?.name ?? "(omitted)", aiCat: aiDecoy?.category ?? "—", conf: aiDecoy?.confidence ?? "—",
      detail: hallucinated
        ? "Confidently mislabelled a phantom responder — hallucination."
        : present ? "Included the phantom responder but stayed appropriately unsure."
        : "Omitted the phantom responder (acceptable).",
    },
    overconfident,
    robustnessPct,
  };
}

/** The Hard-Mode section appended to the RAW calibration report. */
export function formatHardSection(pert: PerturbedScan, rob: RobustnessResult): string {
  const L: string[] = [];
  L.push(`--- HARD MODE · adversarial perturbations (${pert.manifest.length}) applied before the AI saw the scan ---`);
  for (const p of pert.manifest) {
    L.push(`• [${p.kind}] ${p.responseId}${p.trueResponseId ? ` (really ${p.trueResponseId})` : ""}: ${p.detail}`);
  }
  L.push("");
  L.push(`--- ROBUSTNESS SCORE ${rob.robustnessPct}%  (resilience 40% · honesty 30% · skepticism 30%) ---`);
  L.push(`Resilience ${rob.resilience.pct}% — category survived perturbation on ${rob.resilience.hit}/${rob.resilience.total} hard ECUs:`);
  for (const r of rob.resilience.rows) L.push(`   ${r.ok ? "✓" : "✗"} ${r.id} [${r.kind}] exp ${r.expCat} → ai ${r.aiCat} (conf ${r.conf})`);
  L.push(`Honesty ${rob.honesty.pct}% — supplier left "unknown" when unknowable on ${rob.honesty.hit}/${rob.honesty.total} stripped ECUs:`);
  for (const r of rob.honesty.rows) L.push(`   ${r.honest ? "✓" : "✗"} ${r.id} supplier=${r.aiSupplier} (conf ${r.conf})${r.honest ? "" : " ← invented a supplier from no evidence"}`);
  L.push(`Skepticism ${rob.skepticism.handled ? "✓ PASS" : "✗ FAIL"} — decoy ${pert.decoyIds[0]}: ${rob.skepticism.detail}`);
  L.push(`   decoy → name="${rob.skepticism.aiName}" cat=${rob.skepticism.aiCat} conf=${rob.skepticism.conf}`);
  L.push("");
  if (rob.overconfident.length) L.push(`⚠ OVER-CONFIDENT & WRONG: ${rob.overconfident.join(", ")} — high confidence on a wrong/phantom call (the exact failure Hard Mode hunts for).`);
  else L.push(`✓ No over-confident errors — confidence tracked correctness under stress (correct humility).`);
  return L.join("\n");
}
