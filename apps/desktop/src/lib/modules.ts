/**
 * Standard ISO 15765-4 (11-bit) OBD/UDS module addressing.
 *
 * On a diagnostic CAN bus, a module is reached at a "request" id and answers on
 * "request + 8". The engine and transmission are standardized; the rest are
 * OEM-assigned, so we name them generically but still address them correctly.
 */
export interface ModuleAddr {
  /** Response CAN id (what we hear back), e.g. 0x7E8. */
  resp: number;
  /** Request CAN id (where we send), e.g. 0x7E0. */
  req: number;
  /** Human label. */
  name: string;
}

// Response-id → friendly name. ECM/TCM are standardized; 0x7EA–0x7EF are common
// secondary modules but the exact role is OEM-specific (we label by address).
const NAMES: Record<number, string> = {
  0x7e8: "Engine (ECM)",
  0x7e9: "Transmission (TCM)",
  0x7ea: "Module @ 7EA",
  0x7eb: "Module @ 7EB",
  0x7ec: "Module @ 7EC",
  0x7ed: "Module @ 7ED",
  0x7ee: "Module @ 7EE",
  0x7ef: "Module @ 7EF",
};

/** Builds a {@link ModuleAddr} from a response id (req = resp − 8). */
export function moduleFor(resp: number): ModuleAddr {
  const req = resp - 8;
  const name = NAMES[resp] ?? `Module @ ${resp.toString(16).toUpperCase()}`;
  return { resp, req, name };
}

/** The standard physical request addresses to probe (0x7E0–0x7E7). */
export const PHYSICAL_REQ_ADDRS = [0x7e0, 0x7e1, 0x7e2, 0x7e3, 0x7e4, 0x7e5, 0x7e6, 0x7e7];

/** The OBD-II functional broadcast address (all OBD modules listen). */
export const FUNCTIONAL_REQ = 0x7df;
