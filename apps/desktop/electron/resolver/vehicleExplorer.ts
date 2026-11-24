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
  // Legislated powertrain block (ISO 15765-4, req = resp − 8) — every OBD car
  { name: "ECM / powertrain", req: "7E0", resp: "7E8" },
  { name: "TCM / powertrain 2", req: "7E1", resp: "7E9" },
  { name: "Powertrain 3", req: "7E2", resp: "7EA" },
  { name: "Powertrain 4", req: "7E3", resp: "7EB" },
  { name: "Powertrain 5", req: "7E4", resp: "7EC" },
  { name: "Powertrain 6", req: "7E5", resp: "7ED" },
  { name: "Powertrain 7", req: "7E6", resp: "7EE" },
  { name: "Powertrain 8", req: "7E7", resp: "7EF" },
  // Toyota / Lexus layout
  { name: "ABS / skid control (Toyota)", req: "7B0", resp: "7B8" },
  { name: "SRS / airbag", req: "780", resp: "788" },
  { name: "Body ECU (Toyota BCM) / cluster (Ford IPC)", req: "720", resp: "728" },
  { name: "Gateway (Toyota CGW)", req: "750", resp: "758" },
  { name: "Smart key / cert (Toyota)", req: "751", resp: "759" },
  { name: "EPS (Toyota)", req: "7A6", resp: "7AE" },
  { name: "HVAC / climate", req: "7C0", resp: "7C8" },
  { name: "Instrument cluster (Toyota)", req: "7C4", resp: "7CC" },
  { name: "Immobiliser", req: "7C6", resp: "7CE" },
  { name: "Forward radar / ADAS", req: "7D0", resp: "7D8" },
  { name: "Parking assist / sonar", req: "7B6", resp: "7BE" },
  { name: "Camera / ADAS 2", req: "7A0", resp: "7A8" },
  { name: "Occupant / seat", req: "770", resp: "778" },
  // Ford FEPS layout (+8)
  { name: "Camera / lane-keep (Ford CMR)", req: "706", resp: "70E" },
  { name: "Gateway (Ford GWM)", req: "716", resp: "71E" },
  { name: "Body control (Ford BCM)", req: "726", resp: "72E" },
  { name: "Power steering (Ford PSCM / Nissan SRS)", req: "730", resp: "738" },
  { name: "Restraints (Ford RCM)", req: "737", resp: "73F" },
  { name: "ABS (Ford / Honda / Nissan)", req: "760", resp: "768" },
  { name: "Audio / infotainment (Ford ACM)", req: "727", resp: "72F" },
  { name: "Trailer / 4x4 (Ford TCCM)", req: "761", resp: "769" },
  { name: "Parking aid (Ford PAM)", req: "736", resp: "73E" },
  // Honda / Nissan / Mercedes shared ranges (+8)
  { name: "Body / SmartKey (alt)", req: "740", resp: "748" },
  { name: "EPS (Nissan)", req: "742", resp: "74A" },
  { name: "Meter / ESP (alt)", req: "7A2", resp: "7AA" },
  // VAG (Audi / VW / Skoda / Seat) — response = request + 0x6A
  { name: "Gateway J533 (VAG)", req: "710", resp: "77A" },
  { name: "Gateway (alt +8)", req: "710", resp: "718" },
  { name: "Power steering J500 (VAG)", req: "712", resp: "77C" },
  { name: "ABS/ESC J104 (VAG)", req: "713", resp: "77D" },
  { name: "Instrument cluster J285 (VAG)", req: "714", resp: "77E" },
  { name: "Airbag J234 (VAG)", req: "715", resp: "77F" },
  { name: "Climate J255 (VAG)", req: "746", resp: "7B0" },
  { name: "Central electrics J519 (VAG)", req: "70E", resp: "778" },
  { name: "ACC radar J428 (VAG)", req: "767", resp: "7D1" },
  // BMW 0x6xx block (+8)
  { name: "DSC (BMW)", req: "6A0", resp: "6A8" },
  { name: "EPS (BMW)", req: "6B0", resp: "6B8" },
  { name: "ACSM airbag (BMW)", req: "6C0", resp: "6C8" },
  { name: "KOMBI (BMW)", req: "620", resp: "628" },
  { name: "ZGW gateway (BMW)", req: "660", resp: "668" },
  { name: "KAFAS camera (BMW)", req: "670", resp: "678" },
  // 29-bit ISO 15765-4 physical addressing (Honda/Acura 2016+, some others): 18DA<ta>F1 → 18DAF1<ta>
  { name: "ECM (29-bit)", req: "18DA10F1", resp: "18DAF110" },
  { name: "TCM (29-bit)", req: "18DA18F1", resp: "18DAF118" },
  { name: "ABS/VSA (29-bit)", req: "18DA28F1", resp: "18DAF128" },
  { name: "SRS (29-bit)", req: "18DA53F1", resp: "18DAF153" },
  { name: "EPS (29-bit)", req: "18DA30F1", resp: "18DAF130" },
  { name: "Body / gauge (29-bit)", req: "18DA60F1", resp: "18DAF160" },
  { name: "Gateway (29-bit)", req: "18DA0EF1", resp: "18DAF10E" },
  // GM 11-bit (response = request + 0x400)
  { name: "BCM (GM)", req: "241", resp: "641" },
  { name: "EBCM (GM)", req: "243", resp: "643" },
  { name: "SDM airbag (GM)", req: "247", resp: "647" },
  { name: "IPC (GM)", req: "24C", resp: "64C" },
];

