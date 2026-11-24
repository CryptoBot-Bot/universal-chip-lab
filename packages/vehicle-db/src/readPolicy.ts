/**
 * The read-only policy — the one rule every request this lab sends to a real car
 * goes through before it leaves the PC (AI mapper, identity reader, scans, CLI).
 *
 * Real cars are READ-only for now (Dmytro, 2026-11-23): no clears, coding, routines,
 * resets, keys, actuator tests or downloads. Airbag / restraint and immobiliser
 * modules get even less: plain reads in the session they are already in — no
 * session change, no security access, no memory reads — and are never explored
 * automatically. The Pi's own write gate is a second, independent wall behind this.
 */

import type { ProtectedKind } from "./protectedModules.js";


export type RequestVerdict = { ok: true; service: string } | { ok: false; reason: string };

/** Services that only read. */
export const READ_SERVICES: Record<string, string> = {
  "01": "OBD current data",
  "02": "OBD freeze frame",
  "03": "OBD stored codes",
  "06": "OBD monitor results",
  "07": "OBD pending codes",
  "09": "OBD vehicle information",
  "0a": "OBD permanent codes",
  "17": "KWP read status of DTC",
  "18": "KWP read DTCs by status",
  "19": "UDS read DTC information",
  "1a": "KWP read ECU identification",
  "21": "KWP read data by local identifier",
  "22": "UDS read data by identifier",
  "23": "read memory by address",
  "24": "UDS read scaling data",
  "3e": "tester present",
};

/** What a protected module may be asked: identity, fault memory, keep-alive. Nothing else. */
export const PROTECTED_SERVICES = new Set(["22", "1a", "19", "18", "17", "3e"]);

/** Services that change something in a module — named so a refusal says what it was. */
export const WRITE_SERVICES: Record<string, string> = {
  "04": "OBD clear codes",
  "11": "ECU reset",
  "14": "clear DTC memory",
  "27": "security access (key)",
  "28": "communication control",
  "2c": "dynamically define identifier",
  "2e": "write data by identifier",
  "2f": "input/output control (actuator test)",
  "30": "KWP input/output control",
  "31": "routine control",
  "32": "KWP stop routine",
  "33": "KWP request routine results",
  "34": "request download",
  "35": "request upload",
  "36": "transfer data",
  "37": "request transfer exit",
  "38": "request file transfer",
  "3b": "KWP write data by local identifier",
  "3d": "write memory by address",
  "83": "access timing parameters",
  "84": "secured data transmission",
  "85": "control DTC setting",
  "86": "response on event",
  "87": "link control",
};

/** Sessions never entered on a real module: programming (bootloader) and the UDS
 * safety-system session (the airbag scrapping / deployment path). */
export const FORBIDDEN_SESSIONS = new Set([0x02, 0x82, 0x85, 0x04, 0x84]);

/** The only sessions an automatic read may open: default (01, KWP 81), extended diagnostic
 * (03, KWP 92) and Nissan's diagnostic session (C0). Everything else is refused, not just the
 * programming ones: KWP 86 is a development session, 87 adjustment, 89 standby, 90 passive. */
export const ALLOWED_SESSIONS = new Set([0x01, 0x03, 0x81, 0x92, 0xc0]);

function hex(raw: string): string | null {
  const r = (raw || "").replace(/\s+/g, "").toLowerCase();
  return /^[0-9a-f]{2,}$/.test(r) && r.length % 2 === 0 ? r : null;
}

/**
 * May this request be sent to a real module?
 * `protectedKind` set → the module is an airbag/restraint or immobiliser system.
 */
export function checkRequest(raw: string, opts: { protectedKind?: ProtectedKind | null } = {}): RequestVerdict {
  const r = hex(raw);
  if (!r) return { ok: false, reason: `"${raw}" is not a whole number of hex bytes` };
  const sid = r.slice(0, 2);
  const guarded = !!opts.protectedKind;
  const what = opts.protectedKind === "restraint" ? "airbag / restraint module" : "immobiliser / ignition-lock module";

  if (guarded && !PROTECTED_SERVICES.has(sid)) {
    const name = READ_SERVICES[sid] ?? WRITE_SERVICES[sid] ?? (sid === "10" ? "session change" : `service 0x${sid}`);
    return { ok: false, reason: `${name} refused: this is an ${what} — only identity and fault-memory reads, in the session it is already in` };
  }
  if (sid === "10") {
    const sub = parseInt(r.slice(2, 4), 16);
    if (r.length !== 4 || !Number.isFinite(sub)) return { ok: false, reason: "session change must be exactly 10 xx" };
    if (FORBIDDEN_SESSIONS.has(sub)) return { ok: false, reason: `session 0x${r.slice(2, 4)} refused: programming and safety-system sessions are never entered` };
    if (!ALLOWED_SESSIONS.has(sub)) return { ok: false, reason: `session 0x${r.slice(2, 4)} refused: only default and extended diagnostic sessions are opened` };
    return { ok: true, service: "diagnostic session" };
  }
  if (sid === "27") {
    // A seed request (odd sub-function) changes nothing and shows whether security exists.
    // A key (even sub-function) is never sent.
    const sub = parseInt(r.slice(2, 4), 16);
    if (r.length === 4 && Number.isFinite(sub) && sub % 2 === 1) return { ok: true, service: "security access (seed only)" };
    return { ok: false, reason: "security access key refused: keys are never sent" };
  }
  if (READ_SERVICES[sid]) return { ok: true, service: READ_SERVICES[sid] };
  return { ok: false, reason: `${WRITE_SERVICES[sid] ?? `service 0x${sid}`} refused: real cars are read-only` };
}

/** Plain yes/no form of checkRequest for a module that is not protected. */
export function isReadOnlyRequest(raw: string): boolean {
  return checkRequest(raw).ok;
}

/** Every request of a sequence must pass; returns the first refusal, or null. */
export function firstRefusal(requests: string[], opts: { protectedKind?: ProtectedKind | null } = {}): string | null {
  for (const q of requests) {
    const v = checkRequest(q, opts);
    if (!v.ok) return `${q}: ${v.reason}`;
  }
  return null;
}
