import type { ModuleCategory, VehicleBrand } from "./moduleProfile.schema.js";

/**
 * Bus knowledge — the durable, growing record of what we have learned by
 * actually TALKING to a system on a vehicle's CAN bus.
 *
 * Where {@link ModuleProfile} describes a module for the byte-exact *clone*
 * goal (its MCU, its memories, how to reach the silicon), a
 * {@link BusModuleKnowledge} describes a module as it appears ON THE WIRE: how
 * it is addressed, what diagnostic protocol it speaks, which sessions/services/
 * data-identifiers it answers, and — the useful part — the concrete
 * *capabilities* (things we can do to it) with the exact command bytes.
 *
 * Seed records ship inside this package, so they travel with every published
 * build. Records the operator (or the AI mapper) learns are persisted to disk
 * by {@link busKnowledgeStore} and merged on top, so the knowledge base grows
 * every time we connect to a new network and can later be "baked" back into the
 * seed to ship with the next release.
 */

/** Diagnostic dialect a module speaks on the bus. */
export type BusProtocol =
  | "uds"          // ISO 14229, modern (0x22 ReadDataByIdentifier, 0x19 DTCs, …)
  | "kwp2000"      // ISO 14230-on-CAN, older (0x21 ReadByLocalId, 0x1A EcuId, …)
  | "obd2"         // ISO 15031 generic OBD-II (modes 0x01/0x03/0x09)
  | "j1939"        // heavy-duty
  | "gmlan"        // GM-specific (GMLAN / class-2 style)
  | "proprietary"
  | "unknown";

/** How much we trust a record — and therefore how it is styled/gated in the UI. */
export type BusTrust =
  | "seed"           // shipped with the app
  | "bench_observed" // confirmed against a real module on the bench/car
  | "ai_suggested";  // drafted by the AI mapper, not yet confirmed on silicon

export type RiskLevel = "read" | "write" | "caution";

/** A diagnostic session the module accepts (KWP StartDiagnosticSession / UDS 0x10). */
export interface BusSession {
  /** Full request bytes, hex, space-optional (e.g. "10 81"). */
  request: string;
  /** Human name ("Standard diagnostic session", "Programming session"). */
  name: string;
  /** Observed positive response, hex (e.g. "50 81"), if known. */
  response?: string;
  note?: string;
}

/** A service (SID) and whether the module supports it. */
export interface BusService {
  /** Service id, hex (e.g. "22", "21", "19"). */
  sid: string;
  name: string;
  supported: boolean;
  /** For a rejected service, the negative-response code seen (e.g. "11", "7F"). */
  nrc?: string;
  note?: string;
}

/** A readable data item (UDS DID or KWP local identifier) and what it returns. */
export interface BusDataId {
  /** Full request bytes, hex (e.g. "21 F0" KWP local-id, "22 F1 90" UDS DID). */
  request: string;
  /** What it is / decodes to ("Hardware/part identifier", "VIN", …). */
  name: string;
  /** Session this read requires, hex request (e.g. "10 81"), if gated. */
  session?: string;
  /** A captured positive response, hex, as evidence. */
  sampleResponse?: string;
  /** Human decode of the sample ("ASCII '1XJ3A…' — part/calibration id"). */
  decoded?: string;
}

/** A concrete thing the operator can DO to this module — the payoff. */
export interface BusCapability {
  title: string;
  /** Plain-language what it does / when to use it. */
  how: string;
  /** Exact command sequence to run, in order (hex requests to the request id). */
  commands: string[];
  risk: RiskLevel;
  note?: string;
}

/** How to recognise this module from live bus traffic alone. */
export interface BusFingerprint {
  /** Diagnostic response id, hex (e.g. "7E9"). The primary key for matching. */
  responseId?: string;
  /** Arbitration ids this module is seen broadcasting, hex (e.g. ["1F0","174"]). */
  broadcastIds: string[];
  /** Optional distinctive data signature (e.g. a fixed 21 F0 id block). */
  signature?: string;
}

export interface BusModuleKnowledge {
  /** Stable slug id (e.g. "gm_tcm_7e9_kwp"). */
  id: string;
  label: string;
  category: ModuleCategory;
  brand?: VehicleBrand;
  /** Free-form vehicle/application hint ("bench TCM", "2010s GM 6-speed"). */
  appliesTo?: string;

  protocol: BusProtocol;
  addressing: {
    /** Request id, hex (where we send), e.g. "7E1". */
    request: string;
    /** Response id, hex (what we hear back), e.g. "7E9". */
    response: string;
  };

  fingerprint: BusFingerprint;
  sessions: BusSession[];
  services: BusService[];
  dataIdentifiers: BusDataId[];
  capabilities: BusCapability[];
  notes: string;

  provenance: {
    source: BusTrust;
    confidence: "low" | "medium" | "high";
    createdAt: string;
    updatedAt?: string;
    /** AI model that drafted it, when source = ai_suggested. */
    model?: string;
    /** ISO date the observation was captured. */
    observedOn?: string;
  };
}

export type BusKnowledgeMap = Record<string, BusModuleKnowledge>;

/** Normalises a hex id/byte string to compact uppercase ("7e1" → "7E1", "10 81" → "1081"). */
export function normHex(s: string): string {
  return (s ?? "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

/**
 * A fingerprint match key. Two records describe the same module when their
 * response id matches; falling back to the id itself when no response id.
 */
export function fingerprintKey(k: Pick<BusModuleKnowledge, "id" | "fingerprint">): string {
  const resp = normHex(k.fingerprint?.responseId ?? "");
  return resp || k.id;
}

/** Finds the known record whose response id matches a live response id, if any. */
export function matchByResponseId(
  known: BusModuleKnowledge[],
  responseIdHex: string,
): BusModuleKnowledge | undefined {
  const want = normHex(responseIdHex);
  if (!want) return undefined;
  return known.find((k) => normHex(k.fingerprint?.responseId ?? "") === want);
}

export function validateBusModuleKnowledge(p: unknown): asserts p is BusModuleKnowledge {
  if (typeof p !== "object" || p === null) {
    throw new Error("Bus knowledge must be an object.");
  }
  const m = p as Record<string, unknown>;
  for (const k of [
    "id",
    "label",
    "category",
    "protocol",
    "addressing",
    "fingerprint",
    "sessions",
    "services",
    "dataIdentifiers",
    "capabilities",
    "notes",
    "provenance",
  ]) {
    if (!(k in m)) throw new Error(`Bus knowledge missing field: ${k}`);
  }
  if (typeof (m.id as string) !== "string" || !(m.id as string).trim()) {
    throw new Error("Bus knowledge id must be a non-empty string.");
  }
  const addr = m.addressing as Record<string, unknown> | null;
  if (!addr || typeof addr.request !== "string" || typeof addr.response !== "string") {
    throw new Error("Bus knowledge addressing must have request + response strings.");
  }
  for (const arrKey of ["sessions", "services", "dataIdentifiers", "capabilities"]) {
    if (!Array.isArray(m[arrKey])) throw new Error(`Bus knowledge ${arrKey} must be an array.`);
  }
  const prov = m.provenance as Record<string, unknown> | null;
  if (!prov || typeof prov.source !== "string") {
    throw new Error("Bus knowledge provenance.source is required.");
  }
}
