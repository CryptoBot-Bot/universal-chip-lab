import { useEffect, useMemo, useState } from "react";

import type { ChipPin, ChipProfile, PinRole } from "@ecu/chip-db";
import { PIN_ROLES } from "@ecu/chip-db";

import { Api } from "../lib/api";

/**
 * Visual, editable pinout engine. Renders the chip as a dual-row IC with named,
 * role-coloured legs you can click to edit, add, or remove — then saves the
 * pinout back onto the profile. For many-pin packages (QFP/BGA) it's a clear
 * LOGICAL view (functional legs, not literal balls), which is exactly how you
 * reason about wiring.
 */

const ROLE_COLOR: Record<PinRole, string> = {
  power: "#e5484d",
  ground: "#64748b",
  chip_select: "#a855f7",
  clock: "#3b82f6",
  mosi: "#22c55e",
  miso: "#16a34a",
  sda: "#22c55e",
  scl: "#3b82f6",
  write_protect: "#f59e0b",
  hold: "#f59e0b",
  reset: "#ef4444",
  do: "#16a34a",
  di: "#22c55e",
  org: "#8b5cf6",
  nc: "#9ca3af",
  address: "#06b6d4",
  data: "#10b981",
  control: "#eab308",
  chip_enable: "#a855f7",
  output_enable: "#3b82f6",
  write_enable: "#f59e0b",
  ready_busy: "#14b8a6",
  vpp: "#e11d48",
};

