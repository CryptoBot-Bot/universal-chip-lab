/**
 * Diagnostics engine for the scan-tool flow (routes/DiagnosticsTab): talk to one
 * system over the Super Device, read its fault memory, and turn what the library
 * knows about a module into concrete requests. No React in here.
 *
 * The library's per-module knowledge was written by an AI explorer, so its fields
 * are loosely shaped ("22 0100", "0C", "F190", session "03" or "default/OBD").
 * Every helper below normalises before anything is sent — a request that is not
 * clean hex is dropped, never guessed.
 */
import { PIDS, firstRefusal, protectedModule, ymmProfileId } from "@ecu/vehicle-db";
import type {
  BodyType, ScanDtc, SystemScanResult, VehicleModule, VehicleProfile, VehicleSystemCategory,
} from "@ecu/vehicle-db";

import { Api } from "./api";
import { decodeObdPid, identifierAscii, parseKwpDtcsFromHex, parseObdDtcsFromHex, parseUdsDtcsFromHex, type DtcRow } from "./uds";

export interface SeqItem { request: string; response?: string; ok?: boolean; negative?: boolean; nrc?: number | null; error?: string; gated?: boolean }

export const clean = (h?: string) => (h || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
export const fmt = (h?: string) => clean(h).replace(/(..)/g, "$1 ").trim();
export const respNorm = clean;

const NRC: Record<number, string> = {
  0x10: "general reject", 0x11: "service not supported", 0x12: "sub-function not supported", 0x13: "wrong length/format",
  0x21: "busy — repeat request", 0x22: "conditions not correct", 0x24: "request sequence error", 0x31: "request out of range",
  0x33: "security access denied", 0x35: "invalid key", 0x36: "exceeded attempts", 0x37: "required time delay",
  0x7e: "sub-function not in active session", 0x7f: "service not in active session",
};
export const nrcText = (n?: number | null) => (n == null ? "" : `NRC 0x${n.toString(16).toUpperCase().padStart(2, "0")}${NRC[n] ? ` — ${NRC[n]}` : ""}`);

/** One or more requests to one system over ONE socket (so a session persists across them). */
export async function seq(host: string, iface: string, mod: VehicleModule, requests: string[], timeout = 2.0): Promise<SeqItem[]> {
  const tx = clean(mod.addressing?.request), rx = clean(mod.addressing?.response);
  if (!tx || !rx) throw new Error(`${mod.label} has no diagnostic address yet — run Auto Scan first.`);
  const reqs = requests.map(clean).filter(Boolean);
  if (!reqs.length) return [];
  const out: SeqItem[] = [];
  // the device takes at most 24 requests per call
  for (let i = 0; i < reqs.length; i += 20) {
    const r = await Api.superDevice.post<{ ok: boolean; results?: SeqItem[]; error?: string }>(
      host, "/api/isotp/seq", { iface, tx, rx, requests: reqs.slice(i, i + 20), timeout },
    );
    if (!r.results) throw new Error(r.error || "the device did not run the request");
    out.push(...r.results);
  }
  return out;
}

/** Airbag / immobiliser? Then only identity and fault-memory reads, in its current session. */
export function guardOf(mod: VehicleModule) {
  return protectedModule({ category: mod.category, label: mod.label })?.kind ?? null;
}

/**
 * The read path: every request passes the shared read-only policy before it is sent
 * (packages/vehicle-db/src/readPolicy.ts). Scans, identification and live data use
 * this; only the operator-confirmed erase / manual write paths use `seq` directly
 * (and the device's write gate refuses those while it is read-only).
 */
export async function readSeqFor(host: string, iface: string, mod: VehicleModule, requests: string[], timeout = 2.0): Promise<SeqItem[]> {
  const bad = firstRefusal(requests, { protectedKind: guardOf(mod) });
  if (bad) throw new Error(`Not sent — ${bad}`);
  return seq(host, iface, mod, requests, timeout);
}

// ---- normalising what the library knows ------------------------------------------------

/** "03" / "10 03" / "1003" → "1003"; "default", "01", "OBD", "" → "" (no opener). */
export function sessionOpener(s?: string): string {
  const raw = (s || "").trim();
  if (!raw || /default|obd|none/i.test(raw)) return "";
  const c = clean(raw);
  if (c.length === 2) return c === "01" ? "" : `10${c}`;
  if (c.length === 4 && c.startsWith("10")) return c === "1001" ? "" : c;
  return "";
}

/** Does this system sit in the legislated OBD block (so J1979 modes 01/03/07 apply)? */
export function isObdEcu(mod: VehicleModule): boolean {
  const rx = clean(mod.addressing?.response);
  return /^7E[89A-F]$/.test(rx) || /^18DAF1/.test(rx);
}

/** The session most reads on this system want: extended if the map saw it accepted. */
export function preferredSession(mod: VehicleModule): string {
  const ids = (mod.explored?.sessions ?? []).map((s) => sessionOpener(s.id));
  if (ids.includes("1003")) return "1003";
  return ids.find(Boolean) ?? "";
}

export interface LiveItem { key: string; request: string; session: string; label: string; note?: string; obd: boolean }

/** Turn one stored live-data / identification entry into the request that reads it, or null. */
function requestOf(mod: VehicleModule, id: string, explicit?: string, label = ""): { request: string; obd: boolean } | null {
  const e = clean(explicit);
  if (e.length >= 4 && e.length % 2 === 0) return { request: e, obd: e.startsWith("01") || e.startsWith("09") };
  const c = clean(id);
  if (!c || c.length % 2) return null;
  if (c.length === 2) return isObdEcu(mod) && !/kwp|local.?id|service 2[12]/i.test(label) ? { request: `01${c}`, obd: true } : null; // bare OBD PID
  if (c.length === 4) {
    if (/^\s*0[19]\s/.test(id)) return { request: c, obd: true };                                 // "01 0C", "09 02"
    if (c.startsWith("21") || c.startsWith("1A")) return { request: c, obd: false };              // KWP local id
    return { request: `22${c}`, obd: false };                                                     // bare DID
  }
  if (c.startsWith("22") || c.startsWith("21") || c.startsWith("01") || c.startsWith("09")) return { request: c, obd: c.startsWith("01") || c.startsWith("09") };
  return null;
}

/** SAE J1979 mode-01 PIDs worth showing as live values (bitmaps, monitor status and
 * sensor-presence PIDs are left out), named the way scan tools name them. */
export const OBD_LIVE_PIDS: Record<number, string> = {
  0x04: "Calculated engine load", 0x05: "Coolant temperature", 0x06: "Short term fuel trim B1", 0x07: "Long term fuel trim B1",
  0x08: "Short term fuel trim B2", 0x09: "Long term fuel trim B2", 0x0a: "Fuel pressure", 0x0b: "Intake manifold pressure",
  0x0c: "Engine RPM", 0x0d: "Vehicle speed", 0x0e: "Timing advance", 0x0f: "Intake air temperature", 0x10: "MAF air flow rate",
  0x11: "Throttle position", 0x1f: "Run time since engine start", 0x21: "Distance with MIL on", 0x22: "Fuel rail pressure (rel.)",
  0x23: "Fuel rail pressure", 0x2c: "Commanded EGR", 0x2d: "EGR error", 0x2e: "Commanded evaporative purge", 0x2f: "Fuel tank level",
  0x30: "Warm-ups since codes cleared", 0x31: "Distance since codes cleared", 0x33: "Barometric pressure",
  0x3c: "Catalyst temperature B1S1", 0x3d: "Catalyst temperature B2S1", 0x3e: "Catalyst temperature B1S2", 0x3f: "Catalyst temperature B2S2",
  0x42: "Control module voltage", 0x43: "Absolute load", 0x45: "Relative throttle position", 0x46: "Ambient air temperature",
  0x47: "Absolute throttle position B", 0x49: "Accelerator pedal position D", 0x4a: "Accelerator pedal position E",
  0x4b: "Accelerator pedal position F", 0x4d: "Time run with MIL on", 0x4e: "Time since codes cleared", 0x52: "Ethanol fuel %",
  0x59: "Fuel rail absolute pressure", 0x5a: "Relative accelerator pedal position", 0x5b: "Hybrid battery remaining",
  0x5c: "Engine oil temperature", 0x5d: "Fuel injection timing", 0x5e: "Engine fuel rate", 0x61: "Driver's demand torque",
  0x62: "Actual engine torque", 0x63: "Engine reference torque", 0xa6: "Odometer",
};

/** The mode-01 PIDs an emissions ECU says it supports (01 00 / 20 / 40 … bitmaps, chained
 * while the last bit says "more"). Empty when it will not tell. */
export async function obdSupportedPids(host: string, iface: string, mod: VehicleModule): Promise<number[]> {
  const out: number[] = [];
  for (let base = 0; base <= 0xc0; base += 0x20) {
    const it = (await readSeqFor(host, iface, mod, [`01${base.toString(16).toUpperCase().padStart(2, "0")}`], 1.5))[0];
    const b = (it?.response ?? "").replace(/\s+/g, "");
    if (!it || it.negative || !b.toLowerCase().startsWith("41") || b.length < 12) break;
    const bits = parseInt(b.slice(4, 12), 16) >>> 0;
    for (let i = 0; i < 32; i++) if (bits & (1 << (31 - i))) out.push(base + i + 1);
    if (!(bits & 1)) break;
  }
  return out;
}

/** Every live value the library knows how to read on this system. `obdPids` (from
 * obdSupportedPids) replaces the fixed starter set with what this ECU really supports. */
export function liveItems(mod: VehicleModule, obdPids?: number[]): LiveItem[] {
  const out: LiveItem[] = [];
  const seen = new Set<string>();
  for (const l of mod.explored?.liveData ?? []) {
    const r = requestOf(mod, l.id, (l as { request?: string }).request, l.label);
    if (!r || seen.has(r.request)) continue;
    seen.add(r.request);
    const note = l.note && l.note.length > 110 ? `${l.note.slice(0, 108)}…` : l.note;
    out.push({ key: r.request, request: r.request, session: r.obd ? "" : sessionOpener(l.session) || preferredSession(mod), label: l.label, note, obd: r.obd });
  }
  if (isObdEcu(mod) && (obdPids?.length || !out.length)) {
    const pids = obdPids?.length ? obdPids.filter((p) => OBD_LIVE_PIDS[p]) : [0x0c, 0x0d, 0x05, 0x04, 0x11, 0x0f];
    for (const pid of pids) {
      const request = `01${pid.toString(16).toUpperCase().padStart(2, "0")}`;
      if (seen.has(request)) continue;
      seen.add(request);
      out.push({ key: request, request, session: "", label: OBD_LIVE_PIDS[pid] ?? PIDS.find((p) => p.pid === pid)?.name ?? request, obd: true });
    }
  }
  return out;
}

const STD_IDENT: { did: string; label: string }[] = [
  { did: "F190", label: "VIN" }, { did: "F187", label: "Part number" }, { did: "F18A", label: "Supplier" },
  { did: "F195", label: "Software version" }, { did: "F191", label: "Hardware number" }, { did: "F18C", label: "Serial number" },
  { did: "F18B", label: "Build date" }, { did: "F189", label: "Software number" }, { did: "F197", label: "System name" },
];

export interface IdentRow { key: string; label: string; value: string; request: string; live: boolean }

/** What we already hold about this system's identity, without touching the car. */
export function storedIdent(mod: VehicleModule): IdentRow[] {
  const rows: IdentRow[] = [];
  const add = (key: string, label: string, value?: string, request = "") => {
    if (value && !rows.some((r) => r.key === key)) rows.push({ key, label, value, request, live: false });
  };
  add("F187", "Part number", mod.identity?.partNo); add("F18A", "Supplier", mod.identity?.supplier);
  add("F195", "Software version", mod.identity?.sw); add("F191", "Hardware number", mod.identity?.hw); add("F18C", "Serial number", mod.identity?.serial);
  for (const i of mod.explored?.identification ?? []) {
    const r = requestOf(mod, i.id, (i as { request?: string }).request);
    add(r?.request.slice(2) ?? clean(i.id), i.label, i.value, r?.request);
  }
  return rows;
}

/** Read the identification block live. Standard DIDs + whatever the map found. */
export async function readIdent(host: string, iface: string, mod: VehicleModule): Promise<IdentRow[]> {
  const reqs = new Map<string, string>(STD_IDENT.map((s) => [`22${s.did}`, s.label]));
  for (const i of mod.explored?.identification ?? []) {
    const r = requestOf(mod, i.id, (i as { request?: string }).request);
    if (r && !reqs.has(r.request)) reqs.set(r.request, i.label);
  }
  const list = [...reqs.keys()];
  const session = guardOf(mod) ? null : preferredSession(mod);
  const items = await readSeqFor(host, iface, mod, session ? [session, ...list] : list);
  const body = session ? items.slice(1) : items;
  const rows: IdentRow[] = [];
  body.forEach((it, k) => {
    if (!it.response || it.negative) return;
    const request = list[k];
    const ascii = identifierAscii(it.response);
    const data = fmt(it.response).split(" ").slice(request.startsWith("22") ? 3 : 2).join(" ");
    rows.push({ key: request.slice(2), label: reqs.get(request) ?? request, value: ascii.length >= 2 ? ascii : data, request, live: true });
  });
  return rows;
}

// ---- fault memory ------------------------------------------------------------------------

const DTC_RE = /^[PCBU][0-9A-F]{4}/i;

/** A description for a code: the built-in table first, then what the map wrote down for it. */
function describe(mod: VehicleModule, row: DtcRow): string {
  const base = row.code.slice(0, 5).toUpperCase();
  const known = (mod.explored?.dtcs ?? []).find((d) => DTC_RE.test(d.code) && d.code.slice(0, 5).toUpperCase() === base);
  const builtin = row.description && !/^(unknown|manufacturer|generic)/i.test(row.description) ? row.description : "";
  // what the map wrote is a note to itself (raw bytes, how it was read) — keep the first sentence
  const learned = (known?.desc ?? "").split(/\.\s/)[0].replace(/\s*\((failure-type|status|raw)[^)]*\)\s*$/i, "").replace(/\.$/, "").trim();
  return builtin || learned || row.description || "";
}

