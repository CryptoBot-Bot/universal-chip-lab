import type { VehicleModuleExploration } from "@ecu/vehicle-db";

import {
  exploreModule,
  type ExplorerEvent,
  type ExplorerResult,
  type ExplorerSkeleton,
  type PriorKnowledge,
  type SeqItem,
  type BusFrame,
} from "./moduleExplorer";

/**
 * AI Vehicle Explorer — the whole-car deep mapper.
 *
 * Two stages, both live on the real bus through the Super Device:
 *   1. discoverModules: probe a spread of standard/OEM diagnostic addresses and
 *      keep every one that answers (positive OR negative — a 0x7F still proves an
 *      ECU is home). This is the "which modules can we talk to" step.
 *   2. deepMapVehicle: for EACH module, run the existing per-module explorer
 *      (moduleExplorer.exploreModule) seeded with everything we already know
 *      about that module on this YMM (prior + skeleton). The explorer verifies
 *      capabilities against the live bus and returns the canonical board; we fold
 *      it into the module's permanent record. Re-running deepens it every time.
 *
 * The engine is transport-agnostic: it takes a `deps` bundle so the same code
 * drives the real Pi (handlers wire it to /api/isotp + /api/bus/monitor).
 */

/** One candidate diagnostic address probed during discovery. */
export interface AddressCandidate { name: string; req: string; resp: string }

/**
 * A spread of standard ISO-15765-4 + common OEM 11-bit physical addresses. The
 * legislated powertrain block (7E0–7E7) plus the addresses most makers use for
 * ABS, SRS, body, gateway, steering, HVAC, cluster and ADAS. Discovery keeps
 * only the ones that actually respond, so probing extras is harmless.
 */
export const ADDRESS_CANDIDATES: AddressCandidate[] = [
  // Legislated powertrain block (req = resp − 8)
  { name: "ECM / powertrain", req: "7E0", resp: "7E8" },
  { name: "TCM / powertrain 2", req: "7E1", resp: "7E9" },
  { name: "Powertrain 3", req: "7E2", resp: "7EA" },
  { name: "Powertrain 4", req: "7E3", resp: "7EB" },
  { name: "Powertrain 5", req: "7E4", resp: "7EC" },
  { name: "Powertrain 6", req: "7E5", resp: "7ED" },
  { name: "Powertrain 7", req: "7E6", resp: "7EE" },
  { name: "Powertrain 8", req: "7E7", resp: "7EF" },
  // Common OEM physical addresses (req/resp offset varies by maker)
  { name: "ABS / brakes", req: "760", resp: "768" },
  { name: "ABS / skid (alt)", req: "7B0", resp: "7B8" },
  { name: "SRS / airbag", req: "780", resp: "788" },
  { name: "Body control (BCM)", req: "720", resp: "728" },
  { name: "Body / SmartKey (alt)", req: "740", resp: "748" },
  { name: "Central gateway", req: "710", resp: "718" },
  { name: "Gateway (alt)", req: "750", resp: "758" },
  { name: "Electric power steering", req: "730", resp: "738" },
  { name: "EPS (Toyota)", req: "7A6", resp: "7AE" },
  { name: "HVAC / climate", req: "7C0", resp: "7C8" },
  { name: "Instrument cluster", req: "7C4", resp: "7CC" },
  { name: "Forward radar / ADAS", req: "7D0", resp: "7D8" },
  { name: "Camera / ADAS 2", req: "7A0", resp: "7A8" },
  { name: "Immobiliser", req: "7C6", resp: "7CE" },
  { name: "Smart key / cert (Toyota)", req: "751", resp: "759" },
  { name: "Parking assist / sonar", req: "7B6", resp: "7BE" },
  { name: "Occupant / seat", req: "770", resp: "778" },
];

export interface DiscoveredModule {
  name: string;         // candidate label (a guess; the AI refines it)
  requestId: string;
  responseId: string;
  firstBytes: string;   // the response we got (positive or negative)
  negative: boolean;    // true if it answered 0x7F (still present)
}

export interface DiscoverDeps {
  /** One diagnostic request to a specific tx/rx pair. Returns the raw response hex, or null on no answer. */
  isotp: (tx: string, rx: string, data: string) => Promise<{ response?: string; negative?: boolean } | null>;
  onProgress?: (done: number, total: number, found: number) => void;
  shouldStop: () => boolean;
}

/** Probe every candidate address; keep the responders. Tester-present (3E00) is
 * the lightest universal presence probe — any reply, positive or negative, means
 * an ECU is listening on that address. */
export async function discoverModules(deps: DiscoverDeps, candidates = ADDRESS_CANDIDATES): Promise<DiscoveredModule[]> {
  const found: DiscoveredModule[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (deps.shouldStop()) break;
    const c = candidates[i];
    try {
      const r = await deps.isotp(c.req, c.resp, "3E00");
      if (r && r.response) {
        found.push({ name: c.name, requestId: c.req, responseId: c.resp, firstBytes: r.response, negative: !!r.negative });
      }
    } catch { /* no answer on this address */ }
    deps.onProgress?.(i + 1, candidates.length, found.length);
  }
  return found;
}

// ---- deep map (per-module exploration) -------------------------------------

