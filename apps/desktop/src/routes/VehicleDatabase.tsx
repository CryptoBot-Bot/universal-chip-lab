import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { moduleTemplateFor, readMethodFor, type VehicleProfile } from "@ecu/vehicle-db";

import { Topbar } from "../components/Topbar";
import { Api, type GarageVehicle, type JobCountStatus } from "../lib/api";

/**
 * Vehicle Database — drill down Make → Year → Model to reach one vehicle, then
 * see its full map AND the history of every unit we've read (local OBD reads +
 * the linked JobCount shop garage, merged by VIN). Garage sync pulls the shop's
 * cars in so the library reflects the whole shop, not just what this PC scanned.
 */

const READ_TONE: Record<string, string> = { obd: "ok", obd_partial: "warn", bench: "danger" };
const READ_LABEL: Record<string, string> = { obd: "OBD", obd_partial: "OBD partial", bench: "Bench" };

interface UnitRow {
  vin: string;
  localReads?: number;
  firstReadAt?: string;
  lastReadAt?: string;
  inGarage: boolean;
  garage?: GarageVehicle;
}
interface ModelBucket {
  make: string;
  year: number | null;
  model: string;
  profile: VehicleProfile | null;
  units: UnitRow[];
}

const yearLabel = (y: number | null) => (y == null ? "Unknown" : String(y));
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : "—");