/**
 * Mercedes-Benz / Daimler diagnostic nodes — NOT on the generic list: they answer on
 * their own scheme (request 0x6xx/0x7xx → response 0x4Ex/0x4Fx, or request + 1), mostly
 * KWP2000-on-CAN. Found by a tester-present sweep of 0x600–0x7FF on a 2015 Sprinter 3500
 * (NCV3, OM642) on 2026-11-23; every one gave a Mercedes part number.
 * Probed only when a responder's VIN says Daimler (see isDaimlerVin), so other makes
 * never see frames on these IDs. Names are placeholders — the census names them.
 */
export const MERCEDES_CANDIDATES: AddressCandidate[] = [
  { name: "Mercedes node 662 (KWP)", req: "662", resp: "4E2" },
  { name: "Mercedes node 6A5 (UDS)", req: "6A5", resp: "4E5" },
  { name: "Mercedes node 6BC (KWP)", req: "6BC", resp: "4FC" },
  { name: "Mercedes node 6C8 (KWP)", req: "6C8", resp: "4E8" },
  { name: "Mercedes node 726 (KWP)", req: "726", resp: "4E6" },
  { name: "Mercedes node 72E (KWP)", req: "72E", resp: "4EE" },
  { name: "Mercedes node 784 (UDS)", req: "784", resp: "785" },
  { name: "Mercedes node 788 (KWP)", req: "788", resp: "789" },
  { name: "Mercedes node 791 (KWP)", req: "791", resp: "4F1" },
  { name: "Mercedes node 792 (KWP)", req: "792", resp: "793" },
  { name: "Mercedes node 794 (KWP)", req: "794", resp: "795" },
  { name: "Mercedes node 796 (KWP)", req: "796", resp: "797" },
];

/** Daimler / Mercedes-Benz WMIs: WD* (Germany, incl. Sprinter for Dodge/Freightliner),
 * W1K/N/V/W/X/Y/Z (2019+), 4JG / 55S (US-built). */
export function isDaimlerVin(vin?: string): boolean {
  return /^(WD[A-Z0-9]|W1[KNVWXYZ]|4JG|55S)/i.test((vin ?? "").trim());
}

