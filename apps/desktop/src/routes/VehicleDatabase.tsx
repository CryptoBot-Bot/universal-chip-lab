import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { moduleTemplateFor, readMethodFor, type VehicleProfile } from "@ecu/vehicle-db";

import { Topbar } from "../components/Topbar";
import { Api } from "../lib/api";

/**
 * Vehicle Database — every mapped vehicle in the self-growing library. Pick one to
 * see its full structure: identity, buses, and each module with its addressing,
 * OBD-vs-bench read method, and how many actions we know for it.
 */

const READ_TONE: Record<string, string> = { obd: "ok", obd_partial: "warn", bench: "danger" };
const READ_LABEL: Record<string, string> = { obd: "OBD", obd_partial: "OBD partial", bench: "Bench" };

export function VehicleDatabase() {
  const [profiles, setProfiles] = useState<VehicleProfile[]>([]);
  const [sel, setSel] = useState<VehicleProfile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    Api.vehicleLib.list().then((list) => {
      setProfiles(list);
      setSel((s) => s ?? list[0] ?? null);
    }).catch((e) => setErr((e as Error).message));
  }, []);

  return (
    <>
      <Topbar title="Vehicle Database" crumb={`${profiles.length} vehicle${profiles.length === 1 ? "" : "s"}`} />
      <div className="content">
        <div className="vdb">
          <style>{styles}</style>
          {err && <div className="vdb-err">{err}</div>}

          <div className="vdb-grid">
            {/* list */}
            <div className="card vdb-list">
              <h4>Library</h4>
              {profiles.map((p) => (
                <button key={p.id} className={`vdb-item ${sel?.id === p.id ? "sel" : ""}`} onClick={() => setSel(p)}>
                  <span className="vdb-item-title">{p.year} {p.make} {p.model}</span>
                  <span className="tiny dim">{p.bodyType} · {p.modules.length} modules · {p.provenance.source}</span>
                </button>
              ))}
              {!profiles.length && <p className="tiny dim">No vehicles yet. Map one in the Cockpit or Training Room.</p>}
            </div>

            {/* detail */}
            {sel ? (
              <div className="card vdb-detail">
                <div className="row spread">
                  <div>
                    <h3>{sel.year} {sel.make} {sel.model} <span className="tiny dim">{sel.trim}</span></h3>
                    <div className="vdb-meta tiny mono dim">
                      <span>{sel.bodyType}</span><span>{sel.market}</span>
                      <span>WMI {sel.wmi?.join("/") || "—"}</span>
                      <span>trust {sel.provenance.source}</span>
                    </div>
                  </div>
                  <button className="tiny primary" onClick={() => nav("/cockpit")}>Open in Cockpit →</button>
                </div>

                <h5 className="vdb-h">Buses</h5>
                <div className="vdb-buses">
                  {sel.buses.map((b) => (
                    <span className="vdb-bus mono tiny" key={b.id}>{b.label} · {b.protocol} · {(b.bitrate / 1000)}k{b.obdPins ? ` · pins ${b.obdPins}` : ""}</span>
                  ))}
                </div>

                <h5 className="vdb-h">Modules <span className="tiny dim">— {sel.modules.length}</span></h5>
                <div className="vdb-mods">
                  <div className="vdb-mrow vdb-mhead tiny dim">
                    <span>Module</span><span>Category</span><span>Req/Resp</span><span>Memory</span><span>Actions</span>
                  </div>
                  {sel.modules.map((m) => {
                    const tpl = moduleTemplateFor(m.id, m.category);
                    const read = readMethodFor(m.id);
                    return (
                      <div className="vdb-mrow" key={m.id}>
                        <span className="vdb-mname">{m.label}</span>
                        <span className="tiny"><span className="vdb-dot" data-cat={m.category} /> {m.category}</span>
                        <span className="tiny mono dim">{m.addressing?.request ?? "—"}/{m.addressing?.response ?? "—"}</span>
                        <span className={`badge ${READ_TONE[read]}`}>{READ_LABEL[read]}</span>
                        <span className="tiny dim">{tpl ? `${tpl.actions.length}` : "—"}</span>
                      </div>
                    );
                  })}
                </div>

                {sel.capabilities.length > 0 && (
                  <>
                    <h5 className="vdb-h">Vehicle capabilities</h5>
                    <div className="vdb-caps">
                      {sel.capabilities.map((c) => (
                        <span key={c.id} className={`vdb-cap ${c.risk}`}>{c.label}</span>
                      ))}
                    </div>
                  </>
                )}
                {sel.notes && <p className="tiny dim mt-8">{sel.notes}</p>}
              </div>
            ) : (
              <div className="card"><p className="dim">Select a vehicle.</p></div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

const styles = `
.vdb-err { font-size: 12px; color: var(--danger); background: var(--danger-dim); border: 1px solid var(--danger); border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; }
.vdb-grid { display: grid; grid-template-columns: 280px 1fr; gap: 12px; align-items: start; }
@media (max-width: 900px) { .vdb-grid { grid-template-columns: 1fr; } }
.vdb-list { display: flex; flex-direction: column; gap: 5px; }
.vdb-item { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 8px 10px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
.vdb-item.sel { border-color: var(--accent); }
.vdb-item-title { font-size: 13px; color: var(--fg-0); font-weight: 600; }
.vdb-detail h3 { margin: 0; }
.vdb-meta { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 5px; }
.vdb-h { margin: 16px 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-2); }
.vdb-buses { display: flex; gap: 8px; flex-wrap: wrap; }
.vdb-bus { background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; padding: 4px 9px; }
.vdb-mods { display: flex; flex-direction: column; gap: 3px; }
.vdb-mrow { display: grid; grid-template-columns: 2fr 1.2fr 1fr auto auto; gap: 10px; align-items: center; padding: 6px 9px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; }
.vdb-mhead { background: none; border: none; padding: 2px 9px; }
.vdb-mname { font-size: 12.5px; color: var(--fg-0); }
.vdb-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; }
.vdb-dot[data-cat="powertrain"] { background: #f97316; } .vdb-dot[data-cat="transmission"] { background: #eab308; }
.vdb-dot[data-cat="chassis"] { background: #38bdf8; } .vdb-dot[data-cat="body"] { background: #a78bfa; }
.vdb-dot[data-cat="safety"] { background: #ef4444; } .vdb-dot[data-cat="infotainment"] { background: #22d3ee; }
.vdb-dot[data-cat="hvac"] { background: #34d399; } .vdb-dot[data-cat="network"] { background: #94a3b8; }
.vdb-caps { display: flex; gap: 6px; flex-wrap: wrap; }
.vdb-cap { font-size: 11px; padding: 3px 9px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-2); }
.vdb-cap.write, .vdb-cap.caution { border-color: var(--warn); color: var(--warn); }
`;