export function VehicleDatabase() {
  const [profiles, setProfiles] = useState<VehicleProfile[]>([]);
  const [garage, setGarage] = useState<GarageVehicle[]>([]);
  const [link, setLink] = useState<JobCountStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [makeKey, setMakeKey] = useState<string | null>(null);
  const [yearKey, setYearKey] = useState<string | null>(null); // stringified year or "null"
  const [modelKey, setModelKey] = useState<string | null>(null);

  const nav = useNavigate();

  useEffect(() => {
    Api.vehicleLib.list().then(setProfiles).catch((e) => setErr((e as Error).message));
    Api.jobcount.status().then((s) => { setLink(s); if (s.linked) void syncGarage(); }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function syncGarage() {
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await Api.jobcount.listGarage();
      setGarage(r.vehicles);
      setSyncMsg(`Synced ${r.count} vehicle${r.count === 1 ? "" : "s"} from the shop garage.`);
    } catch (e) {
      setSyncMsg((e as Error).message);
    } finally { setSyncing(false); }
  }

  // Fold local profiles (with their read history) and the shop garage into one
  // Make→Year→Model index, merging units by VIN.
  const buckets = useMemo(() => {
    const map = new Map<string, ModelBucket>();
    const keyOf = (mk: string, y: number | null, md: string) => `${mk.toLowerCase()}|${y ?? "null"}|${md.toLowerCase()}`;
    const bucket = (mk: string, y: number | null, md: string) => {
      const k = keyOf(mk, y, md);
      let b = map.get(k);
      if (!b) { b = { make: mk, year: y, model: md, profile: null, units: [] }; map.set(k, b); }
      return b;
    };
    for (const p of profiles) {
      const b = bucket(p.make || "Unknown", p.year, p.model || "Unknown");
      b.profile = p;
      for (const v of p.knownVins ?? []) {
        b.units.push({ vin: v.vin, localReads: v.reads, firstReadAt: v.firstReadAt, lastReadAt: v.lastReadAt, inGarage: false });
      }
    }
    for (const g of garage) {
      const b = bucket(g.make || "Unknown", g.year, g.model || "Unknown");
      const hit = g.vin ? b.units.find((u) => u.vin && u.vin === g.vin) : undefined;
      if (hit) { hit.inGarage = true; hit.garage = g; }
      else b.units.push({ vin: g.vin, inGarage: true, garage: g });
    }
    return [...map.values()];
  }, [profiles, garage]);

  // Make column — unique makes with a vehicle (unit) count.
  const makes = useMemo(() => {
    const m = new Map<string, { label: string; units: number; models: Set<string> }>();
    for (const b of buckets) {
      const k = b.make.toLowerCase();
      const e = m.get(k) ?? { label: b.make, units: 0, models: new Set<string>() };
      e.units += b.units.length;
      e.models.add(b.model.toLowerCase());
      m.set(k, e);
    }
    return [...m.entries()]
      .map(([key, v]) => ({ key, label: v.label, units: v.units, models: v.models.size }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [buckets]);

  const years = useMemo(() => {
    if (!makeKey) return [];
    const m = new Map<string, { year: number | null; units: number }>();
    for (const b of buckets) {
      if (b.make.toLowerCase() !== makeKey) continue;
      const k = String(b.year ?? "null");
      const e = m.get(k) ?? { year: b.year, units: 0 };
      e.units += b.units.length;
      m.set(k, e);
    }
    return [...m.entries()]
      .map(([key, v]) => ({ key, year: v.year, units: v.units }))
      .sort((a, b) => (b.year ?? -1) - (a.year ?? -1));
  }, [buckets, makeKey]);

  const models = useMemo(() => {
    if (!makeKey || yearKey == null) return [];
    return buckets
      .filter((b) => b.make.toLowerCase() === makeKey && String(b.year ?? "null") === yearKey)
      .map((b) => ({ key: b.model.toLowerCase(), label: b.model, units: b.units.length, mapped: !!b.profile }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [buckets, makeKey, yearKey]);

  const selected = useMemo(() => {
    if (!makeKey || yearKey == null || !modelKey) return null;
    return buckets.find((b) => b.make.toLowerCase() === makeKey && String(b.year ?? "null") === yearKey && b.model.toLowerCase() === modelKey) ?? null;
  }, [buckets, makeKey, yearKey, modelKey]);

  function pickMake(k: string) { setMakeKey(k); setYearKey(null); setModelKey(null); }
  function pickYear(k: string) { setYearKey(k); setModelKey(null); }

  const totalUnits = buckets.reduce((n, b) => n + b.units.length, 0);

  return (
    <>
      <Topbar title="Vehicle Database" crumb={`${profiles.length} model${profiles.length === 1 ? "" : "s"} · ${totalUnits} unit${totalUnits === 1 ? "" : "s"}`} />
      <div className="content">
        <div className="vdb">
          <style>{styles}</style>

          {/* garage link bar */}
          <div className="vdb-bar card compact">
            {link?.linked ? (
              <>
                <span className="badge ok">shop linked</span>
                <span className="tiny">{link.shopName}</span>
                <button className="tiny" onClick={() => void syncGarage()} disabled={syncing} style={{ marginLeft: "auto" }}>
                  {syncing ? "Syncing…" : "↻ Sync garage"}
                </button>
              </>
            ) : (
              <>
                <span className="badge">shop not linked</span>
                <span className="tiny dim">Link a JobCount shop in Settings to fold its garage into the library.</span>
                <button className="tiny" onClick={() => nav("/settings")} style={{ marginLeft: "auto" }}>Open Settings →</button>
              </>
            )}
          </div>
          {syncMsg && <div className="tiny dim vdb-syncmsg">{syncMsg}</div>}
          {err && <div className="vdb-err">{err}</div>}

          {/* Make → Year → Model cascade */}
          <div className="vdb-cascade">
            <div className="card vdb-col">
              <h4>Make <span className="tiny dim">{makes.length}</span></h4>
              <div className="vdb-scroll">
                {makes.map((m) => (
                  <button key={m.key} className={`vdb-item ${makeKey === m.key ? "sel" : ""}`} onClick={() => pickMake(m.key)}>
                    <span className="vdb-item-title">{m.label}</span>
                    <span className="tiny dim">{m.models} model{m.models === 1 ? "" : "s"} · {m.units} unit{m.units === 1 ? "" : "s"}</span>
                  </button>
                ))}
                {!makes.length && <p className="tiny dim">No vehicles yet. Read a VIN in the Cockpit or sync the shop garage.</p>}
              </div>
            </div>

            <div className="card vdb-col">
              <h4>Year <span className="tiny dim">{years.length || ""}</span></h4>
              <div className="vdb-scroll">
                {!makeKey && <p className="tiny dim">Pick a make.</p>}
                {years.map((y) => (
                  <button key={y.key} className={`vdb-item ${yearKey === y.key ? "sel" : ""}`} onClick={() => pickYear(y.key)}>
                    <span className="vdb-item-title">{yearLabel(y.year)}</span>
                    <span className="tiny dim">{y.units} unit{y.units === 1 ? "" : "s"}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="card vdb-col">
              <h4>Model <span className="tiny dim">{models.length || ""}</span></h4>
              <div className="vdb-scroll">
                {makeKey && yearKey == null && <p className="tiny dim">Pick a year.</p>}
                {models.map((m) => (
                  <button key={m.key} className={`vdb-item ${modelKey === m.key ? "sel" : ""}`} onClick={() => setModelKey(m.key)}>
                    <span className="vdb-item-title">{m.label}{!m.mapped && <span className="tiny dim"> · not mapped</span>}</span>
                    <span className="tiny dim">{m.units} unit{m.units === 1 ? "" : "s"} on file</span>
                  </button>
                ))}
                {makeKey && yearKey != null && !models.length && <p className="tiny dim">No models.</p>}
              </div>
            </div>
          </div>

          {/* Detail */}
          {selected ? <Detail bucket={selected} onCockpit={() => nav("/cockpit")} /> : (
            <div className="card vdb-detail"><p className="dim">Pick a make, year and model to see its map and read history.</p></div>
          )}
        </div>
      </div>
    </>
  );
}

function Detail({ bucket, onCockpit }: { bucket: ModelBucket; onCockpit: () => void }) {
  const sel = bucket.profile;
  const units = [...bucket.units].sort((a, b) => (b.lastReadAt || b.garage?.createdAt || "").localeCompare(a.lastReadAt || a.garage?.createdAt || ""));
  const localCount = units.filter((u) => u.localReads).length;
  const garageCount = units.filter((u) => u.inGarage).length;

  return (
    <div className="card vdb-detail">
      <div className="row spread">
        <div>
          <h3>{yearLabel(bucket.year)} {bucket.make} {bucket.model} {sel?.trim && <span className="tiny dim">{sel.trim}</span>}</h3>
          <div className="vdb-meta tiny mono dim">
            {sel ? <><span>{sel.bodyType}</span>{sel.market && <span>{sel.market}</span>}<span>WMI {sel.wmi?.join("/") || "—"}</span><span>trust {sel.provenance.source}</span></>
              : <span>not yet mapped in the Chip Lab</span>}
            <span>{units.length} unit{units.length === 1 ? "" : "s"} · {localCount} read here · {garageCount} in garage</span>
          </div>
        </div>
        {sel && <button className="tiny primary" onClick={onCockpit}>Open in Cockpit →</button>}
      </div>

      {/* Read history — every unit of this YMM */}
      <h5 className="vdb-h">Read history <span className="tiny dim">— {units.length} unit{units.length === 1 ? "" : "s"}</span></h5>
      {units.length ? (
        <div className="vdb-hist">
          <div className="vdb-hrow vdb-hhead tiny dim">
            <span>VIN</span><span>Reads</span><span>First read</span><span>Last</span><span>Garage</span>
          </div>
          {units.map((u, i) => (
            <div className="vdb-hrow" key={u.vin || i}>
              <span className="mono tiny">{u.vin || <span className="dim">no VIN</span>}</span>
              <span className="tiny">{u.localReads ? `${u.localReads}×` : <span className="dim">—</span>}</span>
              <span className="tiny dim">{fmtDate(u.firstReadAt)}</span>
              <span className="tiny dim">{fmtDate(u.lastReadAt)}</span>
              <span className="tiny">
                {u.inGarage
                  ? <span className="badge ok" title={u.garage?.customerName ? `Customer: ${u.garage.customerName}` : undefined}>in garage{u.garage?.createdAt ? ` · ${fmtDate(u.garage.createdAt)}` : ""}</span>
                  : <span className="dim">local only</span>}
              </span>
            </div>
          ))}
        </div>
      ) : <p className="tiny dim">No units read yet for this model.</p>}

      {/* Map (only when this YMM is mapped in the Chip Lab) */}
      {sel ? (
        <>
          <h5 className="vdb-h">Buses</h5>
          <div className="vdb-buses">
            {sel.buses.map((b) => (
              <span className="vdb-bus mono tiny" key={b.id}>{b.label} · {b.protocol} · {b.bitrate / 1000}k{b.obdPins ? ` · pins ${b.obdPins}` : ""}</span>
            ))}
          </div>

          <h5 className="vdb-h">Modules <span className="tiny dim">— {sel.modules.length}</span></h5>
          <div className="vdb-mods">
            <div className="vdb-mrow vdb-mhead tiny dim"><span>Module</span><span>Category</span><span>Req/Resp</span><span>Memory</span><span>Actions</span></div>
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
                {sel.capabilities.map((c) => <span key={c.id} className={`vdb-cap ${c.risk}`}>{c.label}</span>)}
              </div>
            </>
          )}
          {sel.notes && <p className="tiny dim mt-8">{sel.notes}</p>}
        </>
      ) : (
        <p className="tiny dim mt-8">
          This vehicle is in the shop garage but not yet mapped here. Read it on the bus in the Vehicle Cockpit to
          build its module map — its VIN history above will carry over.
        </p>
      )}
    </div>
  );
}

const styles = `
.vdb-err { font-size: 12px; color: var(--danger); background: var(--danger-dim); border: 1px solid var(--danger); border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; }
.vdb-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.vdb-syncmsg { margin-bottom: 10px; }
.vdb-cascade { display: grid; grid-template-columns: 1fr 1fr 1.2fr; gap: 12px; align-items: start; margin-bottom: 12px; }
@media (max-width: 900px) { .vdb-cascade { grid-template-columns: 1fr; } }
.vdb-col { display: flex; flex-direction: column; }
.vdb-col h4 { margin: 0 0 8px; }
.vdb-scroll { display: flex; flex-direction: column; gap: 5px; max-height: 320px; overflow-y: auto; }
.vdb-item { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 8px 10px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
.vdb-item.sel { border-color: var(--accent); }
.vdb-item-title { font-size: 13px; color: var(--fg-0); font-weight: 600; }
.vdb-detail h3 { margin: 0; }
.vdb-meta { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 5px; }
.vdb-h { margin: 16px 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-2); }
.vdb-hist { display: flex; flex-direction: column; gap: 3px; }
.vdb-hrow { display: grid; grid-template-columns: 2fr 0.6fr 1fr 1fr 1.4fr; gap: 10px; align-items: center; padding: 6px 9px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; }
.vdb-hhead { background: none; border: none; padding: 2px 9px; }
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