/** A module to deep-map: its addressing + whatever we already know (for the prior/skeleton). */
export interface MapTarget {
  moduleId: string;         // stable id in the profile ("ecm", "resp-7e8", …)
  displayName: string;
  brand: string;
  category: string;
  protocol: string;         // "uds" | "kwp2000" | "obd2" | …
  requestId: string;
  responseId: string;
  prior?: VehicleModuleExploration;   // stored capability memory for this module on this YMM
}

export type VehicleExplorerEvent =
  | { type: "discover"; done: number; total: number; found: number }
  | { type: "module-start"; moduleId: string; displayName: string; index: number; total: number }
  | { type: "module-event"; moduleId: string; event: ExplorerEvent }
  | { type: "module-done"; moduleId: string; result: ExplorerResult }
  | { type: "status"; text: string }
  | { type: "error"; text: string };

export interface DeepMapDeps {
  iface: string;
  /** Sequence of ISO-TP requests over one socket to a tx/rx pair (session persists). */
  probe: (tx: string, rx: string, requests: string[]) => Promise<SeqItem[]>;
  /** Passive bus monitor for a window. */
  scanBus: (ms: number) => Promise<{ frames: BusFrame[]; window_ms?: number }>;
  onEvent: (e: VehicleExplorerEvent) => void;
  shouldStop: () => boolean;
}

/** Turn a stored exploration into the explorer's PriorKnowledge (the self-improving seed). */
export function priorFromExploration(x?: VehicleModuleExploration): PriorKnowledge | undefined {
  if (!x) return undefined;
  const caps = (x.operations ?? [])
    .filter((o) => o.status === "supported" || o.status === "gated")
    .map((o) => `${o.op}${o.status === "gated" ? " (gated)" : ""}`);
  return {
    runCount: x.runCount,
    identity: x.identity,
    services: x.services ?? [],
    capabilities: caps,
    dtcs: x.dtcs ?? [],
  };
}

/** Turn a stored exploration into the explorer's ExplorerSkeleton (the record to verify + fill). */
export function skeletonFromExploration(x?: VehicleModuleExploration): ExplorerSkeleton | undefined {
  if (!x) return undefined;
  return {
    partNumbers: x.identity ? [x.identity] : [],
    applications: [],
    sessions: x.sessions ?? [],
    services: x.services ?? [],
    identification: (x.identification ?? []).map((i) => ({ id: i.id, label: i.label, value: i.value, session: i.session })),
    liveData: (x.liveData ?? []).map((l) => ({ id: l.id, label: l.label, session: l.session })),
    broadcastFrames: x.broadcastFrames ?? [],
    operations: (x.operations ?? []).map((o) => ({ op: o.op, status: o.status, request: o.request, session: o.session })),
    dtcs: x.dtcs ?? [],
  };
}

/**
 * Deep-map a whole vehicle: run the per-module explorer for each target in turn,
 * streaming its events (tagged by module) and folding each result. Returns the
 * per-module results so the caller can persist them into the YMM profile.
 */
export async function deepMapVehicle(
  targets: MapTarget[],
  deps: DeepMapDeps,
): Promise<{ moduleId: string; result: ExplorerResult }[]> {
  const out: { moduleId: string; result: ExplorerResult }[] = [];
  for (let i = 0; i < targets.length; i++) {
    if (deps.shouldStop()) { deps.onEvent({ type: "status", text: "Stopped by operator." }); break; }
    const t = targets[i];
    deps.onEvent({ type: "module-start", moduleId: t.moduleId, displayName: t.displayName, index: i, total: targets.length });
    try {
      const result = await exploreModule(
        {
          displayName: t.displayName, brand: t.brand, category: t.category,
          protocol: t.protocol, requestId: t.requestId, responseId: t.responseId, iface: deps.iface,
          prior: priorFromExploration(t.prior),
          skeleton: skeletonFromExploration(t.prior),
        },
        {
          probe: (requests) => deps.probe(t.requestId, t.responseId, requests),
          scanBus: (ms) => deps.scanBus(ms),
          onEvent: (event) => deps.onEvent({ type: "module-event", moduleId: t.moduleId, event }),
          shouldStop: deps.shouldStop,
        },
      );
      out.push({ moduleId: t.moduleId, result });
      deps.onEvent({ type: "module-done", moduleId: t.moduleId, result });
    } catch (e) {
      deps.onEvent({ type: "error", text: `${t.displayName}: ${(e as Error).message}` });
    }
  }
  return out;
}

/** Reduce an ExplorerResult to the plain fold input the vehicle-db helper expects. */
export function resultToExplorationInput(r: ExplorerResult) {
  return {
    summary: r.summary,
    identity: r.identity,
    confidence: r.confidence,
    services: r.services,
    sessions: r.sessions,
    identification: r.identification,
    liveData: r.liveData,
    broadcastFrames: r.broadcastFrames,
    dtcs: r.dtcs,
    operations: (r.operations ?? []).map((o) => ({
      op: o.op,
      status: o.status as "supported" | "gated" | "unsupported" | "unknown",
      request: o.request, session: o.session, nrc: o.nrc, detail: o.detail,
    })),
  };
}
