/**
 * 5b + 5c for one module: recorded sweeps → prompt → proposals → check → saved on the module.
 * Offline. The prompt holds the module's own bytes per state of the car and nothing the check
 * uses: no measured voltage, engine speed or temperature — otherwise a match would prove nothing.
 */
import { checkLabels, findTracks, LABEL_KINDS, luckOfTracks, protectedModule, readsOf, varies } from "@ecu/vehicle-db";
import type { ConditionReads, LabelProposal, LabelValue, ModuleLabels, ModuleSweep, VehicleModule, VehicleProfile } from "@ecu/vehicle-db";
import { saveStoredVehicleProfile } from "@ecu/vehicle-db/vehicleStore";

import { askLabels, type LabelAnswer } from "../resolver/moduleLabeler";
import { loadLibrary } from "./vehiclePipeline";

/** Identifiers per question, and questions at once. */
const BATCH = 50;
const AT_ONCE = 3;
/** Bytes shown in full; longer data shows this much and where the rest changes. */
const SHOW = 96;

export interface LabelOptions {
  profile: VehicleProfile;
  moduleId: string;
  ask?: (content: string) => Promise<LabelAnswer>;
  onProgress?: (done: number, of: number) => void;
  shouldStop?: () => boolean;
  /** Proposals already on file: only identifiers without one are asked about. */
  keep?: { proposals: LabelProposal[]; invented: string[]; tokensIn: number; tokensOut: number; model: string };
}

/** A reply can leave identifiers out; they are asked about once more. */
const ROUNDS = 2;

const bytesOf = (hex: string) => hex.match(/../g) ?? [];
const textOf = (hex: string): string | null => {
  const b = bytesOf(hex).map((x) => parseInt(x, 16));
  const t = b.map((n) => (n >= 0x20 && n < 0x7f ? String.fromCharCode(n) : "·")).join("");
  return b.length >= 4 && b.filter((n) => n >= 0x20 && n < 0x7f).length / b.length > 0.7 ? t : null;
};

/** The VIN never goes into a prompt: its bytes are masked in place, so offsets stay true. */
export function maskVins(hex: string, vins: string[]): string {
  let out = hex.toUpperCase();
  for (const v of vins) {
    const h = Buffer.from(v, "ascii").toString("hex").toUpperCase();
    // the whole number, and the last 8 (serial part) on its own
    for (const p of [h, h.slice(-16)]) if (p.length >= 16) out = out.split(p).join("58".repeat(p.length / 2));
  }
  return out;
}

/** One identifier as one block of prompt text. */
export function rowOf(id: string, session: string, reads: ConditionReads[], vins: string[]): string {
  const masked = reads.map((r) => ({ condition: r.condition, reads: r.reads.map((x) => maskVins(x, vins)) }));
  const first = masked[0].reads[0];
  const all = masked.flatMap((r) => r.reads);
  const len = first.length / 2;
  const head = `${id} | session ${session} | ${len} byte${len === 1 ? "" : "s"}`;
  const show = (h: string) => (h.length / 2 > SHOW ? `${h.slice(0, SHOW * 2)}… (+${h.length / 2 - SHOW})` : h);
  const txt = textOf(first);
  if (new Set(all).size === 1) return `${head} | never changes | ${show(first)}${txt ? ` | text "${txt.slice(0, 80)}"` : ""}`;
  const lines = masked.map((r) => `   ${r.condition}: ${[...new Set(r.reads)].map(show).join("  then  ")}`);
  const n = Math.min(...all.map((h) => h.length / 2));
  const changed = Array.from({ length: n }, (_, i) => i).filter((i) => new Set(all.map((h) => h.slice(i * 2, i * 2 + 2))).size > 1);
  const late = changed.filter((i) => i >= SHOW).slice(0, 24).map((i) => `${i}: ${masked.map((r) => r.reads.map((h) => h.slice(i * 2, i * 2 + 2)).join("/")).join(" → ")}`);
  return [`${head} | changes at byte ${changed.slice(0, 40).join(",")}${changed.length > 40 ? "…" : ""}`, ...lines, ...(late.length ? [`   beyond byte ${SHOW}: ${late.join("; ")}`] : [])].join("\n");
}