function PinChip({
  pin,
  side,
  selected,
  onClick,
}: {
  pin: ChipPin;
  side: "left" | "right";
  selected: boolean;
  onClick: () => void;
}) {
  const color = ROLE_COLOR[pin.role] ?? "#9ca3af";
  const leg = <span style={{ width: 12, height: 2, background: color, flex: "0 0 12px" }} />;
  const body = (
    <div
      onClick={onClick}
      title={`${pin.role}${pin.note ? ` — ${pin.note}` : ""}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 4,
        cursor: "pointer",
        border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
        background: selected ? "var(--border)" : "var(--bg)",
        flexDirection: side === "left" ? "row" : "row-reverse",
        minWidth: 120,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flex: "0 0 8px" }} />
      <span className="mono tiny dim" style={{ flex: "0 0 18px", textAlign: side === "left" ? "right" : "left" }}>{pin.pin}</span>
      <span className="tiny" style={{ fontWeight: 600 }}>{pin.name}</span>
    </div>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", flexDirection: side === "left" ? "row" : "row-reverse", marginBottom: 4 }}>
      {body}
      {leg}
    </div>
  );
}

export function PinoutEditor({ chip, onSaved }: { chip: ChipProfile; onSaved?: (updated: ChipProfile) => void }) {
  const [pins, setPins] = useState<ChipPin[]>(chip.pinout.map((p) => ({ ...p })));
  const [sel, setSel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setPins(chip.pinout.map((p) => ({ ...p })));
    setSel(null);
    setMsg(null);
  }, [chip]);

  const dirty = useMemo(() => JSON.stringify(pins) !== JSON.stringify(chip.pinout), [pins, chip.pinout]);

  // Sort by pin number for the visual, split into the two IC sides.
  const sorted = useMemo(() => [...pins].sort((a, b) => a.pin - b.pin), [pins]);
  const half = Math.ceil(sorted.length / 2);
  const left = sorted.slice(0, half);
  const right = sorted.slice(half).reverse(); // bottom-right → top-right, standard numbering

  function update(idx: number, patch: Partial<ChipPin>) {
    setPins((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }
  function addPin() {
    const nextNum = pins.reduce((m, p) => Math.max(m, p.pin), 0) + 1;
    setPins((prev) => [...prev, { pin: nextNum, name: `P${nextNum}`, role: "nc" }]);
    setSel(pins.length);
  }
  function removePin(idx: number) {
    setPins((prev) => prev.filter((_, i) => i !== idx));
    setSel(null);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const updated: ChipProfile = { ...chip, pinout: pins.map((p) => ({ ...p })) };
      const saved = await Api.chips.saveProfile(updated);
      setMsg({ ok: true, text: "Pinout saved." });
      onSaved?.(saved);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // The selected pin index refers into `pins` (unsorted) — find it via identity.
  const selPin = sel !== null ? pins[sel] : null;

  return (
    <div className="card compact">
      <div className="row spread" style={{ alignItems: "center" }}>
        <strong>🔧 Pinout — visual editor {dirty && <span className="badge tiny warn">unsaved</span>}</strong>
        <div className="row gap-8">
          <button className="tiny" onClick={addPin}>+ Add pin</button>
          <button className="tiny ghost" onClick={() => setPins(chip.pinout.map((p) => ({ ...p })))} disabled={!dirty || busy}>Revert</button>
          <button className="tiny primary" onClick={save} disabled={!dirty || busy}>{busy ? "Saving…" : "Save pinout"}</button>
        </div>
      </div>

      <div className="row mt-12" style={{ gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Visual IC */}
        <div style={{ display: "flex", alignItems: "stretch", justifyContent: "center", gap: 0 }}>
          <div>
            {left.map((p) => (
              <PinChip key={p.pin} pin={p} side="left" selected={selPin === p} onClick={() => setSel(pins.indexOf(p))} />
            ))}
          </div>
          <div
            style={{
              width: 56, margin: "0 -1px", borderRadius: 6, background: "#111827", color: "#e5e7eb",
              border: "1px solid var(--border)", display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", position: "relative", padding: 6, textAlign: "center",
            }}
          >
            <span style={{ position: "absolute", top: 6, left: 6, width: 6, height: 6, borderRadius: "50%", background: "#e5e7eb" }} title="pin 1 reference" />
            <span className="tiny" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", opacity: 0.85 }}>
              {chip.displayName}
            </span>
          </div>
          <div>
            {right.map((p) => (
              <PinChip key={p.pin} pin={p} side="right" selected={selPin === p} onClick={() => setSel(pins.indexOf(p))} />
            ))}
          </div>
        </div>

        {/* Pin editor */}
        <div style={{ flex: 1, minWidth: 220 }}>
          {selPin ? (
            <div className="card compact">
              <div className="tiny dim">Editing pin</div>
              <div className="row gap-8 mt-8" style={{ alignItems: "center" }}>
                <label className="tiny dim" style={{ width: 48 }}>Pin #</label>
                <input type="number" value={selPin.pin} onChange={(e) => update(sel!, { pin: Number(e.target.value) || 0 })} style={{ width: 80 }} />
              </div>
              <div className="row gap-8 mt-8" style={{ alignItems: "center" }}>
                <label className="tiny dim" style={{ width: 48 }}>Name</label>
                <input type="text" value={selPin.name} onChange={(e) => update(sel!, { name: e.target.value })} style={{ flex: 1 }} />
              </div>
              <div className="row gap-8 mt-8" style={{ alignItems: "center" }}>
                <label className="tiny dim" style={{ width: 48 }}>Role</label>
                <select value={selPin.role} onChange={(e) => update(sel!, { role: e.target.value as PinRole })} style={{ flex: 1 }}>
                  {PIN_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: ROLE_COLOR[selPin.role] ?? "#9ca3af" }} />
              </div>
              <div className="row gap-8 mt-8" style={{ alignItems: "center" }}>
                <label className="tiny dim" style={{ width: 48 }}>Note</label>
                <input type="text" value={selPin.note ?? ""} onChange={(e) => update(sel!, { note: e.target.value || undefined })} style={{ flex: 1 }} />
              </div>
              <button className="tiny ghost mt-12" onClick={() => removePin(sel!)}>Remove this pin</button>
            </div>
          ) : (
            <p className="tiny dim">Click a leg to edit its name, role, and note. Roles are colour-coded; add or remove pins to match the real package.</p>
          )}
        </div>
      </div>

      {msg && <p className="tiny mt-8" style={{ color: msg.ok ? "var(--accent)" : "var(--danger)" }}>{msg.text}</p>}
    </div>
  );
}
