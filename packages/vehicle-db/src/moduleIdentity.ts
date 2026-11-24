/**
 * Module identity — what every module of one car says it is: part numbers,
 * software / hardware versions, serial number, supplier, build date, the VIN it
 * holds. Read with plain identification reads only (UDS 22 Fxxx, KWP 1A xx).
 *
 * Model-level knowledge (which part number a 2015 Sprinter's ECM usually has) lives
 * on the profile's modules; the per-car facts (THIS van's ECM serial) live here, in
 * the car's VinObservation.inventory — a swapped module shows up as a changed serial.
 */
import type { ProtectedKind } from "./protectedModules.js";
import type { VehicleProfile } from "./vehicleProfile.schema.js";

export type IdentKey =
  | "vin" | "serial" | "partNo" | "hwPartNo" | "swPartNo" | "supplier" | "hwSupplierNo" | "swSupplierNo"
  | "hwVersion" | "swVersion" | "bootVersion" | "mfgDate" | "programmingDate" | "systemName" | "variant" | "appSw" | "other";

export const IDENT_LABEL: Record<IdentKey, string> = {
  vin: "VIN held by the module",
  serial: "Serial number",
  partNo: "Part number",
  hwPartNo: "Hardware part number",
  swPartNo: "Software part number",
  supplier: "Supplier",
  hwSupplierNo: "Supplier hardware number",
  swSupplierNo: "Supplier software number",
  hwVersion: "Hardware version",
  swVersion: "Software version",
  bootVersion: "Boot software version",
  mfgDate: "Manufacturing date",
  programmingDate: "Programming date",
  systemName: "System name",
  variant: "Diagnostic variant",
  appSw: "Application software",
  other: "Other",
};

export type IdentDecode = "text" | "bcdDate" | "mbVersion" | "hex" | "partList" | "auto";

export interface IdentSpec {
  /** Request without spaces: "22F18C", "1A8C". */
  req: string;
  key: IdentKey;
  decode: IdentDecode;
  /** Short name for the request in the UI ("22 F18C"). */
  id: string;
  /** Mercedes-specific DID (asked only after the standard ones, or on Daimler cars). */
  maker?: "mercedes";
  /** Overrides the key's label where the record is something more specific. */
  label?: string;
}

const uds = (did: string, key: IdentKey, decode: IdentDecode = "auto", maker?: "mercedes"): IdentSpec =>
  ({ req: `22${did}`, id: `22 ${did}`, key, decode, ...(maker ? { maker } : {}) });
const kwp = (lid: string, key: IdentKey, decode: IdentDecode = "auto", label?: string): IdentSpec =>
  ({ req: `1A${lid}`, id: `1A ${lid}`, key, decode, ...(label ? { label } : {}) });

/** ISO 14229-1 identification DIDs (all plain reads), then the Mercedes-Benz ones. */
export const UDS_IDENT: IdentSpec[] = [
  uds("F190", "vin", "text"),
  uds("F18C", "serial"),
  uds("F187", "partNo", "text"),
  uds("F191", "hwPartNo", "text"),
  uds("F188", "swPartNo", "text"),
  uds("F18A", "supplier"),
  uds("F192", "hwSupplierNo", "text"),
  uds("F193", "hwVersion"),
  uds("F194", "swSupplierNo", "text"),
  uds("F195", "swVersion"),
  uds("F189", "swVersion"),
  uds("F18B", "mfgDate", "bcdDate"),
  uds("F199", "programmingDate", "bcdDate"),
  uds("F197", "systemName", "text"),
  uds("F181", "appSw"),
  // Mercedes-Benz (seen on the 2015 Sprinter: F187 refused, F111 = "6429011100")
  uds("F111", "hwPartNo", "text", "mercedes"),
  uds("F121", "swPartNo", "partList", "mercedes"),
  uds("F150", "hwVersion", "mbVersion", "mercedes"),
  uds("F151", "swVersion", "mbVersion", "mercedes"),
  uds("F153", "bootVersion", "mbVersion", "mercedes"),
  uds("F154", "supplier", "hex", "mercedes"),
  uds("F100", "variant", "hex", "mercedes"),
];

