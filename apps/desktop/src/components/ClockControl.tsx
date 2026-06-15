import { useMemo, useState } from "react";

import type { ChipProfile } from "@ecu/chip-db";
import {
  chipMaxClockHz,
  effectiveSpiClockHz,
  formatClockHz,
  SAFE_FIRST_CONTACT_HZ,
} from "@ecu/chip-db";

import type { PicoMode } from "../lib/picoforge";

/**
 * SPI-clock selector (the hybrid clock model). The clock is the SCK frequency:
 * a pure throughput knob with no minimum, so slowing down is always safe for a
 * read. Use "Safe · 1 MHz" for a stubborn chip that reads back all 0x00 (the
 * signature of clocking faster than the chip can drive MISO).
 *
 * `value` is the operator override in Hz, or null for "auto" (= the chip's
 * rated default). Only meaningful for SPI modes (0/1); I²C and Microwire run at
 * fixed firmware clocks, so this renders an informational note there instead.
 */
const PRESETS: Array<{ label: string; hz: number }> = [
  { label: "Safe · 1 MHz", hz: SAFE_FIRST_CONTACT_HZ },
  { label: "2 MHz", hz: 2_000_000 },
  { label: "4 MHz", hz: 4_000_000 },
  { label: "8 MHz", hz: 8_000_000 },
];

export function ClockControl({
  profile,
  mode,
  value,
  onChange,
  disabled,
}: {
  profile: ChipProfile;
  mode: PicoMode;
  value: number | null;
  onChange: (hz: number | null) => void;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState("");
  const isSpi = mode === 0 || mode === 1;
  const rated = chipMaxClockHz(profile);
  const effective = useMemo(() => effectiveSpiClockHz(profile, value ?? undefined), [profile, value]);

  if (!isSpi) {
    return (
      <p className="tiny dim mt-8">
        {mode === 2 ? "I²C" : "Microwire"} runs at a fixed firmware clock — the SPI speed control
        doesn't apply to this chip.
      </p>
    );
  }

  function applyCustom() {
    const mhz = Number(custom.trim());
    if (Number.isFinite(mhz) && mhz > 0) onChange(Math.round(mhz * 1_000_000));
  }

  const presetMatch = value !== null && PRESETS.some((p) => p.hz === value);

  return (
    <div className="card compact mt-12">
      <div className="row spread" style={{ alignItems: "center" }}>
        <div className="tiny dim">SPI clock</div>
        <div className="tiny">
          drives at <strong>{formatClockHz(effective)}</strong>
          {rated && <span className="dim"> · rated max {formatClockHz(rated)}</span>}
        </div>
      </div>
      <div className="seg mt-8" style={{ flexWrap: "wrap" }}>
        <button
          className={value === null ? "active" : ""}
          onClick={() => onChange(null)}
          disabled={disabled}
          title="Use the chip's datasheet-rated clock"
        >
          Auto{rated ? ` (${formatClockHz(rated)})` : ""}
        </button>
        {PRESETS.map((p) => (
          <button
            key={p.hz}
            className={value === p.hz ? "active" : ""}
            onClick={() => onChange(p.hz)}
            disabled={disabled}
          >
            {p.label}
          </button>
        ))}
        {rated && rated > 8_000_000 && (
          <button
            className={value === rated ? "active" : ""}
            onClick={() => onChange(rated)}
            disabled={disabled}
            title="The chip's rated maximum"
          >
            Rated · {formatClockHz(rated)}
          </button>
        )}
      </div>
      <div className="row gap-8 mt-8" style={{ alignItems: "center" }}>
        <span className="tiny dim">custom</span>
        <input
          type="number"
          step="0.5"
          min="0.01"
          placeholder={!presetMatch && value !== null ? String(value / 1_000_000) : "MHz"}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") applyCustom(); }}
          style={{ width: 90 }}
          disabled={disabled}
        />
        <span className="tiny dim">MHz</span>
        <button className="tiny" onClick={applyCustom} disabled={disabled || !custom.trim()}>Set</button>
        {!presetMatch && value !== null && (
          <span className="badge tiny info">custom {formatClockHz(value)}</span>
        )}
      </div>
      <p className="tiny dim mt-8">
        Reading back all <span className="mono">0x00</span>? The clock is too fast for this chip or your
        leads — drop to <strong>Safe · 1 MHz</strong>. (A blank chip reads <span className="mono">0xFF</span>.)
      </p>
    </div>
  );
}
