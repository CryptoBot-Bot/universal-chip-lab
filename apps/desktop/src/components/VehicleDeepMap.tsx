import { useMemo, useRef, useState } from "react";

import { CAPABILITY_CATALOG, applyCensus, censusInputFor, type VehicleProfile, type VehicleModule, type ModuleCapability } from "@ecu/vehicle-db";

import {
  Api,
  type DiscoveredModule,
  type VehicleExplorerEvent,
  type VehicleExplorerTarget,
} from "../lib/api";
import { LiveModuleOps } from "./LiveModuleOps";

/**
 * Vehicle Deep Map — staged and incremental.
 *
 *   Stage 1 · Discover: probe the bus, SAVE the responders (address + lastSeen)
 *             into the YMM profile. Next time this vehicle loads, the module map
 *             is already here — re-discover to add/refresh, and each per-module
 *             map seeds the AI with everything we already know (self-improving).
 *   Stage 2 · Map (one module at a time, or all): the AI verifies each module
 *             live and its capability board is folded permanently into the
 *             profile — saved after every module.
 */

type Busy = null | "discover" | "census" | "all" | string; // string = a module id being mapped

const CAP_STATUS_TONE: Record<string, string> = { supported: "ok", gated: "warn", unsupported: "", unknown: "" };
const CAP_STATUS_LABEL: Record<string, string> = { supported: "yes", gated: "gated", unsupported: "no", unknown: "?" };

function boardFor(ops: ModuleCapability[] | undefined) {
  const by = new Map((ops ?? []).map((o) => [o.op, o]));
  return CAPABILITY_CATALOG.map((spec) => ({ spec, cap: by.get(spec.id) }));
}
function capCounts(ops: ModuleCapability[] | undefined) {
  const s = { supported: 0, gated: 0 };
  for (const o of ops ?? []) { if (o.status === "supported") s.supported++; else if (o.status === "gated") s.gated++; }
  return s;
}
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : "");

