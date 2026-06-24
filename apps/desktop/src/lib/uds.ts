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
