/**
 * Read every module's identity — part numbers, software / hardware versions,
 * serial number, supplier, build date, the VIN it holds — and file it as THIS
 * car's module inventory. No AI: a fixed list of standard identification reads
 * (UDS 22 Fxxx, KWP 1A xx, Mercedes F1xx), decoded and saved, streamed live.
 *
 * Safety, in order:
 *   1. only identification reads are planned (moduleIdentity.ts — every request 22 / 1A);
 *   2. every request passes the read-only policy before it leaves this PC (readSeq);
 *   3. airbag / immobiliser modules are read in the session they are in — no session
 *      change, nothing else (the policy refuses it for them even if planned);
 *   4. other modules may be asked again in the extended session (10 03) for the
 *      records the default session refused, then returned to default (10 01);
 *   5. the Pi's write gate stands behind all of it.
 */
import {
  decodeIdentResponse, foldInventoryIntoProfile, IDENT_LABEL, identPlan, protectedModule, recordInventory, summarizeRecords,
} from "@ecu/vehicle-db";
import type { CarInventory, IdentRecord, IdentSpec, ModuleInventoryEntry, ProtectedKind, VehicleModule, VehicleProfile } from "@ecu/vehicle-db";
import { saveStoredVehicleProfile } from "@ecu/vehicle-db/vehicleStore";

import type { SeqItem } from "../resolver/moduleExplorer";
import { isDaimlerVin, type VehicleExplorerEvent } from "../resolver/vehicleExplorer";
import { loadLibrary, readSeq, RefusedRequest } from "./vehiclePipeline";

export interface IdentifyOptions {
  host?: string;
  iface: string;
  profile: VehicleProfile;
  /** The car's VIN — the inventory is filed under it. Without one it is only returned. */
  vin?: string;
  /** Only these modules (profile module ids). Default: every module with a diagnostic address. */
  moduleIds?: string[];
  /** Name of the simulator answering instead of a car, if one is — stamped on the inventory. */
  sim?: string | null;
  /** Ask refused records again in the extended session (not for protected modules). Default true. */
  extended?: boolean;
  onEvent?: (e: VehicleExplorerEvent) => void;
  shouldStop?: () => boolean;
}

/** Requests per sequence: small enough that records appear on screen as they are read. */
const CHUNK = 4;
/** NRC: the module does not know this service at all (a KWP module asked UDS 22, or vice versa). */
const NRC_SERVICE_NOT_SUPPORTED = 0x11;
/** NRCs worth a second ask in the extended session. */
const NRC_RETRY = new Set([0x31, 0x7f, 0x7e, 0x22, 0x33]);

