/**
 * Modules nothing automatic may touch, on any car:
 *   • airbag / restraint systems — pyrotechnics;
 *   • immobiliser / ignition-lock / keyless modules — a security mistake can leave
 *     the car unable to start.
 * The AI mapper never explores them, and the app never arms the device's write gate
 * for them. Reading their fault codes (what every scan tool does) stays allowed.
 * Rule set by Dmytro on 2026-11-23, at a customer's van: "make sure we are not
 * touching any dangerous stuff like airbags".
 */

export type ProtectedKind = "restraint" | "immobiliser";

export interface ProtectedVerdict { kind: ProtectedKind; reason: string }

const RESTRAINT = /\b(airbag|srs|restraint|acsm|sdm|rcm|occupant (classification|detection|sensing)|seat ?belt pretension|pretensioner|pyro)/i;
const IMMOBILISER = /\b(immobili[sz]er|immo|ezs|eis|elv|ignition (switch|lock)|electronic ignition|steering (column )?lock|keyless|kessy|smart ?key|wfs|cas|key ?less|transponder)\b/i;

/** Why a module is protected, or null. Looks at the category and the module's own names —
 * not its summary, which may merely mention a neighbour ("the ECM talks to the EZS
 * immobiliser" must not protect the ECM). */
export function protectedModule(m: { category?: string | null; label?: string | null; displayName?: string | null; shortName?: string | null; summary?: string | null }): ProtectedVerdict | null {
  const text = [m.label, m.displayName, m.shortName].filter(Boolean).join(" ");
  if (m.category === "safety" || RESTRAINT.test(text))
    return { kind: "restraint", reason: "airbag / restraint system — protected: never explored or written to automatically (pyrotechnic safety system)" };
  if (IMMOBILISER.test(text))
    return { kind: "immobiliser", reason: "immobiliser / ignition lock — protected: never explored or written to automatically (a mistake can leave the car unable to start)" };
  return null;
}
