/**
 * UDS (ISO 14229) decode layer — pure functions, no I/O.
 *
 * Most modules other than the engine (transmission, ABS, body, …) don't answer
 * generic OBD-II; they speak UDS. UDS rides the same ISO-TP transport our
 * firmware already implements, so the app just builds request byte arrays and
 * parses the raw responses the device returns. This module is request builders
 * + response parsers; the device round-trip lives in obd.ts.
 */
import { decodeDtc, dtcDescription, type Dtc } from "./obd-protocol";

/** UDS service IDs we use. */
export const UDS = {
  DIAGNOSTIC_SESSION_CONTROL: 0x10,
  CLEAR_DTC: 0x14,
  READ_DTC_INFORMATION: 0x19,
  READ_DATA_BY_ID: 0x22,
  TESTER_PRESENT: 0x3e,
} as const;

/** Common Data Identifiers (DIDs) for service 0x22. */
export const DID = {
  VIN: 0xf190,
  ECU_SERIAL: 0xf18c,
  ECU_HARDWARE_NUMBER: 0xf191,
  ECU_SOFTWARE_NUMBER: 0xf195,
  SPARE_PART_NUMBER: 0xf187,
  SUPPLIER_ID: 0xf18a,
} as const;

// ---- request builders -------------------------------------------------------
export const buildTesterPresent = (): number[] => [UDS.TESTER_PRESENT, 0x00];
export const buildSession = (type = 0x03): number[] => [UDS.DIAGNOSTIC_SESSION_CONTROL, type];
export const buildReadDataById = (did: number): number[] => [UDS.READ_DATA_BY_ID, (did >> 8) & 0xff, did & 0xff];
/** Read DTCs by status mask (subfunction 0x02 = reportDTCByStatusMask). */
export const buildReadDtcByStatus = (mask = 0xff): number[] => [UDS.READ_DTC_INFORMATION, 0x02, mask];
export const buildClearDtc = (group = 0xffffff): number[] => [
  UDS.CLEAR_DTC,
  (group >> 16) & 0xff,
  (group >> 8) & 0xff,
  group & 0xff,
];

// ---- response parsing -------------------------------------------------------
/** Negative-response codes worth naming. */
const NRC: Record<number, string> = {
  0x10: "general reject",
  0x11: "service not supported",
  0x12: "sub-function not supported",
  0x13: "incorrect message length",
  0x22: "conditions not correct",
  0x31: "request out of range",
  0x33: "security access denied",
  0x35: "invalid key",
  0x78: "response pending",
  0x7f: "service not supported in active session",
};

/** True if the response is a positive reply to `reqSid` (SID + 0x40). */
export function isPositive(resp: number[], reqSid: number): boolean {
  return resp.length > 0 && resp[0] === reqSid + 0x40;
}

/** If the response is a UDS negative response (0x7F), returns a description; else null. */
export function negativeResponse(resp: number[]): string | null {
  if (resp.length >= 3 && resp[0] === 0x7f) {
    const nrc = resp[2];
    return `${NRC[nrc] ?? "negative response"} (0x${nrc.toString(16).padStart(2, "0")})`;
  }
  return null;
}

/**
 * Parses a 0x19/0x02 (read DTCs by status) response into codes. Layout:
 * [0x59, 0x02, statusAvailabilityMask, then records of {3-byte DTC + 1 status}].
 * UDS DTCs are 3 bytes — the first two map to the SAE Pxxxx code, the third is
 * the failure-type byte (shown as a -NN suffix).
 */
export function parseUdsDtcs(resp: number[]): Dtc[] {
  if (resp.length < 3 || resp[0] !== 0x59) return [];
  const out: Dtc[] = [];
  for (let i = 3; i + 3 < resp.length + 1 && i + 2 < resp.length; i += 4) {
    const b0 = resp[i];
    const b1 = resp[i + 1];
    const b2 = resp[i + 2];
    if (b0 === undefined || b1 === undefined || b2 === undefined) break;
    if (b0 === 0 && b1 === 0 && b2 === 0) continue;
    const base = decodeDtc(b0, b1);
    const code = b2 ? `${base}-${b2.toString(16).toUpperCase().padStart(2, "0")}` : base;
    out.push({ code, description: dtcDescription(base) });
  }
  return out;
}

/** Parses a 0x22/0xF190 (read VIN) response into the VIN string. */
export function parseUdsVin(resp: number[]): string {
  // [0x62, DIDhi, DIDlo, ...ascii]
  if (resp.length < 4 || resp[0] !== 0x62) return "";
  const ascii = resp.slice(3).filter((c) => c >= 0x20 && c < 0x7f);
  return String.fromCharCode(...ascii).trim();
}

/** Parses a 0x22 response payload as an ASCII string (for text DIDs). */
export function parseUdsText(resp: number[]): string {
  if (resp.length < 4 || resp[0] !== 0x62) return "";
  const ascii = resp.slice(3).filter((c) => c >= 0x20 && c < 0x7f);
  return String.fromCharCode(...ascii).trim();
}

// ---- hex-string helpers for the REAL cockpit (device returns hex) -----------