function clean(s?: string | null): string {
  return (s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");
}

function nrcOf(it: SeqItem | undefined): number | null {
  if (!it) return null;
  if (typeof it.nrc === "number") return it.nrc;
  const r = (it.response ?? "").replace(/\s+/g, "").toLowerCase();
  return r.startsWith("7f") && r.length >= 6 ? parseInt(r.slice(4, 6), 16) : null;
}

/** The modules an identity read covers, in address order. */
export function identityTargets(profile: VehicleProfile, moduleIds?: string[]): VehicleModule[] {
  return profile.modules
    .filter((m) => clean(m.addressing?.request) && clean(m.addressing?.response))
    .filter((m) => !moduleIds?.length || moduleIds.includes(m.id))
    .sort((a, b) => clean(a.addressing!.response).localeCompare(clean(b.addressing!.response)));
}

async function readModule(o: IdentifyOptions, m: VehicleModule, mercedes: boolean, emit: (e: VehicleExplorerEvent) => void): Promise<ModuleInventoryEntry> {
  const tx = clean(m.addressing!.request), rx = clean(m.addressing!.response);
  const guard: ProtectedKind | undefined = protectedModule({ category: m.category, label: m.label })?.kind;
  const proto: "uds" | "kwp2000" | "unknown" = m.protocol === "kwp2000" ? "kwp2000" : m.protocol === "uds" || m.protocol === "obd2" ? "uds" : "unknown";
  const plan = identPlan(proto, { mercedes });
  const udsSpecs = plan.filter((s) => s.req.startsWith("22"));
  const kwpSpecs = plan.filter((s) => s.req.startsWith("1A"));

  const records: IdentRecord[] = [];
  const refused = new Map<string, number>();   // req → NRC
  let answered = false;
  let silentChunks = 0;

  const take = (spec: IdentSpec, it: SeqItem | undefined, session: string) => {
    if (!it || it.error || !it.response) return;
    answered = true;
    const nrc = nrcOf(it);
    if (nrc !== null) { refused.set(spec.req, nrc); return; }
    const d = decodeIdentResponse(spec, it.response);
    if (!d) return;
    // a date / version field that did not decode as one is kept, but not as a date or version
    const shapeless = (spec.decode === "bcdDate" && !/^\d{4}-\d\d-\d\d$/.test(d.value)) || (spec.decode === "mbVersion" && !/^\d\d\/\d\d \d\d( \/ \d\d\/\d\d \d\d)*$/.test(d.value));
    const rec: IdentRecord = shapeless
      ? { id: spec.id, key: "other", label: `${spec.label ?? IDENT_LABEL[spec.key]} (undecoded)`, value: d.value, raw: d.raw, session }
      : { id: spec.id, key: spec.key, label: spec.label ?? IDENT_LABEL[spec.key], value: d.value, raw: d.raw, session };
    records.push(rec);
    refused.delete(spec.req);
    emit({ type: "ident-record", moduleId: m.id, record: rec });
  };

  /** Ask a list of specs in small sequences. Stops early on silence or "service not supported". */
  const ask = async (specs: IdentSpec[], session: "01" | "03"): Promise<"done" | "silent" | "unsupported"> => {
    for (let i = 0; i < specs.length; i += CHUNK) {
      if (o.shouldStop?.()) return "done";
      const chunk = specs.slice(i, i + CHUNK);
      const requests = session === "03" ? ["1003", ...chunk.map((s) => s.req)] : chunk.map((s) => s.req);
      // 0.6 s per request: a module answers in ~50 ms or says "busy" (the device then waits
      // for it); only silence costs the full time, and a silent module is dropped after one chunk.
      const items = await readSeq(o.host, o.iface, tx, rx, requests, { protectedKind: guard ?? null, timeout: 0.6 });
      const body = session === "03" ? items.slice(1) : items;
      const before = answered;
      chunk.forEach((spec, k) => take(spec, body[k], session));
      const anyAnswer = body.some((it) => it && it.response && !it.error);
      if (!anyAnswer) { silentChunks += 1; if (!before && silentChunks >= 1 && i === 0) return "silent"; }
      // a module that does not speak this service answers 7F xx 11 to everything — move on
      if (body.length && body.every((it) => nrcOf(it) === NRC_SERVICE_NOT_SUPPORTED)) return "unsupported";
    }
    return "done";
  };

  let note: string | undefined;
  try {
    // pass 1 — the session the module is in (default)
    let udsOutcome: "done" | "silent" | "unsupported" | "skipped" = "skipped";
    if (udsSpecs.length) udsOutcome = await ask(udsSpecs, "01");
    if (udsOutcome === "silent" && !answered) {
      return { moduleId: m.id, label: m.label, requestId: tx, responseId: rx, protocol: proto, status: "no_response", records: [], summary: {}, ...(guard ? { protectedKind: guard } : {}) };
    }
    const udsRecords = records.length;
    if (kwpSpecs.length && (proto === "kwp2000" || udsOutcome === "unsupported" || udsRecords === 0)) {
      const k = await ask(kwpSpecs, "01");
      if (k === "silent" && !answered) {
        return { moduleId: m.id, label: m.label, requestId: tx, responseId: rx, protocol: proto, status: "no_response", records: [], summary: {}, ...(guard ? { protectedKind: guard } : {}) };
      }
    }
    // pass 2 — refused UDS records again in the extended session (never on protected modules)
    const have = new Set(records.map((r) => r.key));
    const again = udsSpecs.filter((s) => NRC_RETRY.has(refused.get(s.req) ?? -1) && !have.has(s.key));
    if (!guard && o.extended !== false && udsOutcome === "done" && again.length && !o.shouldStop?.()) {
      try { await ask(again, "03"); }
      finally {
        // back to the default session whatever happened (a read-only request)
        try { await readSeq(o.host, o.iface, tx, rx, ["1001"], { timeout: 0.6 }); } catch { /* it times back to default by itself */ }
      }
    }
    if (guard) note = "protected — read in its current session only, never explored";
  } catch (e) {
    if (e instanceof RefusedRequest) note = e.message;
    else if (/Cannot reach SuperDevice/.test((e as Error).message)) throw e;
    else note = (e as Error).message;
  }

  const summary = summarizeRecords(records);
  const status: ModuleInventoryEntry["status"] =
    records.length ? (summary.partNo || summary.serial || summary.swPartNo || summary.swVersion ? "ok" : "partial")
    : refused.size ? "refused" : answered ? "partial" : "no_response";
  const protocol: ModuleInventoryEntry["protocol"] =
    records.some((r) => r.id.startsWith("22")) ? "uds" : records.some((r) => r.id.startsWith("1A")) ? "kwp2000" : proto;
  return {
    moduleId: m.id, label: m.label, requestId: tx, responseId: rx, protocol, status, summary, records,
    ...(refused.size ? { refused: [...refused.keys()].map((q) => `${q.slice(0, 2)} ${q.slice(2)}`) } : {}),
    ...(guard ? { protectedKind: guard } : {}),
    ...(note ? { note } : {}),
  };
}

/** Read the identity of every addressed module of the car. Streams events; never writes. */
export async function identifyCar(o: IdentifyOptions): Promise<CarInventory> {
  const t0 = Date.now();
  const emit = (e: VehicleExplorerEvent) => { try { o.onEvent?.(e); } catch { /* listener gone */ } };
  const targets = identityTargets(o.profile, o.moduleIds);
  const mercedes = isDaimlerVin(o.vin) || /mercedes|daimler|freightliner/i.test(o.profile.make);
  emit({
    type: "ident-start", total: targets.length,
    modules: targets.map((m) => ({
      moduleId: m.id, label: m.label, requestId: clean(m.addressing?.request), responseId: clean(m.addressing?.response),
      protectedKind: protectedModule({ category: m.category, label: m.label })?.kind,
    })),
  });
  const modules: ModuleInventoryEntry[] = [];
  for (let i = 0; i < targets.length; i++) {
    if (o.shouldStop?.()) break;
    const m = targets[i];
    const guard = protectedModule({ category: m.category, label: m.label })?.kind;
    emit({ type: "ident-module", moduleId: m.id, label: m.label, index: i, total: targets.length, phase: "start", ...(guard ? { protectedKind: guard } : {}) });
    const entry = await readModule(o, m, mercedes, emit);
    modules.push(entry);
    emit({ type: "ident-module", moduleId: m.id, label: m.label, index: i, total: targets.length, phase: "done", entry, ...(guard ? { protectedKind: guard } : {}) });
  }
  const inventory: CarInventory = {
    at: new Date().toISOString(), iface: o.iface, durationMs: Date.now() - t0, modules,
    ...(o.sim ? { sim: o.sim } : {}),
  };
  emit({ type: "ident-done", inventory });
  return inventory;
}

/**
 * Read and file: the inventory goes under the car's VIN (per car: serial numbers),
 * the part numbers / versions also onto the model's modules where they were empty.
 * The profile is re-read from disk before saving, so a scan saved meanwhile is kept.
 */
export async function identifyAndSave(vehicleLibDir: string, o: IdentifyOptions): Promise<{ profile: VehicleProfile; inventory: CarInventory }> {
  const inventory = await identifyCar(o);
  const fresh = (await loadLibrary(vehicleLibDir)).find((p) => p.id === o.profile.id) ?? o.profile;
  let next: VehicleProfile = JSON.parse(JSON.stringify(fresh));
  if (o.vin) next = recordInventory(next, o.vin, inventory);
  next = foldInventoryIntoProfile(next, inventory);
  const now = new Date().toISOString();
  next.provenance = { ...next.provenance, updatedAt: now };
  await saveStoredVehicleProfile(vehicleLibDir, next, now);
  const saved = (await loadLibrary(vehicleLibDir)).find((p) => p.id === next.id) ?? next;
  return { profile: saved, inventory };
}