/** Identification strings read off a responder during discovery (UDS 22 Fxxx). */
export interface DiscoveredIdent { partNo?: string; supplier?: string; sw?: string; hw?: string; serial?: string; vin?: string }

export interface DiscoveredModule {
  name: string;         // candidate label (a guess; the AI refines it)
  requestId: string;
  responseId: string;
  firstBytes: string;   // the response we got (positive or negative)
  negative: boolean;    // true if it answered 0x7F (still present)
  ident?: DiscoveredIdent; // what it says it is — the bus fingerprint the identity resolver keys on
}

export interface DiscoverDeps {
  /** One diagnostic request to a specific tx/rx pair. Returns the raw response hex, or null on no answer. */
  isotp: (tx: string, rx: string, data: string) => Promise<{ response?: string; negative?: boolean } | null>;
  /** Optional: a sequence over one socket — enables the identification pass (22 F187/F190/F18A/F195/F191/F18C). */
  probe?: (tx: string, rx: string, requests: string[]) => Promise<SeqItem[]>;
  onProgress?: (done: number, total: number, found: number) => void;
  shouldStop: () => boolean;
}

/** The standard identification DIDs every discovery reads — cheap, read-only,
 * and the strongest "which module / which car is this" evidence there is. */
export const IDENT_DIDS: { did: string; key: keyof DiscoveredIdent }[] = [
  { did: "F187", key: "partNo" },   // manufacturer spare part number
  { did: "F190", key: "vin" },      // VIN as this module knows it
  { did: "F18A", key: "supplier" }, // system supplier
  { did: "F195", key: "sw" },       // software version
  { did: "F191", key: "hw" },       // hardware number
  { did: "F18C", key: "serial" },   // ECU serial
  // Mercedes-Benz answers its own identification DIDs instead of F187/F195/F191
  // (seen on a 2015 Sprinter: F187 → 7F 22 31, F111 → "6429011100" = A 642 901 11 00).
  // Read after the standard ones and used only where those gave nothing.
  { did: "F111", key: "partNo" },   // MB hardware part number
  { did: "F121", key: "sw" },       // MB software part number(s)
];

/** KWP2000 ReadEcuIdentification (1A) options — for KWP-on-CAN modules that refuse
 * every 22 read (the Sprinter's EGS: 22 → 7F 22 11, 1A 87 → part number, 1A 90 → VIN). */
export const KWP_IDENT: { req: string; key: keyof DiscoveredIdent }[] = [
  { req: "1A87", key: "partNo" },
  { req: "1A90", key: "vin" },
];

/** The longest printable run of a KWP 5A xx response (its ASCII field), if one is long enough. */
export function kwpIdentText(hexResp?: string): string | undefined {
  const clean = (hexResp || "").replace(/\s+/g, "");
  if (clean.length < 6 || !clean.toLowerCase().startsWith("5a")) return undefined;
  const bytes = (clean.slice(4).match(/../g) ?? []).map((b) => parseInt(b, 16));
  let best = "", cur = "";
  for (const n of bytes) {
    if (n >= 0x20 && n < 0x7f) { cur += String.fromCharCode(n); if (cur.trim().length > best.length) best = cur.trim(); }
    else cur = "";
  }
  return best.length >= 6 ? best : undefined;
}

/** Decode a 62 Fxxx positive response to printable ASCII (or a short hex if not text). */
export function identText(hexResp?: string): string | undefined {
  const clean = (hexResp || "").replace(/\s+/g, "");
  if (clean.length < 6 || !clean.toLowerCase().startsWith("62")) return undefined;
  const bytes = clean.slice(6).match(/../g) ?? [];
  if (!bytes.length) return undefined;
  const txt = bytes.map((b) => { const n = parseInt(b, 16); return n >= 32 && n < 127 ? String.fromCharCode(n) : n === 0 ? "" : "·"; }).join("").trim();
  const printable = txt.replace(/·/g, "");
  if (printable.length >= 3 && printable.length >= txt.length * 0.6) return printable;
  return bytes.join("").toUpperCase().slice(0, 32);
}