export function promptFor(profile: VehicleProfile, m: VehicleModule, rows: string[], part: number, of: number): string {
  const vins = (profile.knownVins ?? []).map((v) => v.vin);
  const id = m.identity;
  const identity = [id?.supplier && `supplier ${id.supplier}`, id?.partNo && `part no. ${id.partNo}`, id?.hw && `hardware ${id.hw}`, id?.sw && `software ${id.sw}`].filter(Boolean).join(", ");
  const text = [
    `Vehicle: ${profile.year ?? "?"} ${profile.make} ${profile.model}${profile.trim ? ` ${profile.trim}` : ""}${profile.decoded?.engine ? `, ${profile.decoded.engine}` : ""}`,
    `Module: ${m.label} (${m.category}), ${m.protocol === "kwp2000" ? "KWP2000 on CAN" : "UDS on CAN"}${identity ? `, ${identity}` : ""}`,
    `States of the car: ${[...new Set((m.sweeps ?? []).map((s) => s.condition))].join("; ")}. The car stood still throughout.`,
    of > 1 ? `Part ${part} of ${of} of this module's identifiers.` : "",
    "", `Identifiers (${rows.length}):`, ...rows,
  ].filter((x, i) => x !== "" || i > 2).join("\n");
  // a VIN in clear text (identity lines) is masked too
  return vins.reduce((t, v) => t.split(v).join("[VIN]"), text);
}

const num = (x: unknown, d = 0): number => (typeof x === "number" && Number.isFinite(x) ? x : d);
const str = (x: unknown): string => (typeof x === "string" ? x : "");
/** Only well-formed proposals survive; everything else in the reply is ignored. */
export function parseProposals(list: unknown[]): LabelProposal[] {
  return list.map((x) => x as Record<string, unknown>).filter((x) => /^(22 [0-9A-F]{4}|(21|1A) [0-9A-F]{2})$/.test(str(x.id).toUpperCase())).map((x) => ({
    id: str(x.id).toUpperCase(),
    name: str(x.name).slice(0, 120) || "unnamed",
    kind: (LABEL_KINDS as string[]).includes(str(x.kind)) ? (str(x.kind) as LabelProposal["kind"]) : "unknown",
    confidence: (["low", "medium", "high"] as const).find((c) => c === x.confidence) ?? "low",
    why: str(x.why).slice(0, 240),
    values: (Array.isArray(x.values) ? x.values : []).slice(0, 8).map((v) => v as Record<string, unknown>).map((v): LabelValue => ({
      name: str(v.name).slice(0, 80), offset: num(v.offset, -1), length: num(v.length), signed: v.signed === true, factor: num(v.factor, 1), add: num(v.add), unit: str(v.unit).slice(0, 12),
    })),
  }));
}

/** The sweeps labels are made from: real ones if there are any, else the simulator's (sandbox library). */
export function labelSweeps(m: VehicleModule): ModuleSweep[] {
  const real = (m.sweeps ?? []).filter((s) => !s.sim);
  return real.length ? real : (m.sweeps ?? []);
}

/** Identifiers of this module that can be labelled, in a stable order. */
export function labelIds(m: VehicleModule): string[] {
  return [...readsOf(labelSweeps(m)).keys()].sort((a, b) => a.localeCompare(b));
}

export function labelPrompts(profile: VehicleProfile, m: VehicleModule, only?: string[]): string[] {
  const sweeps = labelSweeps(m);
  const all = readsOf(sweeps);
  const reads = only ? new Map(only.filter((id) => all.has(id)).map((id) => [id, all.get(id)!] as const)) : all;
  const session = new Map(sweeps.flatMap((s) => s.hits.map((h) => [h.id, h.session] as const)));
  const vins = (profile.knownVins ?? []).map((v) => v.vin);
  // changing identifiers together: they explain each other
  const ids = [...reads.keys()].sort((a, b) => Number(varies(reads.get(b)!)) - Number(varies(reads.get(a)!)) || a.localeCompare(b));
  const parts: string[][] = [];
  for (let i = 0; i < ids.length; i += BATCH) parts.push(ids.slice(i, i + BATCH));
  return parts.map((p, k) => promptFor(profile, m, p.map((id) => rowOf(id, session.get(id) ?? "01", reads.get(id)!, vins)), k + 1, parts.length));
}

