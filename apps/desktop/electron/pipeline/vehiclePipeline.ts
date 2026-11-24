/**
 * The vehicle pipeline — VIN → identity → discover → census → deep-map → capture —
 * as plain functions with NO Electron in them. Two front ends drive the same code:
 *   • the app: electron/ipc/handlers.ts wraps each step in an IPC channel;
 *   • the command line: cli/vehicle.ts (pnpm --filter @ecu/desktop vehicle …).
 * So what is debugged at the car from the command line is what the app runs.
 *
 * Every step talks to the Super Device over its HTTP API (piGet / piPost) and
 * keeps the vehicle library on disk through @ecu/vehicle-db's store.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyCensus, bindVinIdentity, censusInputFor, firstRefusal, foldDiscoveredModules, foldExploration, mergeVehicleProfiles,
  SEED_VEHICLE_PROFILES,
} from "@ecu/vehicle-db";
import type { ProtectedKind } from "@ecu/vehicle-db";
import type {
  CanonicalModule, DiscoveredModuleInput, OnlineVinDecode, VehicleModule, VehicleProfile, VehicleSystemCategory, VinBinding,
} from "@ecu/vehicle-db";
import { loadStoredVehicleProfiles, saveStoredVehicleProfile } from "@ecu/vehicle-db/vehicleStore";

import type { BusFrame, SeqItem } from "../resolver/moduleExplorer";
import {
  ADDRESS_CANDIDATES, deepMapVehicle, discoverModules, resultToExplorationInput,
  type AddressCandidate, type DeepMapDeps, type DiscoveredModule, type MapTarget, type SweepProgress, type VehicleExplorerEvent,
} from "../resolver/vehicleExplorer";
import { censusModules, type CensusResult } from "../resolver/vehicleIdentifier";
import { decodeVinOnline } from "../resolver/vinOnline";

// ---- Super Device HTTP client -------------------------------------------------

/** Talk to the SuperDevice Pi's HTTP API (the renderer is behind CSP, the CLI has no browser). */
export const DEFAULT_PI_HOST = "superdevice.local:8080";

function piBase(host: string | undefined): string {
  return (host && host.trim()) || DEFAULT_PI_HOST;
}