export interface DtcReadResult { status: SystemScanResult["status"]; dtcs: ScanDtc[]; note?: string }

/**
 * Read one system's fault memory. Presence and the UDS read share a socket; a
 * refusal that means "not in this session" is retried in the extended session; an
 * emissions ECU is also asked the J1979 way (stored / pending / permanent). A
 * system that answers but refuses every read is "unknown" — never "no fault".
 */
export async function readDtcs(host: string, iface: string, mod: VehicleModule): Promise<DtcReadResult> {
  let items = await readSeqFor(host, iface, mod, ["3E00", "1902FF"], 1.2);
  if (!items.some((it) => it.response)) return { status: "no_response", dtcs: [] };
  let uds = items[1];
  // a refusal "not in this session" is retried in the extended session — never on an
  // airbag / immobiliser module, which is only read in the session it is in
  if (uds?.negative && [0x7f, 0x7e, 0x22, 0x31].includes(Number(uds.nrc)) && !guardOf(mod)) {
    items = await readSeqFor(host, iface, mod, ["1003", "1902FF"], 2.0);
    uds = items[1];
  }
  const rows: DtcRow[] = [];
  let answered = false;
  if (uds?.response && !uds.negative) { answered = true; rows.push(...parseUdsDtcsFromHex(uds.response)); }
  const notes: string[] = [];
  if (uds?.negative) {
    // KWP2000-on-CAN modules (e.g. a Mercedes EGS) refuse service 19 outright and
    // keep their fault memory behind KWP 18 02 FF 00 (all DTCs with their status).
    const kwp = (await readSeqFor(host, iface, mod, ["1802FF00"], 2.0))[0];
    if (kwp?.response && !kwp.negative) { answered = true; rows.push(...parseKwpDtcsFromHex(kwp.response)); }
    else notes.push(`19 02 refused (${nrcText(uds.nrc)})${kwp?.negative ? `; KWP 18 02 refused (${nrcText(kwp.nrc)})` : ""}`);
  }
  if (isObdEcu(mod)) {
    const obd = await readSeqFor(host, iface, mod, ["03", "07", "0A"], 2.0);
    for (const it of obd) {
      if (!it.response || it.negative) continue;
      answered = true;
      for (const r of parseObdDtcsFromHex(it.response)) {
        const hit = rows.find((x) => x.code.slice(0, 5) === r.code.slice(0, 5));
        if (!hit) rows.push(r);
        else if (r.status && !hit.status.includes(r.status)) hit.status = `${hit.status} · ${r.status}`;
      }
    }
  }
  if (!answered) return { status: "unknown", dtcs: [], note: notes.join("; ") || "answered, but would not report its fault memory" };
  const dtcs = rows.map((r) => ({ code: r.code, description: describe(mod, r), status: r.status }));
  return { status: dtcs.length ? "fault" : "ok", dtcs, note: notes.join("; ") || undefined };
}

