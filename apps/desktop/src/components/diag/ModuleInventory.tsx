import { Fragment, useState } from "react";

import type { CarInventory, InventoryChange, ModuleInventoryEntry } from "@ecu/vehicle-db";

import { splitLabel } from "../../lib/diag";
import { voltsText } from "../../lib/voltage";
import { Icon } from "./icons";

/**
 * This car's module inventory: what every module said it is on the last identity
 * read — part number, serial number, software, hardware, supplier, build date, and
 * the VIN it holds (a module whose VIN is not this car's came from another car).
 * Click a row for every record read, with the request that read it.
 */
/** One value cell: kept on one line, cut with "…" when long — the full value is in the tooltip and the row's details. */
function Cell({ v }: { v?: string }) {
  return <td className="ual-mono inv-v" title={v}>{v ?? "—"}</td>;
}

export function ModuleInventory({ inventory, changes, carVin, busy, canRead, onRead, voltage = {} }: {
  inventory: CarInventory | null;
  changes: InventoryChange[];
  carVin?: string;
  busy: boolean;
  canRead: boolean;
  onRead: () => void;
  /** Supply voltage each module measures itself, read from the car connected now (modules that report it). */
  voltage?: Record<string, { volts: number; at: string }>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const mods = inventory?.modules ?? [];
  const ok = mods.filter((m) => m.status === "ok").length;
  const serials = mods.filter((m) => m.summary.serial).length;
  const foreign = mods.filter((m) => m.summary.vin && carVin && m.summary.vin !== carVin);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="ual-card pad" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 320px" }}>
          <h2 className="ual-h2">Modules &amp; serial numbers</h2>
          <span className="ual-muted" style={{ fontSize: 13 }}>
            {inventory
              ? `Read ${new Date(inventory.at).toLocaleString()}${inventory.sim ? " · from the simulator" : ""} · ${ok}/${mods.length} identified · ${serials} serial number${serials === 1 ? "" : "s"}`
              : "Not read on this car yet. One read gives every module's part number, software and hardware version, serial number, supplier and the VIN it holds."}
          </span>
        </div>
        <button className="primary" disabled={busy || !canRead} onClick={onRead} title={canRead ? "Identification reads only — nothing is written" : "Connect a device first"}>
          {inventory ? "Read again" : "Read identity"}
        </button>
      </div>

      {foreign.length > 0 && (
        <div className="dg-note warn" style={{ margin: 0 }}>
          {foreign.length} module{foreign.length === 1 ? " holds" : "s hold"} a VIN that is not this car's ({foreign.map((m) => splitLabel(m.label).short).join(", ")}) — likely fitted from another vehicle.
        </div>
      )}
      {changes.length > 0 && (
        <div className="ual-card pad" style={{ gap: 8 }}>
          <span className="ual-eyebrow">Changed between visits</span>
          {changes.slice().reverse().slice(0, 8).map((c, i) => (
            <div key={i} style={{ fontSize: 13 }}>
              <b>{splitLabel(c.label).short}</b> {c.key}: <span className="ual-mono">{c.from}</span> → <span className="ual-mono">{c.to}</span>
              <span className="ual-muted"> · {new Date(c.at).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      )}

      {mods.length > 0 && (
        <div className="ual-card" style={{ overflowX: "auto" }}>
          <table className="inv-tbl">
            <thead>
              <tr><th>System</th><th>Part no.</th><th>Serial</th><th title="Supply voltage the module measures itself, read from the car connected now. Not every module reports it.">Voltage</th><th>Software</th><th>Hardware</th><th>Supplier</th><th>Built</th><th>VIN in module</th><th aria-label="Details" /></tr>
            </thead>
            <tbody>
              {mods.map((m: ModuleInventoryEntry) => {
                const s = m.summary;
                const { short, name } = splitLabel(m.label);
                const vinState = !s.vin ? "" : !carVin ? "" : s.vin === carVin ? "same" : "other";
                const isOpen = open === m.moduleId;
                return (
                  <Fragment key={m.moduleId}>
                    <tr className={`${m.status === "no_response" ? "quiet" : ""} ${isOpen ? "open" : ""}`} onClick={() => setOpen(isOpen ? null : m.moduleId)}>
                      <td>
                        <b>{short}</b>{m.protectedKind && <span className="dg-tile-lock" style={{ marginLeft: 6 }}><Icon name="shield" size={12} />protected</span>}
                        <div className="ual-muted" style={{ fontSize: 12 }}>{name} · <span className="ual-mono">{m.responseId}</span></div>
                      </td>
                      <Cell v={s.partNo} />
                      <Cell v={s.serial} />
                      <td className="ual-mono" title={voltage[m.moduleId] ? `Read at ${new Date(voltage[m.moduleId].at).toLocaleTimeString()}` : "This module has no known voltage reading"}>{voltage[m.moduleId] ? voltsText(voltage[m.moduleId].volts) : "—"}</td>
                      <Cell v={s.swPartNo ?? s.swVersion} />
                      <Cell v={s.hwVersion ?? (s.hwPartNo && s.hwPartNo !== s.partNo ? s.hwPartNo : undefined)} />
                      <Cell v={s.supplier} />
                      <td>{s.mfgDate ?? "—"}</td>
                      <td>{vinState === "same" ? <span className="ual-chip clean">this car</span> : vinState === "other" ? <span className="ual-chip fault">{s.vin}</span> : s.vin ? <span className="ual-mono">{s.vin}</span> : "—"}</td>
                      <td><button className="tiny ghost" aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} every record of ${short}`} onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : m.moduleId); }}>{isOpen ? "Hide" : `${m.records.length}`}</button></td>
                    </tr>
                    {isOpen && (
                      <tr className="inv-detail"><td colSpan={10}>
                        {m.records.length === 0 && <div className="ual-muted">No identification record answered{m.status === "no_response" ? " — the module was silent" : ""}.</div>}
                        {m.records.map((r, i) => (
                          <div key={i} className="inv-rec"><span className="ual-mono ual-muted">{r.id}{r.session === "03" ? " · ext" : ""}</span><span>{r.label}</span><b className="ual-mono">{r.value}</b></div>
                        ))}
                        {m.refused?.length ? <div className="ual-muted" style={{ fontSize: 12, marginTop: 6 }}>Refused by the module: {m.refused.join(", ")}</div> : null}
                        {m.note && <div className="ual-muted" style={{ fontSize: 12, marginTop: 4 }}>{m.note}</div>}
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