export function VehicleDeepMap({ host, iface, profile, onProfileUpdate }: {
  host: string; iface: string; profile: VehicleProfile; onProfileUpdate: (p: VehicleProfile) => void;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [discoverProg, setDiscoverProg] = useState<{ done: number; total: number; found: number } | null>(null);
  const [newThisScan, setNewThisScan] = useState<Set<string>>(new Set());
  const [doneThisRun, setDoneThisRun] = useState<Set<string>>(new Set());
  const [feeds, setFeeds] = useState<Record<string, string[]>>({});
  const [activeModule, setActiveModule] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [operating, setOperating] = useState<string | null>(null); // module id with the live READ/WRITE panel open
  const feedEndRef = useRef<HTMLDivElement>(null);

  /** A live operation touched a module (opsLog) — persist it on the profile. */
  async function updateModule(m: VehicleModule) {
    const next = { ...profile, modules: profile.modules.map((x) => (x.id === m.id ? m : x)) };
    onProfileUpdate(next);
    try { await Api.vehicleLib.save(next); } catch (e) { setErr((e as Error).message); }
  }

  // The module map is now the source of truth on the profile itself: every
  // module we've discovered has an address. Show them sorted by address.
  const modules = useMemo(
    () => profile.modules
      .filter((m) => m.addressing?.response)
      .slice()
      .sort((a, b) => (a.addressing!.response! > b.addressing!.response! ? 1 : -1)),
    [profile.modules],
  );
  const mappedCount = modules.filter((m) => m.explored).length;

  const norm = (s?: string) => (s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");

  function pushFeed(moduleId: string, line: string) {
    setFeeds((f) => ({ ...f, [moduleId]: [...(f[moduleId] ?? []).slice(-80), line] }));
    requestAnimationFrame(() => feedEndRef.current?.scrollIntoView({ block: "nearest" }));
  }

  async function discover() {
    setBusy("discover"); setErr(null); setDiscoverProg({ done: 0, total: 0, found: 0 });
    const before = new Set(modules.map((m) => norm(m.addressing?.response)));
    const off = Api.vehicleExplorer.onEvent((e: VehicleExplorerEvent) => {
      if (e.type === "discover") setDiscoverProg({ done: e.done, total: e.total, found: e.found });
    });
    try {
      const found: DiscoveredModule[] = await Api.vehicleExplorer.discover({ host, iface, ident: true });
      // Save discovery as its own stage — persists modules + addresses + read identities.
      let updated = await Api.vehicleExplorer.commitDiscovery({ profile, discovered: found });
      onProfileUpdate(updated);
      setNewThisScan(new Set(found.map((d) => norm(d.responseId)).filter((r) => !before.has(r))));
      off(); setDiscoverProg(null);
      // Census: the AI names every responder from its part number → the vehicle's
      // known-module list with basic parameters, saved before any deep-map.
      if (found.length) {
        setBusy("census");
        try {
          // censusInputFor / applyCensus are shared with the command-line runner
          // (@ecu/vehicle-db), so both name and merge modules the same way.
          const census = await Api.vehicleExplorer.census(censusInputFor(updated, found));
          updated = applyCensus(updated, census.modules, new Date().toISOString());
          const list = await Api.vehicleLib.save(updated);
          onProfileUpdate(list.find((p) => p.id === updated.id) ?? updated);
        } catch (e) { setErr(`Census failed — ${(e as Error).message} (modules are saved; you can still map them).`); }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally { off(); setBusy(null); setDiscoverProg(null); }
  }

  function targetFor(m: VehicleModule): VehicleExplorerTarget {
    const proto = profile.buses.find((b) => b.id === m.bus)?.protocol === "K-Line" ? "kwp2000" : "uds";
    return {
      moduleId: m.id, displayName: m.label, brand: profile.make, category: m.category,
      protocol: proto, requestId: m.addressing?.request ?? "", responseId: m.addressing?.response ?? "",
    };
  }

  async function runMap(targets: VehicleExplorerTarget[], label: Busy) {
    if (!targets.length) return;
    setBusy(label); setErr(null); setDoneThisRun(new Set());
    const off = Api.vehicleExplorer.onEvent((e: VehicleExplorerEvent) => {
      if (e.type === "module-start") { setActiveModule(e.moduleId); setExpanded(e.moduleId); pushFeed(e.moduleId, `▶ mapping ${e.displayName}…`); }
      else if (e.type === "module-event") {
        const ev = e.event;
        if (ev.type === "thought" && ev.text) pushFeed(e.moduleId, `· ${ev.text.slice(0, 150)}`);
        else if (ev.type === "action") pushFeed(e.moduleId, `→ ${ev.tool}${ev.tool === "probe" && (ev.input as { purpose?: string })?.purpose ? `: ${(ev.input as { purpose?: string }).purpose}` : ""}`);
        else if (ev.type === "observation") pushFeed(e.moduleId, `  ${ev.summary}`);
        else if (ev.type === "finding") pushFeed(e.moduleId, `✓ ${ev.kind}: ${ev.title}`);
      } else if (e.type === "module-done") {
        setDoneThisRun((s) => new Set(s).add(e.moduleId));
        const c = (e.result.operations ?? []).filter((o) => o.status === "supported").length;
        pushFeed(e.moduleId, `■ done — ${c} capability(ies) confirmed, saved.`);
      } else if (e.type === "error") { setErr(e.text); }
    });
    try {
      const updated = await Api.vehicleExplorer.start({ host, iface, profile, targets });
      onProfileUpdate(updated);
    } catch (e) {
      setErr((e as Error).message);
    } finally { off(); setBusy(null); setActiveModule(null); }
  }

  const mapModule = (m: VehicleModule) => runMap([targetFor(m)], m.id);
  const mapAll = () => runMap(modules.map(targetFor), "all");
  const stop = () => Api.vehicleExplorer.stop().catch(() => undefined);

  const anyBusy = busy !== null;

  return (
    <div className="card vdm">
      <style>{styles}</style>
      <div className="row spread">
        <div>
          <h3 style={{ margin: 0 }}>🧠 Deep-map this vehicle</h3>
          <p className="tiny dim" style={{ margin: "4px 0 0" }}>
            {modules.length > 0
              ? <>{modules.length} module{modules.length === 1 ? "" : "s"} known · {mappedCount} deep-mapped. Saved to <b>{profile.year} {profile.make} {profile.model}</b> — re-discover to refresh the census, then map each module one by one.</>
              : <>Discover every module on the bus (reads each one's part number) and let the AI census name them — saved to <b>{profile.year} {profile.make} {profile.model}</b>. Then map each one live.</>}
          </p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => void discover()} disabled={anyBusy}>
            {busy === "discover" ? "Discovering…" : busy === "census" ? "AI census…" : modules.length ? "↻ Re-discover & census" : "① Discover & census modules"}
          </button>
          {modules.length > 0 && <button onClick={() => void mapAll()} disabled={anyBusy}>Map all {modules.length} →</button>}
          {anyBusy && busy !== "discover" && <button onClick={() => void stop()}>Stop</button>}
        </div>
      </div>

      {err && <div className="vdm-err tiny">{err}</div>}
      {discoverProg && <div className="vdm-prog tiny">Probing addresses… {discoverProg.done}/{discoverProg.total} · found {discoverProg.found}</div>}

      {modules.length === 0 && !anyBusy && (
        <p className="tiny dim" style={{ marginTop: 10 }}>No modules discovered yet. Bring the bus up and hit Discover.</p>
      )}

      <div className="vdm-mods">
        {modules.map((m) => {
          const counts = capCounts(m.explored?.operations);
          const active = activeModule === m.id;
          const done = doneThisRun.has(m.id);
          const isNew = newThisScan.has(norm(m.addressing?.response));
          const open = expanded === m.id;
          const feed = feeds[m.id] ?? [];
          return (
            <div key={m.id} className={`vdm-mod ${active ? "active" : ""}`}>
              <div className="row spread vdm-mod-head" onClick={() => setExpanded(open ? null : m.id)}>
                <span className="tiny vdm-mod-name">
                  <b className="mono">{m.addressing?.response}</b> · {m.label}
                  {isNew && <span className="badge ok" style={{ marginLeft: 6 }}>new</span>}
                  {active && <span className="badge warn" style={{ marginLeft: 6 }}>mapping…</span>}
                  {done && !active && <span className="badge ok" style={{ marginLeft: 6 }}>✓ saved</span>}
                </span>
                <span className="row" style={{ gap: 10 }}>
                  <span className="tiny dim">
                    {m.explored
                      ? <>{counts.supported} can-do{counts.gated ? ` · ${counts.gated} gated` : ""} · run {m.explored.runCount}×</>
                      : m.lastSeenAt ? `answers here · seen ${fmtDate(m.lastSeenAt)}` : "not mapped"}
                  </span>
                  <button className={`tiny ${operating === m.id ? "primary" : ""}`} disabled={anyBusy} title="Read / write this module live on the bus" onClick={(ev) => { ev.stopPropagation(); setOperating(operating === m.id ? null : m.id); setExpanded(m.id); }}>
                    {operating === m.id ? "■ Close ops" : "⚡ Operate"}
                  </button>
                  <button className="tiny primary" disabled={anyBusy} onClick={(ev) => { ev.stopPropagation(); void mapModule(m); }}>
                    {m.explored ? "Re-map" : "Map"}
                  </button>
                </span>
              </div>

              {(m.summary || m.identity?.partNo) && (
                <div className="tiny dim vdm-census">
                  {m.identity?.partNo && <span className="mono">{m.identity.partNo}</span>}{m.identity?.supplier ? ` · ${m.identity.supplier}` : ""}{m.identity?.sw ? ` · sw ${m.identity.sw}` : ""}
                  {m.summary && <> — {m.summary}</>}
                  {m.protocol && m.protocol !== "unknown" && <span className="badge" style={{ marginLeft: 6 }}>{m.protocol}</span>}
                  {m.memoryRead && <span className={`badge ${m.memoryRead === "obd" ? "ok" : m.memoryRead === "obd_partial" ? "warn" : "danger"}`} style={{ marginLeft: 4 }} title="memory read estimate">{m.memoryRead}</span>}
                </div>
              )}
              {(open || active) && (
                <div className="vdm-mod-body">
                  {feed.length > 0 && (
                    <div className="vdm-feed">
                      {feed.map((l, i) => <div key={i} className={l.startsWith("·") ? "vdm-thought" : ""}>{l}</div>)}
                      {active && <div ref={feedEndRef} />}
                    </div>
                  )}
                  {m.explored ? <CapBoard explored={m.explored} /> : (
                    !active && <p className="tiny dim">Not mapped yet — press Map to have the AI verify what this module can do, live on the bus. You can still Operate it with the standard reads.</p>
                  )}
                  {operating === m.id && (
                    <LiveModuleOps host={host} iface={iface} profile={profile} module={m} onModuleUpdate={(nm) => void updateModule(nm)} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CapBoard({ explored }: { explored: NonNullable<VehicleProfile["modules"][number]["explored"]> }) {
  return (
    <div className="vdm-board">
      {explored.identity && <div className="tiny"><span className="dim">Identity:</span> {explored.identity}</div>}
      <div className="vdm-caps">
        {boardFor(explored.operations).map(({ spec, cap }) => {
          const status = cap?.status ?? "unknown";
          return (
            <span key={spec.id} className={`vdm-cap ${status}`} title={cap?.detail || spec.blurb}>
              <span className={`badge ${CAP_STATUS_TONE[status]}`}>{CAP_STATUS_LABEL[status]}</span> {spec.label}
              {cap?.request && <span className="dim mono"> {cap.request}</span>}
            </span>
          );
        })}
      </div>
      {((explored.liveData?.length ?? 0) > 0 || (explored.identification?.length ?? 0) > 0 || (explored.dtcs?.length ?? 0) > 0) && (
        <div className="tiny dim">{explored.liveData?.length ?? 0} live-data block(s) · {explored.identification?.length ?? 0} ID record(s) · {explored.dtcs?.length ?? 0} DTC(s)</div>
      )}
    </div>
  );
}

const styles = `
.vdm { margin-top: 12px; }
.vdm-err { color: var(--danger); background: var(--danger-dim); border: 1px solid var(--danger); border-radius: 8px; padding: 6px 10px; margin-top: 8px; }
.vdm-prog { margin-top: 8px; color: var(--fg-2); }
.vdm-mods { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; }
.vdm-mod { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.vdm-mod.active { border-color: var(--warn); }
.vdm-mod-head { cursor: pointer; align-items: center; }
.vdm-mod-name { overflow: hidden; text-overflow: ellipsis; }
.vdm-mod-body { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.vdm-census { margin-top: 4px; line-height: 1.5; }
.vdm-board { display: flex; flex-direction: column; gap: 6px; }
.vdm-caps { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 4px; }
.vdm-cap { font-size: 11px; padding: 2px 4px; border-radius: 5px; }
.vdm-cap.unsupported, .vdm-cap.unknown { opacity: 0.5; }
.vdm-feed { max-height: 200px; overflow-y: auto; background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-family: var(--mono, monospace); font-size: 11px; line-height: 1.5; margin-bottom: 8px; }
.vdm-feed .vdm-thought { color: var(--fg-2); }
`;