/** Clear one system's fault memory. The caller has already confirmed with the operator. */
export async function clearDtcs(host: string, iface: string, mod: VehicleModule): Promise<{ ok: boolean; detail: string }> {
  let items = await seq(host, iface, mod, ["14FFFFFF"], 3.0);
  let it = items[0];
  if (it?.negative && [0x7f, 0x7e, 0x22].includes(Number(it.nrc))) {
    items = await seq(host, iface, mod, ["1003", "14FFFFFF"], 3.0);
    it = items[1];
  }
  if (it?.response && !it.negative) return { ok: true, detail: "fault memory cleared (14 FF FF FF)" };
  if (isObdEcu(mod)) {
    const obd = (await seq(host, iface, mod, ["04"], 3.0))[0];
    if (obd?.response && !obd.negative) return { ok: true, detail: "cleared the OBD way (mode 04)" };
  }
  if (it?.gated) return { ok: false, detail: "not sent — the device is read-only (its write gate refuses every write)" };
  return { ok: false, detail: !it?.response ? (it?.error || "no response to the clear request") : `refused — ${nrcText(it.nrc)}` };
}

export function scanResult(mod: VehicleModule, r: DtcReadResult): SystemScanResult {
  return {
    moduleId: mod.id, label: mod.label, requestId: mod.addressing?.request, responseId: clean(mod.addressing?.response),
    status: r.status, dtcs: r.dtcs, note: r.note,
  };
}