export async function labelModule(o: LabelOptions): Promise<ModuleLabels> {
  const m = o.profile.modules.find((x) => x.id === o.moduleId);
  if (!m) throw new Error(`no module "${o.moduleId}" in ${o.profile.id}`);
  if (protectedModule({ category: m.category, label: m.label })) throw new Error(`${m.label} is an airbag / immobiliser module — it is never swept, so there is nothing to label`);
  const sweeps = labelSweeps(m);
  if (!readsOf(sweeps).size) throw new Error(`${m.label} has no sweep on file — sweep it first`);
  const got: LabelAnswer[] = [];
  const proposals: LabelProposal[] = [...(o.keep?.proposals ?? [])];
  let todo = labelIds(m);
  const left = () => { const have = new Set(proposals.map((p) => p.id)); return todo.filter((id) => !have.has(id)); };
  todo = left();
  for (let round = 0; round < ROUNDS && todo.length && !o.shouldStop?.(); round++) {
    const prompts = labelPrompts(o.profile, m, todo);
    const answers: LabelAnswer[] = new Array(prompts.length);
    let next = 0, done = 0;
    const worker = async () => {
      for (;;) {
        if (o.shouldStop?.()) return;
        const i = next++;
        if (i >= prompts.length) return;
        answers[i] = await (o.ask ?? askLabels)(prompts[i]);
        done += 1; o.onProgress?.(done, prompts.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, prompts.length) }, worker));
    for (const a of answers.filter(Boolean)) { got.push(a); proposals.push(...parseProposals(a.labels)); }
    todo = left();
  }
  if (!got.length && !o.keep) throw new Error("stopped before any answer");
  const { labels, invented: newInvented } = checkLabels(proposals, sweeps);
  const invented = [...new Set([...(o.keep?.invented ?? []), ...newInvented])];
  const reads = readsOf(sweeps);
  return {
    tracks: findTracks(reads), luck: luckOfTracks(reads),
    at: new Date().toISOString(), model: got[0]?.model ?? o.keep!.model, sweeps: sweeps.map((s) => ({ condition: s.condition, at: s.at })), labels, invented,
    tokensIn: got.reduce((n, a) => n + a.tokensIn, o.keep?.tokensIn ?? 0), tokensOut: got.reduce((n, a) => n + a.tokensOut, o.keep?.tokensOut ?? 0),
  };
}

/** 5c again, without the AI: the stored proposals against today's rules and every sweep on file. */
export async function recheckAndSave(vehicleLibDir: string, o: { profileId: string; moduleId: string }): Promise<{ profile: VehicleProfile; labels: ModuleLabels }> {
  return labelAndSave(vehicleLibDir, { ...o, keepStored: true, shouldStop: () => true });
}

/** Label one module and file the result on it (fresh profile from disk). */
export async function labelAndSave(vehicleLibDir: string, o: Omit<LabelOptions, "profile" | "keep"> & { profileId: string; /** keep what is on file, ask only about the rest */ keepStored?: boolean }): Promise<{ profile: VehicleProfile; labels: ModuleLabels }> {
  const profile = (await loadLibrary(vehicleLibDir)).find((p) => p.id === o.profileId);
  if (!profile) throw new Error(`no vehicle "${o.profileId}" in the library`);
  const stored = profile.modules.find((m) => m.id === o.moduleId)?.labels;
  if (o.keepStored && !stored) throw new Error("no labels on file for this module — label it first");
  const keep = o.keepStored && stored ? { proposals: stored.labels.map(({ check: _check, ...p }) => p), invented: stored.invented, tokensIn: stored.tokensIn, tokensOut: stored.tokensOut, model: stored.model } : undefined;
  const labels = await labelModule({ ...o, profile, keep });
  const fresh = (await loadLibrary(vehicleLibDir)).find((p) => p.id === o.profileId) ?? profile;
  const next: VehicleProfile = { ...fresh, modules: fresh.modules.map((x) => (x.id === o.moduleId ? { ...x, labels } : x)) };
  await saveStoredVehicleProfile(vehicleLibDir, next, new Date().toISOString());
  return { profile: (await loadLibrary(vehicleLibDir)).find((p) => p.id === o.profileId) ?? next, labels };
}
