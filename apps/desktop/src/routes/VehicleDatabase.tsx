import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { VehicleProfile } from "@ecu/vehicle-db";

import { AddVehicleByVin } from "../components/vehicles/AddVehicleByVin";
import { AgentPanel, LearnedList, type RunsOn } from "../components/vehicles/DigDeeper";
import { VIcon } from "../components/vehicles/icons";
import { useDeepMap } from "../components/vehicles/useDeepMap";
import { SystemDetail, VehicleMapTiles, unaddressedNote } from "../components/vehicles/VehicleMap";
import { KnowledgeCard } from "../components/vehicles/KnowledgeCard";
import { ModelCatalog } from "../components/vehicles/ModelCatalog";
import { AboutCard, CarsOnFile, ModulesCard } from "../components/vehicles/VehicleRecords";
import {
  buildBuckets, busSpec, carsSeenSpec, engineSpec, fmtDate, gearboxSpec, lastActivity, lastReplay, makeKeyOf, modelKeyOf,
  monogram, plural, simMatches, unitCounts, yearKeyOf, yearLabel, type ModelBucket, type Spec, type UnitRow,
} from "../components/vehicles/vehicleFacts";
import { Api, type GarageVehicle, type JobCountStatus } from "../lib/api";
import { addressedSystems, ymmLabel } from "../lib/diag";
import { useSuperDevice } from "../lib/superdevice-connection";
import { useWorkbench } from "../lib/workbench";
import "./vehicleDatabase.css";

/**
 * Vehicles Database — every year/make/model the lab knows, and how deeply.
 *
 *   search + add by VIN
 *   make cards → year / model chips
 *   the model: spec strip, the vehicle map (one tile per system: identity / live / codes)
 *   right: the AI agent ("Dig deeper", read-only, protected systems left out) + what was learned
 *   below: cars on file (local reads + the shop garage), buses & modules, capabilities & notes
 *
 * The library is re-read every few seconds, so a deep map (which saves after every
 * module) or a scan elsewhere fills the map in while you watch.
 */

const SEL_KEY = "vdb.selection.v1";
/** Auto Diagnostic's saved session (routes/DiagnosticsTab). Seeded so "Open in Auto Diagnostic" lands on this model. */
const DIAG_SESSION_KEY = "diag.session.v1";

interface Sel { make: string | null; year: string | null; model: string | null }

function loadSel(): Sel {
  try {
    const r = JSON.parse(localStorage.getItem(SEL_KEY) || "null") as Partial<Sel> | null;
    if (r && typeof r === "object") return { make: r.make ?? null, year: r.year ?? null, model: r.model ?? null };
  } catch { /* storage unavailable */ }
  return { make: null, year: null, model: null };
}

const libSig = (list: VehicleProfile[]) => list.map((x) => [
  x.id, x.provenance?.updatedAt ?? "", x.modules.length,
  x.modules.reduce((n, m) => n + (m.explored?.runCount ?? 0), 0),
  (x.knownVins ?? []).reduce((n, v) => n + v.reads + (v.scans?.length ?? 0), 0),
].join("@")).join("|");

function carsText(units: UnitRow[]): string {
  const { real, virtual } = unitCounts(units);
  const bits = [real ? plural(real, "real car") : "", virtual ? plural(virtual, "virtual car") : ""].filter(Boolean);
  return bits.length ? bits.join(" · ") : "no cars read yet";
}

function SpecBox({ label, spec, fallback }: { label: string; spec: Spec | null; fallback: string }) {
  return (
    <div className="vdb-spec">
      <span>{label}</span>
      <b>{spec?.value ?? <span className="ual-muted">{fallback}</span>}</b>
      {spec?.source && <small>{spec.source}</small>}
    </div>
  );
}