// ---- live values -------------------------------------------------------------------------


export interface LiveValue { key: string; value: string; raw: string; ok: boolean }

/** Read a set of live items once. Items are grouped by the session they need. */
export async function readLive(host: string, iface: string, mod: VehicleModule, items: LiveItem[]): Promise<LiveValue[]> {
  const out: LiveValue[] = [];
  const bySession = new Map<string, LiveItem[]>();
  for (const it of items) bySession.set(it.session, [...(bySession.get(it.session) ?? []), it]);
  // The device runs at most 24 requests per sequence (and ignores the rest), so a long
  // selection goes in chunks — each with its session opener.
  const CHUNK = 20;
  const chunks: [string, LiveItem[]][] = [];
  for (const [session, all] of bySession) for (let i = 0; i < all.length; i += CHUNK) chunks.push([session, all.slice(i, i + CHUNK)]);
  for (const [session, group] of chunks) {
    const reqs = group.map((g) => g.request);
    const res = await readSeqFor(host, iface, mod, session && !guardOf(mod) ? [session, ...reqs] : reqs, 1.5);
    const body = session && !guardOf(mod) ? res.slice(1) : res;
    group.forEach((g, k) => {
      const it = body[k];
      if (!it?.response) { out.push({ key: g.key, value: "no response", raw: "", ok: false }); return; }
      if (it.negative) { out.push({ key: g.key, value: nrcText(it.nrc), raw: fmt(it.response), ok: false }); return; }
      const dec = g.obd ? decodeObdPid(g.request, it.response) : null;
      const bytes = fmt(it.response).split(" ").slice(g.request.startsWith("22") ? 3 : 2);
      const n = bytes.length && bytes.length <= 4 ? parseInt(bytes.join(""), 16) : NaN;
      const value = dec ?? (Number.isFinite(n) ? `${n}  (0x${bytes.join("")})` : bytes.join(" "));
      out.push({ key: g.key, value, raw: fmt(it.response), ok: true });
    });
  }
  return out;
}

