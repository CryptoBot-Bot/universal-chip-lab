/** What a supply voltage means, in words — one place for the header, the vehicle page and the module table. */
export interface VoltageView {
  /** ok · warn · low (act on it) · none (no verdict: unknown engine state, or not a 12 V vehicle) */
  level: "ok" | "warn" | "low" | "none";
  /** "battery" with the engine off, "charging" with it running. */
  what: string;
  hint: string;
}

/** 12 V systems only. Engine off: the battery under ignition load. Running: what the alternator delivers. */
export function voltageView(volts: number, rpm: number | null): VoltageView {
  if (volts > 18) return { level: "none", what: "supply", hint: "Not a 12 V vehicle — shown without a verdict." };
  if (rpm === null) return { level: "none", what: "supply", hint: "The engine module does not say whether the engine runs." };
  if (rpm >= 300) {
    if (volts > 15.2) return { level: "low", what: "charging", hint: "Engine running: above 15.2 V is too high — check the alternator." };
    if (volts < 13.2) return { level: "warn", what: "charging", hint: "Engine running: below 13.2 V. Smart alternators do this at times; if it stays there the battery is not being charged." };
    return { level: "ok", what: "charging", hint: "Engine running: charging voltage is normal." };
  }
  if (volts < 12.0) return { level: "low", what: "battery", hint: "Engine off, ignition on: the battery is low. Connect a charger before a long scan." };
  if (volts < 12.4) return { level: "warn", what: "battery", hint: "Engine off, ignition on: enough for a scan. Connect a charger for a long one." };
  return { level: "ok", what: "battery", hint: "Engine off, ignition on: the battery is well charged." };
}

/** "12.04 V" */
export const voltsText = (v: number) => `${v.toFixed(2)} V`;