export function VehicleDatabase() {
  const nav = useNavigate();
  const sd = useSuperDevice();
  const wb = useWorkbench();
  const online = sd.link === "online";

  const [profiles, setProfiles] = useState<VehicleProfile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [garage, setGarage] = useState<GarageVehicle[]>([]);
  const [link, setLink] = useState<JobCountStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<"cars" | "models">("cars");
  const [sel, setSel] = useState<Sel>(loadSel);
  const [systemId, setSystemId] = useState<string | null>(null);

  const sig = useRef("");
  const reload = useCallback(async () => {
    try {
      const list = await Api.vehicleLib.list();
      const s = libSig(list);
      if (s !== sig.current) { sig.current = s; setProfiles(list); }
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoaded(true); }
  }, []);

  async function syncGarage() {
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await Api.jobcount.listGarage();
      setGarage(r.vehicles);
      setSyncMsg(`Synced ${plural(r.count, "vehicle")} from the shop garage.`);
    } catch (e) {
      setSyncMsg((e as Error).message);
    } finally { setSyncing(false); }
  }

  // a switch to or from a simulator re-reads the library at once
  useEffect(() => { void reload(); }, [wb.library, reload]);

  useEffect(() => {
    void reload();
    const iv = window.setInterval(() => void reload(), 8000);
    Api.jobcount.status().then((s) => { setLink(s); if (s.linked) void syncGarage(); }).catch(() => undefined);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  /** Take over a profile saved elsewhere (deep map, add by VIN). */
  const adopt = useCallback((p: VehicleProfile) => {
    sig.current = "";
    setProfiles((list) => (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]));
  }, []);

  const deep = useDeepMap({ host: sd.host, iface: wb.iface, online, onProfile: adopt, onModuleSaved: () => void reload() });

  // ---- the index ----
  const buckets = useMemo(() => buildBuckets(profiles, garage), [profiles, garage]);

  const makes = useMemo(() => {
    const m = new Map<string, { key: string; label: string; models: Set<string>; units: UnitRow[] }>();
    for (const b of buckets) {
      const k = makeKeyOf(b.make);
      const e = m.get(k) ?? { key: k, label: b.make, models: new Set<string>(), units: [] };
      e.models.add(modelKeyOf(b.model));
      e.units.push(...b.units);
      m.set(k, e);
    }
    return [...m.values()]
      .map((v) => ({ key: v.key, label: v.label, sub: `${plural(v.models.size, "model")} · ${carsText(v.units)}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [buckets]);

  /** The selection, with sensible fallbacks: the most recently active model, the newest year. */
  const resolved = useMemo(() => {
    if (!buckets.length) return null;
    const make = sel.make && buckets.some((b) => makeKeyOf(b.make) === sel.make) ? sel.make : null;
    if (!make) {
      const best = [...buckets].sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)))[0];
      return { make: makeKeyOf(best.make), year: yearKeyOf(best.year), model: modelKeyOf(best.model) };
    }
    const ofMake = buckets.filter((b) => makeKeyOf(b.make) === make);
    const year = sel.year && ofMake.some((b) => yearKeyOf(b.year) === sel.year) ? sel.year
      : yearKeyOf([...ofMake].sort((a, b) => (b.year ?? -1) - (a.year ?? -1))[0].year);
    const ofYear = ofMake.filter((b) => yearKeyOf(b.year) === year);
    const model = sel.model && ofYear.some((b) => modelKeyOf(b.model) === sel.model) ? sel.model
      : modelKeyOf([...ofYear].sort((a, b) => a.model.localeCompare(b.model))[0].model);
    return { make, year, model };
  }, [buckets, sel]);

  useEffect(() => {
    if (!resolved) return;
    try { localStorage.setItem(SEL_KEY, JSON.stringify(resolved)); } catch { /* storage unavailable */ }
  }, [resolved]);

  const years = useMemo(() => {
    if (!resolved) return [];
    const m = new Map<string, number | null>();
    for (const b of buckets) if (makeKeyOf(b.make) === resolved.make) m.set(yearKeyOf(b.year), b.year);
    return [...m.entries()].map(([key, year]) => ({ key, year })).sort((a, b) => (b.year ?? -1) - (a.year ?? -1));
  }, [buckets, resolved]);

  const models = useMemo(() => {
    if (!resolved) return [];
    return buckets
      .filter((b) => makeKeyOf(b.make) === resolved.make && yearKeyOf(b.year) === resolved.year)
      .map((b) => ({ key: modelKeyOf(b.model), label: b.model, mapped: !!b.profile }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [buckets, resolved]);

  const bucket: ModelBucket | null = useMemo(
    () => (resolved ? buckets.find((b) => b.key === `${resolved.make}|${resolved.year}|${resolved.model}`) ?? null : null),
    [buckets, resolved],
  );
  const profile = bucket?.profile ?? null;
  const systems = useMemo(() => (profile ? addressedSystems(profile) : []), [profile]);
  const learned = systems.filter((m) => m.explored).length;
  const selectedSystem = systems.find((m) => m.id === systemId) ?? null;

  useEffect(() => { setSystemId(null); }, [bucket?.key]);

  // ---- search ----
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [];
    const terms = q.split(/\s+/);
    const out: { b: ModelBucket; vin?: string }[] = [];
    for (const b of buckets) {
      const vins = b.units.map((u) => u.vin).filter(Boolean);
      const hay = [b.year ?? "", b.make, b.model, b.profile?.trim ?? "", ...vins].join(" ").toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      out.push({ b, vin: vins.find((v) => terms.some((t) => t.length >= 3 && v.toLowerCase().includes(t))) });
    }
    return out.sort((a, b) => a.b.make.localeCompare(b.b.make) || (b.b.year ?? 0) - (a.b.year ?? 0)).slice(0, 12);
  }, [q, buckets]);

  const pick = (b: ModelBucket) => { setSel({ make: makeKeyOf(b.make), year: yearKeyOf(b.year), model: modelKeyOf(b.model) }); setQuery(""); };

  // ---- device / simulator ----
  // "Golden simulator": a recording of this car exists — the desk simulator is playing it
  // now, or one of this model's scans was answered by a replay of it.
  const simHere = !!(profile && wb.sim?.running && simMatches(wb.simCar, profile));
  const playingReplay = simHere && !!wb.sim?.replay?.length;
  const replayScan = bucket ? lastReplay(bucket.units) : null;
  const golden = playingReplay || !!replayScan;
  const goldenTitle = playingReplay
    ? "The desk simulator is playing back a recording of this car right now — it answers only what the real car answered."
    : replayScan ? `A recording of this car exists: the desk simulator played it back for a scan on ${fmtDate(replayScan.at)}. It answers only what the real car answered.` : "";
  const otherRun = deep.running && deep.profileId && deep.profileId !== profile?.id
    ? (() => { const o = profiles.find((x) => x.id === deep.profileId); return o ? ymmLabel(o) : "another vehicle"; })()
    : null;

  const runsOn: RunsOn = useMemo(() => {
    if (!online) {
      return { kind: "off", title: sd.link === "connecting" ? "Connecting…" : "No device connected", sub: "Pick a device from the pill at the top right.", mismatch: null };
    }
    const device = sd.info?.hostname ?? sd.host;
    const virtual = wb.demo || !!wb.sim?.running;
    const mismatch = virtual && profile && wb.simCar && wb.simCar !== "recorded car" && !simMatches(wb.simCar, profile)
      ? `The virtual car answering is ${wb.simCar}, not ${ymmLabel(profile)}. Switch the simulator to this car first — otherwise its answers are saved under the wrong model.`
      : null;
    if (wb.demo) {
      return {
        kind: "demo", title: `Desk simulator${wb.simCar ? ` — ${wb.simCar}` : ""}`,
        sub: wb.sim?.replay?.length ? "Golden simulator on this PC: answers only what the recorded car answered." : "A virtual car on this PC answers instead of a real one.",
        mismatch,
      };
    }
    if (wb.sim?.running) {
      return { kind: "sim", title: `Virtual car on ${device}${wb.simCar ? ` — ${wb.simCar}` : ""}`, sub: "A simulated vehicle on the device answers instead of a car.", mismatch };
    }
    return {
      kind: "real", title: `Real car · ${device}`,
      sub: `Bus ${wb.iface}${wb.gate === "read-only" ? " · device write gate read-only" : ""} · the agent only sends read requests.`,
      mismatch: null,
    };
  }, [online, sd.link, sd.info?.hostname, sd.host, wb.demo, wb.sim, wb.simCar, wb.iface, wb.gate, profile]);

  const mapBlocked = runsOn.kind === "off" ? "Connect a device from the pill at the top right first."
    : otherRun ? `The agent is busy with ${otherRun}.` : null;

  function openInDiag(p: VehicleProfile) {
    try { localStorage.setItem(DIAG_SESSION_KEY, JSON.stringify({ profileId: p.id, vin: "", step: { s: "vehicle", tab: "scan" } })); }
    catch { /* storage unavailable — Auto Diagnostic opens on its home screen */ }
    nav("/diag");
  }

  const totalUnits = buckets.reduce((n, b) => n + b.units.length, 0);
  const title = bucket ? [bucket.year, bucket.model].filter((x) => x != null && x !== "").join(" ") : "";
  const subline = bucket ? [bucket.make, profile?.trim, profile?.decoded?.bodyClass ?? profile?.bodyType, profile?.decoded?.driveType].filter(Boolean).join(" · ") : "";
  const extra = profile ? unaddressedNote(profile, systems.length) : null;

  return (
    <div className="ual-page vdb">
      <h1 className="vdb-sr">Vehicles Database</h1>

      {/* search + add by VIN */}
      <div className="vdb-search">
        <label className="vdb-searchbox">
          <VIcon name="search" size={20} />
          <span className="vdb-sr">Search the database</span>
          <input type="search" placeholder="Search make, model, year or VIN" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) pick(matches[0].b); if (e.key === "Escape") setQuery(""); }} />
        </label>
        <button type="button" className="vdb-addbtn" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
          <VIcon name="plus" size={16} />Add vehicle by VIN
        </button>
        <span className="ual-muted vdb-count">{plural(profiles.length, "model")} mapped · {plural(totalUnits, "car")} on file</span>
        <div className="vdb-viewswitch" role="tablist" aria-label="What to show">
          <button type="button" role="tab" aria-selected={view === "cars"} className={view === "cars" ? "on" : ""} onClick={() => setView("cars")}>Cars on file</button>
          <button type="button" role="tab" aria-selected={view === "models"} className={view === "models" ? "on" : ""} onClick={() => setView("models")}>Models we know</button>
        </div>
      </div>

      {view === "models" && <ModelCatalog onOpenCar={(mk, md) => { setView("cars"); setQuery(`${mk} ${md}`.trim()); }} />}

      {view === "cars" && q && (
        <section className="ual-card vdb-results" aria-label="Search results">
          {matches.length === 0 ? <p className="ual-muted">Nothing on file matches “{query.trim()}”.</p> : matches.map(({ b, vin }) => (
            <button key={b.key} type="button" className="vdb-result" onClick={() => pick(b)}>
              <b>{ymmLabel(b)}</b>
              <span className="ual-muted">{b.profile ? `${plural(addressedSystems(b.profile).length, "system")} · ` : "not mapped yet · "}{plural(b.units.length, "car")}</span>
              {vin && <span className="ual-chip ual-mono">{vin}</span>}
            </button>
          ))}
        </section>
      )}

      {adding && (
        <AddVehicleByVin profiles={profiles} onClose={() => setAdding(false)}
          onAdded={(list, stored, message) => {
            sig.current = libSig(list); setProfiles(list); setAdding(false); setNote(message);
            setSel({ make: makeKeyOf(stored.make), year: yearKeyOf(stored.year), model: modelKeyOf(stored.model) });
          }} />
      )}

      {err && <div className="ual-note err" role="alert">The vehicle library could not be read: {err}</div>}
      {note && (
        <div className="ual-note ok vdb-notebar" role="status">
          <span>{note}</span>
          <button type="button" className="ghost tiny" onClick={() => setNote(null)}>Dismiss</button>
        </div>
      )}

      {view === "cars" && loaded && !buckets.length && (
        <section className="ual-card pad vdb-empty">
          <h2 className="ual-h2">No vehicles yet</h2>
          <p className="ual-sub">
            Add one by VIN, read a car in Auto Diagnostic, or {link?.linked ? "sync the shop garage" : "link a shop garage in Settings"} to fold its cars in.
          </p>
          <div className="vdb-empty-actions">
            <button type="button" className="primary" onClick={() => setAdding(true)}><VIcon name="plus" />Add vehicle by VIN</button>
            <button type="button" onClick={() => nav("/diag")}>Open Auto Diagnostic</button>
            {link?.linked
              ? <button type="button" onClick={() => void syncGarage()} disabled={syncing}><VIcon name="sync" />{syncing ? "Syncing…" : "Sync garage"}</button>
              : <button type="button" className="ghost" onClick={() => nav("/settings")}>Link a shop in Settings</button>}
          </div>
          {syncMsg && <p className="ual-muted">{syncMsg}</p>}
        </section>
      )}

      {/* make cards + year / model chips */}
      {view === "cars" && buckets.length > 0 && resolved && (
        <div className="vdb-makes">
          <div className="vdb-makelist" role="group" aria-label="Make">
            {makes.map((mk) => (
              <button key={mk.key} type="button" className="vdb-make" aria-pressed={resolved.make === mk.key}
                onClick={() => setSel({ make: mk.key, year: null, model: null })}>
                <span className="vdb-mono" aria-hidden="true">{monogram(mk.label)}</span>
                <span className="vdb-make-text"><b>{mk.label}</b><span>{mk.sub}</span></span>
              </button>
            ))}
          </div>
          <div className="vdb-picker">
            <div className="vdb-picker-group" role="group" aria-labelledby="vdb-year-label">
              <span className="vdb-picker-label" id="vdb-year-label">Year</span>
              {years.map((y) => (
                <button key={y.key} type="button" className="vdb-pill" aria-pressed={resolved.year === y.key}
                  onClick={() => setSel({ make: resolved.make, year: y.key, model: null })}>{yearLabel(y.year)}</button>
              ))}
            </div>
            <div className="vdb-picker-group" role="group" aria-labelledby="vdb-model-label">
              <span className="vdb-picker-label" id="vdb-model-label">Model</span>
              {models.map((m) => (
                <button key={m.key} type="button" className="vdb-pill" aria-pressed={resolved.model === m.key}
                  onClick={() => setSel({ make: resolved.make, year: resolved.year, model: m.key })}>
                  {m.label}{!m.mapped && <span className="vdb-pill-sub"> · not mapped</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {bucket && (
        <div className="ual-cols">
          <div className="ual-grow">
            <section className="ual-card pad vdb-model" aria-labelledby="vdb-model-title">
              <div className="vdb-head">
                <h2 id="vdb-model-title" className="ual-h1">{title}</h2>
                {golden && <span className="ual-chip info strong vdb-tagcaps" title={goldenTitle}>Golden simulator{playingReplay ? " · playing" : ""}</span>}
                {simHere && !golden && <span className="ual-chip info strong vdb-tagcaps" title="A virtual vehicle of this model is answering right now.">Virtual car playing</span>}
                {!profile && <span className="ual-chip warn strong vdb-tagcaps">Not mapped yet</span>}
                {profile && (
                  <span className="vdb-head-links">
                    <button type="button" className="ghost" onClick={() => openInDiag(profile)}>Open in Auto Diagnostic<VIcon name="arrow" size={15} /></button>
                    <button type="button" className="ghost" onClick={() => nav("/cockpit")}>3D cockpit</button>
                  </span>
                )}
              </div>
              {subline && <p className="ual-sub vdb-subline">{subline}</p>}

              {profile ? (
                <>
                  <div className="vdb-specs">
                    <SpecBox label="Engine" spec={engineSpec(profile)} fallback="not decoded yet" />
                    <SpecBox label="Gearbox" spec={gearboxSpec(profile)} fallback="not known yet" />
                    <SpecBox label="Bus" spec={busSpec(profile)} fallback="none on file" />
                    <SpecBox label="Cars seen" spec={carsSeenSpec(bucket)} fallback="" />
                  </div>

                  <KnowledgeCard profile={profile} />

                  <div className="vdb-maphead">
                    <h3 className="vdb-h3">Vehicle map · {learned} of {plural(systems.length, "system")} learned deeply</h3>
                    <span className="vdb-legend"><i aria-hidden="true" />learned</span>
                    <span className="vdb-legend"><i className="off" aria-hidden="true" />not yet</span>
                  </div>
                  {systems.length > 0 ? (
                    <VehicleMapTiles systems={systems} selectedId={selectedSystem?.id ?? null}
                      activeId={deep.running && deep.profileId === profile.id ? deep.activeId : null} onSelect={setSystemId} />
                  ) : (
                    <p className="ual-muted">
                      No systems with a diagnostic address yet. Run Auto Scan on this model in Auto Diagnostic — it searches every
                      diagnostic address and files what answers here.
                    </p>
                  )}
                  {extra && <p className="ual-muted vdb-small">{extra}</p>}
                  {selectedSystem && (
                    <SystemDetail profile={profile} m={selectedSystem} deep={deep} blocked={mapBlocked} onClose={() => setSystemId(null)} />
                  )}
                </>
              ) : (
                <>
                  <div className="vdb-specs">
                    <SpecBox label="Cars seen" spec={carsSeenSpec(bucket)} fallback="" />
                  </div>
                  <div className="ual-note">
                    This vehicle is in the shop garage but not mapped here yet. Read it in Auto Diagnostic: Auto Scan files its systems
                    under this model, and the cars below carry over.
                    <div className="vdb-note-actions"><button type="button" className="tiny" onClick={() => nav("/diag")}>Open Auto Diagnostic</button></div>
                  </div>
                </>
              )}
            </section>

            <CarsOnFile bucket={bucket} link={link} syncing={syncing} syncMsg={syncMsg} onSync={() => void syncGarage()} onSettings={() => nav("/settings")} />
            {profile && <ModulesCard profile={profile} />}
            {profile && <AboutCard profile={profile} />}
          </div>

          <aside className="ual-aside right" aria-label="AI agent and what has been learned">
            <AgentPanel key={bucket.key} profile={profile} systems={systems} deep={deep} runsOn={runsOn} otherRun={otherRun} />
            {profile && <LearnedList systems={systems} />}
          </aside>
        </div>
      )}
    </div>
  );
}