// ---- vehicle selection helpers -----------------------------------------------------------

/** Makes offered on the selection screen even before the library has one of them. */
export const COMMON_MAKES = [
  "Acura", "Audi", "BMW", "Buick", "Cadillac", "Chevrolet", "Chrysler", "Dodge", "Ford", "GMC", "Honda", "Hyundai",
  "Infiniti", "Jeep", "Kia", "Land Rover", "Lexus", "Lincoln", "Mazda", "Mercedes-Benz", "MINI", "Mitsubishi", "Nissan",
  "Porsche", "Ram", "Subaru", "Tesla", "Toyota", "Volkswagen", "Volvo",
];

/** A library vehicle the operator named by hand (make / model / year) — the floor
 * every OBD car has (the engine ECU); Auto Scan fills in the rest. */
export function manualProfile(year: number | null, make: string, model: string, now: string): VehicleProfile {
  return {
    id: ymmProfileId(year, make, model),
    year, make, model, bodyType: "sedan" as BodyType,
    wmi: [],
    buses: [{ id: "hs-can", label: "HS-CAN", protocol: "CAN", bitrate: 500000, obdPins: "6/14" }],
    modules: [
      { id: "ecm", label: "Engine Control Module", category: "powertrain", bus: "hs-can", location: "engine", addressing: { request: "7E0", response: "7E8" } },
    ],
    supportedPids: PIDS.map((p) => p.pid),
    capabilities: [],
    notes: "Entered by hand on the vehicle-selection screen — Auto Scan maps its systems.",
    provenance: { source: "user", confidence: 0.6, createdAt: now },
  };
}

