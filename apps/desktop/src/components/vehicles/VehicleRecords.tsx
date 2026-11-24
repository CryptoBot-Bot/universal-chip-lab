import { moduleTemplateFor } from "@ecu/vehicle-db";
import type { VehicleProfile } from "@ecu/vehicle-db";

import type { JobCountStatus } from "../../lib/api";
import { CATEGORY_LABEL, addressedSystems } from "../../lib/diag";
import { VIcon } from "./icons";
import { memoryChip } from "./VehicleMap";
import { SOURCE_TEXT, fmtDate, guardOf, isReplayScan, isVirtualUnit, plural, scanSummary, splitLabel, type ModelBucket } from "./vehicleFacts";

/**
 * The record sections under the vehicle map: every car of this model on file (local
 * reads + the linked shop garage), the buses and modules with their memory-read
 * method, and the model's listed capabilities, notes and where its map came from.
 */

export function CarsOnFile({ bucket, link, syncing, syncMsg, onSync, onSettings }: {
  bucket: ModelBucket; link: JobCountStatus | null; syncing: boolean; syncMsg: string | null;
  onSync: () => void; onSettings: () => void;
}) {
  const units = [...bucket.units].sort((a, b) => (b.lastReadAt || b.garage?.createdAt || "").localeCompare(a.lastReadAt || a.garage?.createdAt || ""));
  const local = units.filter((u) => u.localReads).length;
  const garage = units.filter((u) => u.inGarage).length;

  return (
    <section className="ual-card vdb-section" aria-labelledby="vdb-cars-title">
      <div className="vdb-cardhead">
        <h2 id="vdb-cars-title" className="ual-h2">Cars on file</h2>
        <span className="ual-muted">{plural(units.length, "car")} · {local} read here · {garage} in the shop garage</span>
        <span className="vdb-cardhead-right">
          {link?.linked ? (
            <>
              <span className="ual-chip clean">Shop linked{link.shopName ? ` · ${link.shopName}` : ""}</span>
              <button type="button" className="tiny" onClick={onSync} disabled={syncing}><VIcon name="sync" size={14} />{syncing ? "Syncing…" : "Sync garage"}</button>
            </>
          ) : (
            <>
              <span className="ual-chip unread">Shop not linked</span>
              <button type="button" className="tiny ghost" onClick={onSettings}>Link a shop in Settings</button>
            </>
          )}
        </span>
      </div>
      {syncMsg && <p className="vdb-cardnote ual-muted" role="status">{syncMsg}</p>}
      {units.length === 0 ? (
        <p className="vdb-cardnote ual-muted">No car of this model has been read yet. Read its VIN in Auto Diagnostic (or add it by VIN above).</p>
      ) : (
        <div className="vdb-table vdb-units" role="table" aria-label="Cars of this model">
          <div className="vdb-tr head" role="row">
            <span role="columnheader">VIN</span><span role="columnheader">Reads here</span><span role="columnheader">First read</span>
            <span role="columnheader">Last read</span><span role="columnheader">Last scan</span><span role="columnheader">Modules read</span><span role="columnheader">Shop garage</span>
          </div>
          {units.map((u, i) => {
            const last = u.scans?.length ? u.scans[u.scans.length - 1] : null;
            return (
              <div className="vdb-tr" role="row" key={u.vin || `garage-${i}`}>
                <span role="cell" data-label="VIN" className="ual-mono vdb-vin">{u.vin || <span className="ual-muted">no VIN</span>}</span>
                <span role="cell" data-label="Reads here">{u.localReads ? `${u.localReads}×` : <span className="ual-muted">—</span>}</span>
                <span role="cell" data-label="First read" className="ual-muted">{fmtDate(u.firstReadAt)}</span>
                <span role="cell" data-label="Last read" className="ual-muted">{fmtDate(u.lastReadAt)}</span>
                <span role="cell" data-label="Last scan">
                  {last ? (
                    <>
                      {fmtDate(last.at)} <span className="ual-muted">· {scanSummary(last)}</span>
                      {last.sim && (isReplayScan(last)
                        ? <span className="ual-chip info vdb-inline-chip" title={`Answered by the desk simulator playing back a recording of this car (${last.sim})`}>replay</span>
                        : <span className="ual-chip info vdb-inline-chip" title={`Answered by a virtual vehicle: ${last.sim}`}>virtual</span>)}
                      {u.scans!.length > 1 && <span className="ual-muted"> · {plural(u.scans!.length, "scan")} on file</span>}
                    </>
                  ) : <span className="ual-muted">never scanned</span>}
                  {isVirtualUnit(u) && <span className="vdb-sr"> (only a virtual vehicle answered for this VIN)</span>}
                </span>
                <span role="cell" data-label="Modules read">
                  {u.inventory ? (
                    <>
                      {u.inventory.modules.filter((m) => m.status === "ok").length}/{u.inventory.modules.length}
                      <span className="ual-muted"> · {plural(u.inventory.modules.filter((m) => m.summary.serial).length, "serial")} · {fmtDate(u.inventory.at)}</span>
                      {u.inventory.sim && <span className="ual-chip info vdb-inline-chip" title={`Read from the simulator (${u.inventory.sim})`}>sim</span>}
                      {(u.inventoryChanges?.length ?? 0) > 0 && <span className="ual-chip warn vdb-inline-chip" title={u.inventoryChanges!.slice(-5).map((c) => `${c.label}: ${c.key} ${c.from} → ${c.to}`).join("\n")}>{plural(u.inventoryChanges!.length, "change")}</span>}
                    </>
                  ) : <span className="ual-muted">not read</span>}
                </span>
                <span role="cell" data-label="Shop garage">
                  {u.inGarage
                    ? <span className="ual-chip clean" title={u.garage?.customerName ? `Customer: ${u.garage.customerName}` : undefined}>in garage{u.garage?.createdAt ? ` · ${fmtDate(u.garage.createdAt)}` : ""}</span>
                    : <span className="ual-muted">local only</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function ModulesCard({ profile }: { profile: VehicleProfile }) {
  const addressed = addressedSystems(profile);
  const rest = profile.modules.filter((m) => !addressed.includes(m));
  const modules = [...addressed, ...rest];
  return (
    <section className="ual-card vdb-section" aria-labelledby="vdb-mods-title">
      <div className="vdb-cardhead">
        <h2 id="vdb-mods-title" className="ual-h2">Buses &amp; modules</h2>
        <span className="ual-muted">{plural(modules.length, "module")} · memory read method is an estimate until bench-verified</span>
      </div>
      <div className="vdb-buses">
        {profile.buses.map((b) => (
          <span className="ual-chip ual-mono" key={b.id}>{b.label} · {b.protocol}{b.bitrate ? ` · ${b.bitrate / 1000}k` : ""}{b.obdPins ? ` · pins ${b.obdPins}` : ""}</span>
        ))}
      </div>
      <div className="vdb-table vdb-mods" role="table" aria-label="Modules of this model">
        <div className="vdb-tr head" role="row">
          <span role="columnheader">Module</span><span role="columnheader">Area</span><span role="columnheader">Request / response</span>
          <span role="columnheader">Protocol</span><span role="columnheader">Memory read</span><span role="columnheader">Known actions</span>
        </div>
        {modules.map((m) => {
          const tpl = moduleTemplateFor(m.id, m.category);
          const mem = memoryChip(m);
          const guard = guardOf(m);
          const { short } = splitLabel(m.label);
          return (
            <div className="vdb-tr" role="row" key={m.id}>
              <span role="cell" data-label="Module" className="vdb-modname">
                <b>{short}{guard && <span className="vdb-prot" title={guard.reason}><VIcon name="shield" size={12} /><span className="vdb-sr">protected</span></span>}</b>
                <small>{m.label}</small>
              </span>
              <span role="cell" data-label="Area"><span className="vdb-dot" data-cat={m.category} aria-hidden="true" />{CATEGORY_LABEL[m.category] ?? m.category}</span>
              <span role="cell" data-label="Request / response" className="ual-mono ual-muted">{m.addressing?.request ?? "—"} / {m.addressing?.response ?? "—"}</span>
              <span role="cell" data-label="Protocol" className="ual-muted">{m.protocol && m.protocol !== "unknown" ? (m.protocol === "kwp2000" ? "KWP2000" : m.protocol.toUpperCase()) : "—"}</span>
              <span role="cell" data-label="Memory read"><span className={`ual-chip ${mem.cls}`}>{mem.text}</span></span>
              <span role="cell" data-label="Known actions" className="ual-muted">{tpl ? tpl.actions.length : "—"}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function AboutCard({ profile }: { profile: VehicleProfile }) {
  const pv = profile.provenance;
  return (
    <section className="ual-card pad" aria-labelledby="vdb-about-title">
      <h2 id="vdb-about-title" className="ual-h2">Capabilities &amp; notes</h2>
      {profile.capabilities.length > 0 ? (
        <>
          <p className="ual-sub">What this model's map lists. For reference only — on real cars this app sends read requests only.</p>
          <div className="vdb-capchips">
            {profile.capabilities.map((c) => (
              <span key={c.id} className={`ual-chip ${c.risk === "read" ? "clean" : "warn"}`}
                title={[c.sequence.join("  ·  "), c.note].filter(Boolean).join(" — ")}>
                {c.label}{c.risk !== "read" ? ` · ${c.risk}` : ""}
              </span>
            ))}
          </div>
        </>
      ) : <p className="ual-muted">No capabilities listed for this model yet.</p>}
      {profile.notes && <p className="vdb-notes">{profile.notes}</p>}
      <dl className="ual-dl">
        <dt>Map source</dt><dd>{SOURCE_TEXT[pv.source] ?? pv.source} · confidence {Math.round((pv.confidence ?? 0) * 100)} %</dd>
        <dt>Filed</dt><dd>{fmtDate(pv.createdAt)}{pv.updatedAt ? ` · updated ${fmtDate(pv.updatedAt)}` : ""}</dd>
        <dt>Body</dt><dd>{profile.bodyType}{profile.decoded?.bodyClass ? ` · ${profile.decoded.bodyClass}` : ""}{profile.decoded?.driveType ? ` · ${profile.decoded.driveType}` : ""}</dd>
        {profile.market && <><dt>Market</dt><dd>{profile.market}</dd></>}
        <dt>WMI</dt><dd className="ual-mono">{profile.wmi?.join(" / ") || "—"}</dd>
        {profile.decoded?.plantCountry && <><dt>Built in</dt><dd>{[profile.decoded.plantCity, profile.decoded.plantCountry].filter(Boolean).join(", ")}</dd></>}
      </dl>
    </section>
  );
}