/** ISO 14230-3 ReadEcuIdentification options (KWP2000, incl. KWP-on-CAN modules). */
export const KWP_IDENT: IdentSpec[] = [
  kwp("90", "vin", "text"),
  kwp("88", "vin", "text"),
  kwp("8C", "serial"),
  kwp("87", "partNo"),
  // Daimler DCS block: part number, hardware / software versions, supplier, date — packed BCD
  kwp("86", "other", "hex", "Daimler identification block"),
  kwp("91", "hwPartNo", "text"),
  kwp("8A", "supplier"),
  kwp("92", "hwSupplierNo", "text"),
  kwp("93", "hwVersion"),
  kwp("94", "swSupplierNo", "text"),
  kwp("95", "swVersion"),
  kwp("89", "variant", "hex"),
  kwp("8B", "mfgDate", "bcdDate"),
  kwp("99", "programmingDate", "bcdDate"),
  kwp("97", "systemName", "text"),
];

export interface IdentRecord {
  id: string;            // "22 F18C"
  key: IdentKey;
  label: string;
  value: string;
  /** The data bytes after the positive-response header, hex (capped). */
  raw?: string;
  /** "01" default, "03" extended — the session it answered in. */
  session?: string;
}

/** One module of one car, as read on one visit. */
export interface ModuleInventoryEntry {
  moduleId: string;
  label: string;
  requestId: string;
  responseId: string;
  protocol?: "uds" | "kwp2000" | "unknown";
  /** ok = identity read; partial = answered but gave little; refused = every read refused; no_response = silent. */
  status: "ok" | "partial" | "refused" | "no_response";
  /** Airbag / immobiliser: read in the default session only, never explored. */
  protectedKind?: ProtectedKind;
  /** The headline facts, best value per key. */
  summary: Partial<Record<IdentKey, string>>;
  records: IdentRecord[];
  /** Requests that were asked and refused (NRC) — so the next visit does not ask again. */
  refused?: string[];
  note?: string;
}

export interface CarInventory {
  at: string;            // ISO
  iface?: string;
  /** Name of the simulator that answered instead of a car, if one did. */
  sim?: string;
  durationMs?: number;
  modules: ModuleInventoryEntry[];
}

/** A module whose identity changed between two visits (replaced, reflashed, or a different unit). */
export interface InventoryChange {
  at: string;
  moduleId: string;
  label: string;
  key: IdentKey;
  from: string;
  to: string;
}

// ---- decoding --------------------------------------------------------------

function bytesOf(h: string): number[] {
  return (h.replace(/\s+/g, "").match(/../g) ?? []).map((b) => parseInt(b, 16));
}
const toHex = (b: number[]) => b.map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();

function printableRatio(b: number[]): number {
  if (!b.length) return 0;
  return b.filter((n) => n >= 0x20 && n < 0x7f).length / b.length;
}

function asText(b: number[]): string {
  return b.map((n) => (n >= 0x20 && n < 0x7f ? String.fromCharCode(n) : " ")).join("").replace(/\s+/g, " ").trim();
}

function bcd(n: number): number | null {
  const hi = n >> 4, lo = n & 0xf;
  return hi > 9 || lo > 9 ? null : hi * 10 + lo;
}