export const CATEGORY_LABEL: Record<VehicleSystemCategory, string> = {
  powertrain: "Powertrain", transmission: "Transmission", chassis: "Chassis", body: "Body", infotainment: "Instrument & Infotainment",
  safety: "Safety", network: "Network", hvac: "Climate", other: "Other",
};
export const CATEGORY_ORDER: VehicleSystemCategory[] = ["powertrain", "transmission", "chassis", "safety", "body", "hvac", "infotainment", "network", "other"];

/** Systems with a diagnostic address, in address order — the rows of the scan list. */
export function addressedSystems(profile: VehicleProfile): VehicleModule[] {
  return profile.modules.filter((m) => clean(m.addressing?.response)).slice()
    .sort((a, b) => clean(a.addressing!.response).localeCompare(clean(b.addressing!.response)));
}

export const ymmLabel = (p: { year: number | null; make: string; model: string }) => [p.year, p.make, p.model].filter(Boolean).join(" ");

/** "EZS — Electronic Ignition Switch / …" → { short: "EZS", name: "Electronic Ignition Switch / …" };
 *  "CDI Engine Control Unit (ECM, OM642 …)" → { short: "ECM", name: "CDI Engine Control Unit" }. */
export function splitLabel(label: string): { short: string; name: string } {
  const dash = /^([A-Z][A-Za-z0-9-]{1,8})\s+[—–-]\s+(.+)$/.exec(label);
  if (dash) return { short: dash[1], name: dash[2].replace(/\s*\(.*$/, "") };
  const before = label.replace(/\s*\(.*$/, "").replace(/\s+[—–]\s+.*$/, "").trim();
  const paren = /\(([A-Z]{2,5})(?:[,)\s])/.exec(label);
  if (paren) return { short: paren[1], name: before || label };
  const lead = /^([A-Z]{2,6})\b/.exec(label);
  if (lead) return { short: lead[1], name: before.replace(/^[A-Z]{2,6}\s*(\/\s*)?/, "") || before };
  const first = label.split(/[\s/(]+/)[0] || label;
  return { short: first.length > 10 ? first.slice(0, 10) : first, name: before };
}