export async function piGet(host: string | undefined, pathq: string, timeoutMs = 8000): Promise<unknown> {
  const h = piBase(host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${h}${pathq}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`SuperDevice HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot reach SuperDevice at ${h} — ${m}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function piPost(host: string | undefined, pathq: string, body: unknown, timeoutMs = 8000): Promise<unknown> {
  const h = piBase(host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${h}${pathq}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`SuperDevice HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot reach SuperDevice at ${h} — ${m}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---- the read-only transport -------------------------------------------------------

/** Thrown when a request is stopped on this PC before it reaches the device. */
export class RefusedRequest extends Error {}

/**
 * One request to one module — through the read-only policy first. Every automatic
 * request the pipeline composes (discovery, identity, sweep, deep map) goes through readOne /
 * readSeq; a write never leaves this PC from here. Not covered: the fixed list in
 * captureDiagnostics, and what the device's daemon sends itself (VIN read, address sweep).
 * (The Pi's write gate is a second, independent wall behind this one.)
 */
export async function readOne(host: string | undefined, iface: string, tx: string, rx: string, data: string,
  opts: { protectedKind?: ProtectedKind | null; timeout?: number } = {}): Promise<{ response?: string; negative?: boolean; nrc?: number } | null> {
  const bad = firstRefusal([data], { protectedKind: opts.protectedKind ?? null });
  if (bad) throw new RefusedRequest(`Refused before sending — ${bad}`);
  const r = (await piPost(host, "/api/isotp", { iface, tx, rx, data, timeout: opts.timeout ?? 0.45 })) as { response?: string; negative?: boolean; nrc?: number };
  return r && r.response ? r : null;
}

/** A sequence over one socket (a session opener stays in force) — every request checked first. */
export async function readSeq(host: string | undefined, iface: string, tx: string, rx: string, requests: string[],
  opts: { protectedKind?: ProtectedKind | null; timeout?: number; httpTimeoutMs?: number } = {}): Promise<SeqItem[]> {
  const bad = firstRefusal(requests, { protectedKind: opts.protectedKind ?? null });
  if (bad) throw new RefusedRequest(`Refused before sending — ${bad}`);
  const r = (await piPost(host, "/api/isotp/seq", { iface, tx, rx, requests, timeout: opts.timeout ?? 1.0 }, opts.httpTimeoutMs ?? 45000)) as { results?: SeqItem[] };
  return r.results ?? [];
}

// ---- VIN → identity -------------------------------------------------------------

export interface VinReadResult { ok: boolean; vin?: string; raw?: string; via?: string; error?: string; tried?: string[] }

/** Read the VIN off the live bus (the daemon tries physical, functional, UDS and 29-bit). */
export async function readVin(host: string | undefined, iface: string): Promise<VinReadResult> {
  return (await piGet(host, `/api/vin?iface=${encodeURIComponent(iface)}`, 20000)) as VinReadResult;
}

export function vinDecodeCacheFile(vehicleLibDir: string): string {
  return path.join(vehicleLibDir, "vin-decode-cache.json");
}

/** The merged library (seed → community → learned), as the cockpit sees it. */
export async function loadLibrary(vehicleLibDir: string): Promise<VehicleProfile[]> {
  const { records } = await loadStoredVehicleProfiles(vehicleLibDir);
  return mergeVehicleProfiles(records);
}

export interface VinBindResult extends VinBinding { online: OnlineVinDecode; saved: VehicleProfile | null }

/**
 * VIN → NHTSA decode (cached) → bind an existing library profile or file a new
 * one, learn the unit, save. `saved` is null when nothing could be bound (no
 * certain match and NHTSA could not name the model) — the AI Identify stage or
 * the operator has to settle that; this step never guesses.
 */
export async function bindVin(vehicleLibDir: string, vin: string, now = new Date().toISOString()): Promise<VinBindResult> {
  const online = await decodeVinOnline(vin, vinDecodeCacheFile(vehicleLibDir));
  const binding = bindVinIdentity(await loadLibrary(vehicleLibDir), vin, online, now);
  let saved: VehicleProfile | null = null;
  if (binding.profile) {
    await saveStoredVehicleProfile(vehicleLibDir, binding.profile, now);
    saved = (await loadLibrary(vehicleLibDir)).find((p) => p.id === binding.profile!.id) ?? binding.profile;
  }
  return { ...binding, online, saved };
}

// ---- discovery --------------------------------------------------------------------

export interface DiscoverOptions {
  host?: string;
  iface: string;
  /** Read 22 F187/F190/F18A/F195/F191/F18C from every responder (default true). */
  ident?: boolean;
  /** Addresses this vehicle is already known to use (its profile's modules) — always
   * probed, so a module learned once (by a sweep, a maker block, a manual entry) is
   * asked again on every later scan instead of showing as "no response". */
  known?: AddressCandidate[];
  /** Also run the device's tester-present address sweep first (unknown makes / first visit). */
  deep?: boolean | { ext?: boolean };
  onProgress?: (done: number, total: number, found: number) => void;
  onSweep?: (r: SweepResult) => void;
  /** Live sweep state, about twice a second while the sweep runs (live address map). */
  onSweepProgress?: (p: SweepProgress) => void;
  /** Each responder as soon as it is confirmed. */
  onFound?: (m: DiscoveredModule) => void;
  shouldStop?: () => boolean;
}

export interface SweepResponder { req: string; resp: string; probe: string; data: string; kind: string; confirmed: boolean }
export interface SweepResult {
  ok: boolean; error?: string; iface?: string; probed?: number; seconds?: number;
  broadcast?: Record<string, number>; responders?: SweepResponder[]; unconfirmed?: SweepResponder[];
}

/** The device's safe address sweep (superdevice_ui.address_sweep): tester-present only,
 * never on an ID the bus uses, every hit confirmed. About a minute for 0x600-0x7FF. */
export async function sweepOnBus(host: string | undefined, iface: string,
  opts: { ext?: boolean; lo?: number; hi?: number; onProgress?: (p: SweepProgress) => void } = {}): Promise<SweepResult> {
  const run = piPost(host, "/api/scan/sweep", { iface, ext: !!opts.ext, lo: opts.lo ?? 0x600, hi: opts.hi ?? 0x7ff }, 240000) as Promise<SweepResult>;
  if (!opts.onProgress) return run;
  // The POST blocks until the sweep is done; meanwhile poll its status for the live map.
  // An older daemon has no status endpoint — then there is simply no live progress.
  let done = false;
  const poll = (async () => {
    let misses = 0;
    while (!done && misses < 3) {
      await new Promise((r) => setTimeout(r, 450));
      if (done) break;
      try { opts.onProgress!((await piGet(host, "/api/scan/sweep/status", 3000)) as SweepProgress); misses = 0; }
      catch { misses += 1; }
    }
  })();
  try { return await run; }
  finally {
    done = true;
    await poll;
    try { opts.onProgress((await piGet(host, "/api/scan/sweep/status", 3000)) as SweepProgress); } catch { /* old daemon */ }
  }
}

/** The addresses a profile already knows, as discovery candidates. */
export function knownAddressesOf(profile: VehicleProfile | null | undefined): AddressCandidate[] {
  return (profile?.modules ?? [])
    .filter((m) => m.addressing?.request && m.addressing?.response)
    .map((m) => ({ name: m.label || `Module at ${m.addressing!.response}`, req: m.addressing!.request!.toUpperCase(), resp: m.addressing!.response!.toUpperCase() }));
}

/** Generic list + the vehicle's known addresses + extras, each tx>rx pair once (generic names win). */
export function candidateList(...extra: (AddressCandidate[] | undefined)[]): AddressCandidate[] {
  const out: AddressCandidate[] = [];
  const have = new Set<string>();
  for (const c of [ADDRESS_CANDIDATES, ...extra].flatMap((x) => x ?? [])) {
    const k = `${c.req.toUpperCase()}>${c.resp.toUpperCase()}`;
    if (!have.has(k)) { have.add(k); out.push(c); }
  }
  return out;
}

/** Probe every candidate diagnostic address on the live bus; keep the responders. */
export async function discoverOnBus(o: DiscoverOptions): Promise<DiscoveredModule[]> {
  let swept: AddressCandidate[] = [];
  if (o.deep) {
    const r = await sweepOnBus(o.host, o.iface, { ...(typeof o.deep === "object" ? o.deep : {}), onProgress: o.onSweepProgress });
    o.onSweep?.(r);
    if (!r.ok) throw new Error(`Address sweep failed: ${r.error ?? "no answer from the device"}`);
    swept = (r.responders ?? []).map((h) => ({ name: `Found by sweep at ${h.req} (${h.kind})`, req: h.req, resp: h.resp }));
  }
  return discoverModules({
    isotp: async (tx, rx, data) => {
      const r = await readOne(o.host, o.iface, tx, rx, data);
      return r && r.response ? { response: r.response, negative: !!r.negative } : null;
    },
    // Identification pass (22 F187/F190/F18A/F195/F191/F18C) on every responder — on
    // by default: it is what lets the library recognise the car and its modules.
    probe: o.ident === false ? undefined : (tx, rx, requests) => readSeq(o.host, o.iface, tx, rx, requests),
    onProgress: o.onProgress,
    onFound: o.onFound,
    shouldStop: o.shouldStop ?? (() => false),
  }, candidateList(o.known, swept));
}

/**
 * Discovery as its own saving stage: persist the responders (address + lastSeen +
 * what each said it was) into the YMM profile, healing any pre-existing duplicate
 * module entries, and store the bus fingerprint. Returns the merged profile.
 */
export async function commitDiscovery(vehicleLibDir: string, profileIn: VehicleProfile, discovered: DiscoveredModuleInput[]): Promise<VehicleProfile> {
  const profile: VehicleProfile = JSON.parse(JSON.stringify(profileIn));
  const now = new Date().toISOString();
  // Canonical identities from the seed for this YMM, keyed by response id — so
  // a live responder adopts the real module name/category and old duplicates heal.
  const canonical = new Map<string, CanonicalModule>();
  const seed = SEED_VEHICLE_PROFILES.find((s) => s.id === profile.id);
  for (const m of seed?.modules ?? []) {
    const resp = (m.addressing?.response ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");
    if (resp) canonical.set(resp, { id: m.id, label: m.label, category: m.category, location: m.location, bus: m.bus });
  }
  profile.modules = foldDiscoveredModules(profile.modules, discovered ?? [], profile.buses[0]?.id || "hs-can", now, canonical);
  // The bus fingerprint — what answered and what each said it was — is how the
  // identity resolver and the AI recognise this vehicle next time.
  if ((discovered ?? []).length) {
    profile.fingerprint = {
      takenAt: now,
      responders: discovered.map((d) => d.responseId.toUpperCase()),
      ecus: discovered.map((d) => ({ responseId: d.responseId.toUpperCase(), requestId: d.requestId, ...(d.ident ?? {}) })),
      calId: profile.fingerprint?.calId, cvn: profile.fingerprint?.cvn,
    };
  }
  await saveStoredVehicleProfile(vehicleLibDir, profile, now);
  return (await loadLibrary(vehicleLibDir)).find((m) => m.id === profile.id) ?? profile;
}

/** The responders a profile remembers from its last discovery (its fingerprint),
 * in the shape discovery returns — so a census can run later without re-scanning. */
export function discoveredFromProfile(profile: VehicleProfile): DiscoveredModuleInput[] {
  const norm = (s?: string) => (s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");
  return (profile.fingerprint?.ecus ?? []).map((e) => {
    const mod = profile.modules.find((m) => norm(m.addressing?.response) === norm(e.responseId));
    const { responseId, requestId, ...ident } = e;
    return { name: mod?.label ?? `Module at ${responseId}`, requestId: requestId ?? mod?.addressing?.request ?? "", responseId, ident };
  });
}

// ---- census -----------------------------------------------------------------------

/** AI census of the discovered modules, folded into the profile and saved. */
export async function censusAndSave(vehicleLibDir: string, profile: VehicleProfile, discovered: DiscoveredModuleInput[]): Promise<{ profile: VehicleProfile; census: CensusResult }> {
  const census = await censusModules(censusInputFor(profile, discovered));
  const now = new Date().toISOString();
  const updated = applyCensus(profile, census.modules, now);
  await saveStoredVehicleProfile(vehicleLibDir, updated, now);
  return { profile: (await loadLibrary(vehicleLibDir)).find((p) => p.id === updated.id) ?? updated, census };
}

// ---- deep map ------------------------------------------------------------------------

const CATS: VehicleSystemCategory[] = ["powertrain", "transmission", "chassis", "body", "infotainment", "safety", "network", "hvac", "other"];
const coerceCat = (c?: string): VehicleSystemCategory => (CATS.includes(c as VehicleSystemCategory) ? (c as VehicleSystemCategory) : "other");

export interface DeepMapTargetInput { moduleId: string; displayName: string; brand: string; category: string; protocol: string; requestId: string; responseId: string }

/** The explorer target for one module of a profile (same rule as the cockpit's deep-map panel). */
export function targetFor(profile: VehicleProfile, m: VehicleModule): DeepMapTargetInput {
  const proto = profile.buses.find((b) => b.id === m.bus)?.protocol === "K-Line" ? "kwp2000" : "uds";
  return {
    moduleId: m.id, displayName: m.label, brand: profile.make, category: m.category,
    protocol: proto, requestId: m.addressing?.request ?? "", responseId: m.addressing?.response ?? "",
  };
}

export interface DeepMapOptions {
  host?: string;
  iface: string;
  profile: VehicleProfile;
  targets: DeepMapTargetInput[];
  vehicleLibDir: string;
  onEvent: (e: VehicleExplorerEvent) => void;
  shouldStop: () => boolean;
}

/**
 * Deep-map the given modules live (the read-only AI explorer per module), folding
 * each result into the profile and saving after every module. Returns the merged
 * profile as stored.
 */
export async function deepMapAndSave(o: DeepMapOptions): Promise<VehicleProfile> {
  const profile: VehicleProfile = JSON.parse(JSON.stringify(o.profile));
  const send = o.onEvent;

  const vehicleLabel = [profile.year, profile.make, profile.model, profile.trim].filter(Boolean).join(" ");
  const mapTargets: MapTarget[] = o.targets.map((t) => {
    const m = profile.modules.find((x) => x.id === t.moduleId);
    return {
      ...t,
      prior: m?.explored,
      identity: m?.identity ? { partNo: m.identity.partNo, supplier: m.identity.supplier, sw: m.identity.sw, hw: m.identity.hw, serial: m.identity.serial } : undefined,
      summary: m?.summary,
      vehicle: vehicleLabel,
    };
  });

  // Serialize the incremental saves so overlapping module-done events can't clobber the file.
  let saveChain: Promise<void> = Promise.resolve();

  const deps: DeepMapDeps = {
    iface: o.iface,
    probe: async (tx, rx, requests) => {
      const r = { results: await readSeq(o.host, o.iface, tx, rx, requests, { timeout: 2.0, httpTimeoutMs: 45000 }) };
      return r.results ?? [];
    },
    scanBus: async (ms) => {
      const r = (await piGet(o.host, `/api/bus/monitor?iface=${encodeURIComponent(o.iface)}&ms=${ms}`)) as { frames?: BusFrame[]; window_ms?: number };
      return { frames: r.frames ?? [], window_ms: r.window_ms };
    },
    onEvent: (e) => {
      send(e);
      if (e.type === "module-done") {
        const t = o.targets.find((x) => x.moduleId === e.moduleId);
        const now = new Date().toISOString();
        const input = resultToExplorationInput(e.result);
        saveChain = saveChain.then(async () => {
          let mod = profile.modules.find((m) => m.id === e.moduleId);
          if (!mod) {
            mod = {
              id: e.moduleId,
              label: t?.displayName || e.moduleId,
              category: coerceCat(t?.category),
              bus: profile.buses[0]?.id || "hs-can",
              location: "cabin_front",
              addressing: { request: t?.requestId, response: t?.responseId },
            } as VehicleModule;
            profile.modules.push(mod);
          }
          mod.explored = foldExploration(mod.explored, input, now, profile.knownVins?.[0]?.vin);
          try { await saveStoredVehicleProfile(o.vehicleLibDir, profile, now); }
          catch (err) { send({ type: "error", text: `save failed: ${(err as Error).message}` }); }
        });
      }
    },
    shouldStop: o.shouldStop,
  };

  await deepMapVehicle(mapTargets, deps);
  await saveChain;
  return (await loadLibrary(o.vehicleLibDir)).find((m) => m.id === profile.id) ?? profile;
}

// ---- diagnostic capture -----------------------------------------------------------------

export interface CaptureOptions {
  host?: string;
  iface: string;
  vin?: string;
  profile?: VehicleProfile;
  note?: string;
  extra?: unknown;
  /** <workspace>/reports */
  reportsDir: string;
  appVersion: string;
}

/**
 * Diagnostic capture — everything a remote troubleshooter (a Claude Code session
 * away from the car) needs to see what happened: device health, both buses, the
 * raw VIN attempts, a full discovery with identification strings, a bus snapshot,
 * and the vehicle profile as saved. Written under <workspace>/reports/.
 */
export async function captureDiagnostics(p: CaptureOptions): Promise<{ path: string; bytes: number; summary: string }> {
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const safe = async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (e) { errors.push(`${label}: ${(e as Error).message}`); return null; }
  };
  const status = await safe("status", () => piGet(p.host, "/api/status"));
  const device = await safe("device", () => piGet(p.host, "/api/device"));
  const sim = await safe("sim", () => piGet(p.host, "/api/sim/status"));
  const vinRead = await safe("vin", () => piGet(p.host, `/api/vin?iface=${encodeURIComponent(p.iface)}`, 20000));
  const busBefore = await safe("bus-monitor", () => piGet(p.host, `/api/bus/monitor?iface=${encodeURIComponent(p.iface)}&ms=1000`, 12000));
  const discovered = await safe("discovery", () => discoverOnBus({ host: p.host, iface: p.iface }));
  const obdBaseline = await safe("obd-baseline", () => piPost(p.host, "/api/isotp/seq", { iface: p.iface, tx: "7E0", rx: "7E8", requests: ["0100", "0120", "0902", "0904", "0906", "090A", "03", "07", "0A", "1003", "22F186", "1902FF"], timeout: 2.0 }, 45000));
  const capture = {
    kind: "chiplab-diagnostic-capture", version: 1, appVersion: p.appVersion, startedAt, finishedAt: new Date().toISOString(),
    host: p.host, iface: p.iface, note: p.note ?? "", vin: p.vin ?? (vinRead as { vin?: string } | null)?.vin ?? null,
    device: { status, device, sim },
    vinRead, busSnapshot: busBefore, discovered, obdBaseline,
    profile: p.profile ?? null, extra: p.extra ?? null, errors,
  };
  await mkdir(p.reportsDir, { recursive: true });
  const name = `capture-${(capture.vin || "novin").toString().replace(/[^A-Za-z0-9]/g, "")}-${startedAt.replace(/[:.]/g, "-")}.json`;
  const file = path.join(p.reportsDir, name);
  const text = JSON.stringify(capture, null, 2);
  await writeFile(file, text, "utf8");
  const n = Array.isArray(discovered) ? discovered.length : 0;
  return { path: file, bytes: Buffer.byteLength(text), summary: `${n} module(s) discovered · VIN ${capture.vin ?? "none"} · ${errors.length} error(s)` };
}