/** "59 02 0B…" / "59020b…" → [0x59,0x02,0x0B,…] */
export function bytesFromHex(hex: string): number[] {
  const clean = (hex || "").replace(/[^0-9a-fA-F]/g, "");
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

export interface DtcRow { code: string; description: string; statusByte: string; status: string }

function dtcStatusFlags(s: number): string {
  const f: string[] = [];
  if (s & 0x01) f.push("failed");
  if (s & 0x02) f.push("failed-this-cycle");
  if (s & 0x08) f.push("confirmed");
  if (s & 0x40) f.push("pending");
  if (s & 0x80) f.push("MIL");
  return f.join(" · ") || "—";
}

/** Decode a 0x19/0x02 response (hex) into detailed rows, keeping the status byte. */
export function parseUdsDtcsFromHex(hex: string): DtcRow[] {
  const b = bytesFromHex(hex);
  const start = b.findIndex((_, k) => b[k] === 0x59 && b[k + 1] === 0x02);
  if (start < 0) return [];
  const body = b.slice(start + 3);
  const out: DtcRow[] = [];
  for (let i = 0; i + 3 < body.length; i += 4) {
    const [h, m, l, st] = [body[i], body[i + 1], body[i + 2], body[i + 3]];
    if (h === 0 && m === 0 && l === 0 && st === 0) continue;
    const base = decodeDtc(h, m);
    out.push({
      code: l ? `${base}-${l.toString(16).toUpperCase().padStart(2, "0")}` : base,
      description: dtcDescription(base),
      statusByte: st.toString(16).toUpperCase().padStart(2, "0"),
      status: dtcStatusFlags(st),
    });
  }
  return out;
}

/**
 * Decode an OBD-II mode 03/07/0A DTC response (hex) into rows. Layout over CAN:
 * [SID(+0x40) , count , {2-byte DTC}…]. 03→stored, 07→pending, 0A→permanent. Unlike
 * UDS there is no per-DTC status byte, so `status` carries the report kind.
 */
export function parseObdDtcsFromHex(hex: string): DtcRow[] {
  const b = bytesFromHex(hex);
  if (b.length < 2) return [];
  const kind = b[0] === 0x43 ? "stored" : b[0] === 0x47 ? "pending" : b[0] === 0x4a ? "permanent" : "";
  if (!kind) return [];
  // A count byte usually follows the SID on CAN; trust it only if it matches the
  // number of DTC pairs actually present, else assume the pairs start right away.
  let i = 1;
  if (b[1] === Math.floor((b.length - 2) / 2)) i = 2;
  const out: DtcRow[] = [];
  for (; i + 1 < b.length; i += 2) {
    const h = b[i], m = b[i + 1];
    if (h === 0 && m === 0) continue;
    const base = decodeDtc(h, m);
    out.push({ code: base, description: dtcDescription(base), statusByte: "", status: kind });
  }
  return out;
}

/**
 * Decode a live OBD-II mode-01 PID response into an engineering value with units,
 * so the cockpit shows "13.92 V" instead of raw bytes. Returns null when the PID
 * isn't one we have a formula for (caller falls back to hex). `reqHex` is the
 * request (e.g. "0142"), `respHex` the reply (e.g. "41 42 36 60").
 */
export function decodeObdPid(reqHex: string, respHex: string): string | null {
  const req = bytesFromHex(reqHex);
  const b = bytesFromHex(respHex);
  if (req.length < 2 || req[0] !== 0x01 || b.length < 2) return null;
  const pid = req[1];
  const idx = b.findIndex((_, k) => b[k] === 0x41 && b[k + 1] === pid);
  if (idx < 0) return null;
  const A = b[idx + 2] ?? 0, B = b[idx + 3] ?? 0;
  const n = (v: number, u: string, d = 0) => `${v.toFixed(d)} ${u}`;
  switch (pid) {
    case 0x05: case 0x0f: case 0x46: case 0x5c: return n(A - 40, "°C");
    case 0x0c: return n((A * 256 + B) / 4, "rpm");
    case 0x0d: return n(A, "km/h");
    case 0x04: case 0x11: case 0x2f: case 0x45: case 0x47: case 0x49: case 0x4a: case 0x4b: return n((A * 100) / 255, "%", 1);
    case 0x06: case 0x07: case 0x08: case 0x09: return n((A * 100) / 128 - 100, "%", 1);
    case 0x10: return n((A * 256 + B) / 100, "g/s", 2);
    case 0x0b: return n(A, "kPa");
    case 0x0a: return n(A * 3, "kPa");
    case 0x0e: return n(A / 2 - 64, "°", 1);
    case 0x42: return n((A * 256 + B) / 1000, "V", 2);
    case 0x43: return n((A * 256 + B) * 100 / 255, "%", 1);
    case 0x1f: return n(A * 256 + B, "s");
    default: return null;
  }
}

/** Best-effort ASCII from a hex response, skipping `skip` leading bytes (SID/DID). */
export function asciiFromHex(hex: string, skip = 0): string {
  const b = bytesFromHex(hex).slice(skip);
  return b.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : "")).join("").trim();
}

/** Auto-skip a positive read SID (0x62 UDS → 3, 0x61 KWP → 2) then return the ASCII. */
export function identifierAscii(hex: string): string {
  const b = bytesFromHex(hex);
  const skip = b[0] === 0x62 ? 3 : b[0] === 0x61 ? 2 : 0;
  return asciiFromHex(hex, skip);
}