/** YYMMDD / YYYYMMDD in BCD → "2014-06-23". Null if it is not a plausible date. */
export function bcdDate(b: number[]): string | null {
  const d = b.map(bcd);
  if (d.some((x) => x === null)) return null;
  let y: number, m: number, day: number;
  if (b.length === 3) { y = 2000 + d[0]!; m = d[1]!; day = d[2]!; }
  else if (b.length === 4) { y = d[0]! * 100 + d[1]!; m = d[2]!; day = d[3]!; }
  else return null;
  if (m < 1 || m > 12 || day < 1 || day > 31 || y < 1990 || y > 2099) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Mercedes version: year, week, patch (decimal) per 3 bytes → "12/02 00". F151 holds one
 *  group per software part (matching F121's list) → "12/13 00 / 18/15 00 / 20/05 00". */
function mbVersion(b: number[]): string | null {
  if (!b.length || b.length % 3 !== 0 || b.length > 15) return null;
  const groups: string[] = [];
  for (let i = 0; i < b.length; i += 3) {
    const [y, w, p] = b.slice(i, i + 3);
    if (y > 99 || w < 1 || w > 53 || p > 99) return null;
    groups.push(`${String(y).padStart(2, "0")}/${String(w).padStart(2, "0")} ${String(p).padStart(2, "0")}`);
  }
  return groups.join(" / ");
}

/** Split concatenated 10-digit part numbers ("64290272036429034717…") into a list. */
function partList(text: string): string {
  const digits = text.replace(/\s+/g, "");
  if (/^\d{20,}$/.test(digits) && digits.length % 10 === 0) return (digits.match(/\d{10}/g) ?? []).join(" / ");
  return text;
}

/** The longest printable run in a KWP ident record (the fields mix binary and ASCII). */
function longestText(b: number[]): string {
  let best = "", cur = "";
  for (const n of b) {
    if (n >= 0x20 && n < 0x7f) { cur += String.fromCharCode(n); if (cur.trim().length > best.length) best = cur.trim(); }
    else cur = "";
  }
  return best;
}

/**
 * Decode one positive identification response.
 *   UDS  62 <did hi> <did lo> <data…>
 *   KWP  5A <lid> <data…>
 * Returns null for a negative response, a wrong echo, or an empty record.
 */
export function decodeIdentResponse(spec: IdentSpec, responseHex: string | undefined | null): { value: string; raw: string } | null {
  if (!responseHex) return null;
  const b = bytesOf(responseHex);
  if (!b.length || b[0] === 0x7f) return null;
  let data: number[];
  if (spec.req.startsWith("22")) {
    const did = parseInt(spec.req.slice(2), 16);
    if (b[0] !== 0x62 || b.length < 4 || ((b[1] << 8) | b[2]) !== did) return null;
    data = b.slice(3);
  } else if (spec.req.startsWith("1A")) {
    if (b[0] !== 0x5a || b.length < 3 || b[1] !== parseInt(spec.req.slice(2, 4), 16)) return null;
    data = b.slice(2);
  } else return null;
  // all-zero / all-FF fields are "not programmed"
  if (!data.length || data.every((n) => n === 0) || data.every((n) => n === 0xff)) return null;
  const raw = toHex(data).slice(0, 96);

  let value: string | null = null;
  switch (spec.decode) {
    case "bcdDate": value = bcdDate(data) ?? toHex(data); break;
    case "mbVersion": value = mbVersion(data) ?? toHex(data); break;
    case "hex": value = toHex(data); break;
    case "text": value = asText(data) || toHex(data); break;
    case "partList": value = partList(asText(data)) || toHex(data); break;
    case "auto":
    default: {
      if (spec.req.startsWith("1A")) {
        const t = longestText(data);
        value = t.length >= 4 ? t : toHex(data);
        // a part number is the trailing digit run — a printable status byte can precede it
        if (spec.key === "partNo" && t) value = t.match(/\d{9,}$/)?.[0] ?? value;
      } else {
        value = printableRatio(data) >= 0.75 ? asText(data) : toHex(data);
      }
    }
  }
  value = (value ?? "").trim();
  return value ? { value, raw } : null;
}

/** Best value per key: the first record of each key wins (the plan lists the best source first). */
export function summarizeRecords(records: IdentRecord[]): Partial<Record<IdentKey, string>> {
  const out: Partial<Record<IdentKey, string>> = {};
  for (const r of records) if (!out[r.key]) out[r.key] = r.value;
  // a part number for the headline: the spare-part number, else the hardware part number
  if (!out.partNo && out.hwPartNo) out.partNo = out.hwPartNo;
  return out;
}

/** The requests for one module, in order. Mercedes DIDs are included on Daimler cars. */
export function identPlan(protocol: "uds" | "kwp2000" | "unknown", opts: { mercedes?: boolean } = {}): IdentSpec[] {
  const udsList = UDS_IDENT.filter((s) => !s.maker || (s.maker === "mercedes" && opts.mercedes));
  if (protocol === "kwp2000") return [...KWP_IDENT];
  if (protocol === "uds") return udsList;
  return [...udsList, ...KWP_IDENT];
}

// ---- storing ---------------------------------------------------------------

const TRACKED: IdentKey[] = ["serial", "partNo", "hwPartNo", "swPartNo", "swVersion", "vin"];

/** What changed between the last inventory and this one (module swapped, reflashed, other VIN). */
export function inventoryChanges(prev: CarInventory | undefined, next: CarInventory): InventoryChange[] {
  if (!prev) return [];
  const before = new Map(prev.modules.map((m) => [m.moduleId, m]));
  const out: InventoryChange[] = [];
  for (const m of next.modules) {
    const p = before.get(m.moduleId);
    if (!p) continue;
    for (const k of TRACKED) {
      const a = p.summary[k], b = m.summary[k];
      if (a && b && a !== b) out.push({ at: next.at, moduleId: m.moduleId, label: m.label, key: k, from: a, to: b });
    }
  }
  return out;
}

/**
 * File an inventory under one car (VIN). Modules the new read did not reach keep
 * their previous entry, so a partial read never erases what an earlier visit found.
 * Changes against the previous inventory are appended to the car's change log.
 */
export function recordInventory(profile: VehicleProfile, vin: string, inv: CarInventory, changeCap = 50): VehicleProfile {
  const v = (vin || "").trim().toUpperCase();
  if (!profile.knownVins?.some((o) => o.vin === v)) return profile;
  return {
    ...profile,
    knownVins: profile.knownVins.map((o) => {
      if (o.vin !== v) return o;
      const prev = o.inventory;
      const merged: CarInventory = { ...inv, modules: [...inv.modules] };
      if (prev) {
        const have = new Set(inv.modules.filter((m) => m.status === "ok" || m.status === "partial").map((m) => m.moduleId));
        for (const pm of prev.modules) {
          const i = merged.modules.findIndex((m) => m.moduleId === pm.moduleId);
          if (have.has(pm.moduleId)) continue;
          if (i >= 0) merged.modules[i] = { ...pm, note: `kept from ${prev.at.slice(0, 10)} — not read this time` };
          else merged.modules.push(pm);
        }
      }
      const changes = inventoryChanges(prev, inv);
      return { ...o, inventory: merged, inventoryChanges: [...(o.inventoryChanges ?? []), ...changes].slice(-changeCap) };
    }),
  };
}

/**
 * Fold the model-level part of an inventory into the profile's modules: part number,
 * supplier, software / hardware — what every car of this model is likely to share.
 * Serial numbers and VINs stay per car; only an empty field is filled.
 */
export function foldInventoryIntoProfile(profile: VehicleProfile, inv: CarInventory): VehicleProfile {
  const by = new Map(inv.modules.map((m) => [m.moduleId, m]));
  return {
    ...profile,
    modules: profile.modules.map((m) => {
      const e = by.get(m.id);
      if (!e || (e.status !== "ok" && e.status !== "partial")) return m;
      const s = e.summary;
      const cur = m.identity ?? { supplier: "", partNo: "" };
      return {
        ...m,
        identity: {
          ...cur,
          partNo: cur.partNo || s.partNo || s.hwPartNo || "",
          supplier: cur.supplier || s.supplier || "",
          sw: cur.sw || s.swPartNo || s.swVersion,
          hw: cur.hw || s.hwPartNo || s.hwVersion,
          observedAt: inv.sim ? cur.observedAt : inv.at,
        },
        ...(inv.sim ? {} : { lastSeenAt: inv.at }),
      };
    }),
  };
}

/** The car's inventory, if any was read. */
export function inventoryFor(profile: VehicleProfile | null | undefined, vin: string): CarInventory | null {
  const v = (vin || "").trim().toUpperCase();
  return profile?.knownVins?.find((o) => o.vin === v)?.inventory ?? null;
}