/** Read the standard identification DIDs from one responder. Never throws. */
export async function readIdent(probe: NonNullable<DiscoverDeps["probe"]>, tx: string, rx: string): Promise<DiscoveredIdent | undefined> {
  try {
    const items = await probe(tx, rx, IDENT_DIDS.map((d) => `22${d.did}`));
    const out: DiscoveredIdent = {};
    let any = false;
    items.forEach((it, i) => {
      const spec = IDENT_DIDS[i];
      if (!spec || !it || it.negative || !it.response) return;
      const v = identText(it.response);
      if (v && !out[spec.key]) { out[spec.key] = v; any = true; }
    });
    if (!any) {
      const kwp = await probe(tx, rx, KWP_IDENT.map((k) => k.req));
      kwp.forEach((it, i) => {
        const spec = KWP_IDENT[i];
        if (!spec || !it || it.negative || !it.response) return;
        let v = kwpIdentText(it.response);
        // a part number is the trailing digit run — a status byte before it can be printable ("G9069013501")
        if (v && spec.key === "partNo") v = v.match(/\d{10,}$/)?.[0] ?? v;
        if (v && !out[spec.key]) { out[spec.key] = v; any = true; }
      });
    }
    return any ? out : undefined;
  } catch { return undefined; }
}

/** Probe every candidate address; keep the responders. Tester-present (3E00) is
 * the lightest universal presence probe — any reply, positive or negative, means
 * an ECU is listening on that address. */
export async function discoverModules(deps: DiscoverDeps, candidates = ADDRESS_CANDIDATES): Promise<DiscoveredModule[]> {
  const found: DiscoveredModule[] = [];
  const list = [...candidates];
  let makerBlockAdded = false;
  for (let i = 0; i < list.length; i++) {
    if (deps.shouldStop()) break;
    const c = list[i];
    try {
      const r = await deps.isotp(c.req, c.resp, "3E00");
      if (r && r.response) {
        const ident = deps.probe ? await readIdent(deps.probe, c.req, c.resp) : undefined;
        found.push({ name: c.name, requestId: c.req, responseId: c.resp, firstBytes: r.response, negative: !!r.negative, ident });
      }
    } catch { /* no answer on this address */ }
    // End of the generic pass: a Daimler VIN from any responder adds the Mercedes block.
    if (i === list.length - 1 && !makerBlockAdded && found.some((f) => isDaimlerVin(f.ident?.vin))) {
      makerBlockAdded = true;
      const have = new Set(list.map((x) => `${x.req}>${x.resp}`));
      list.push(...MERCEDES_CANDIDATES.filter((x) => !have.has(`${x.req}>${x.resp}`)));
    }
    deps.onProgress?.(i + 1, list.length, found.length);
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
  identity?: { partNo?: string; supplier?: string; sw?: string; hw?: string; serial?: string }; // read by discovery
  summary?: string;                   // census line
  vehicle?: string;                   // "2020 Toyota Corolla LE"
}

export type VehicleExplorerEvent =
  | { type: "discover"; done: number; total: number; found: number }
  | { type: "sweep"; ok: boolean; found: number; seconds?: number }
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
export function skeletonFromExploration(x?: VehicleModuleExploration, identity?: MapTarget["identity"]): ExplorerSkeleton | undefined {
  const parts = [identity?.partNo, x?.identity].filter((p): p is string => !!p);
  if (!x) {
    if (!parts.length) return undefined;
    return { partNumbers: parts, applications: [], sessions: [], services: [], identification: [], liveData: [], broadcastFrames: [], operations: [], dtcs: [] };
  }
  return {
    partNumbers: parts,
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
          skeleton: skeletonFromExploration(t.prior, t.identity),
          discovered: t.identity, summary: t.summary, vehicle: t.vehicle,
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
