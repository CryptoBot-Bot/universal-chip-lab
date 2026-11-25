import { Fragment } from "react";

import { CAPABILITY_CATALOG, readMethodFor } from "@ecu/vehicle-db";
import type { VehicleModule, VehicleProfile } from "@ecu/vehicle-db";

import { CATEGORY_LABEL } from "../../lib/diag";
import { Completeness } from "./Completeness";
import { Labels } from "./Labels";
import { VIcon } from "./icons";
import type { DeepMap } from "./useDeepMap";
import { TAG_TEXT, fmtDate, knowledgeOf, plural, splitLabel } from "./vehicleFacts";

/**
 * The vehicle map: one tile per system with a diagnostic address — short name, name,
 * what we hold about it (mapped / part no. only / protected) and three knowledge bars
 * (identity / live data / fault codes). Picking a tile opens what was learned about it.
 */

const READ_CHIP: Record<string, { cls: string; text: string }> = {
  obd: { cls: "clean", text: "OBD" }, obd_partial: { cls: "warn", text: "OBD partial" }, bench: { cls: "fault", text: "Bench only" },
};
const CAP_CHIP: Record<string, { cls: string; text: string }> = {
  supported: { cls: "clean", text: "yes" }, gated: { cls: "warn", text: "gated" }, unsupported: { cls: "unread", text: "no" }, unknown: { cls: "unread", text: "?" },
};

export function memoryChip(m: VehicleModule) {
  return READ_CHIP[m.memoryRead ?? readMethodFor(m.id)] ?? READ_CHIP.obd_partial;
}

function Bars({ k }: { k: ReturnType<typeof knowledgeOf> }) {
  const bar = (on: boolean, label: string) => (
    <span>
      <i className={on ? "on" : ""} />
      {label}<span className="vdb-sr">{on ? " learned" : " not learned yet"}</span>
    </span>
  );
  return <span className="ual-bars">{bar(k.identity, "identity")}{bar(k.live, "live")}{bar(k.codes, "codes")}</span>;
}

export function VehicleMapTiles({ systems, selectedId, activeId, onSelect }: {
  systems: VehicleModule[]; selectedId: string | null; activeId: string | null; onSelect: (id: string | null) => void;
}) {
  return (
    <div className="vdb-tiles">
      {systems.map((m) => {
        const k = knowledgeOf(m);
        const { short, name } = splitLabel(m.label);
        const sel = selectedId === m.id;
        return (
          <button key={m.id} type="button" className={`vdb-tile ${sel ? "selected" : ""} ${activeId === m.id ? "active" : ""}`}
            aria-pressed={sel} onClick={() => onSelect(sel ? null : m.id)} title={k.guard ? `${m.label} — ${k.guard.reason}` : m.label}>
            <span className="vdb-tile-top">
              <span className="vdb-tile-short">{short}</span>
              <span className={`vdb-tag ${k.tag}`}>
                {k.tag === "protected" && <VIcon name="shield" size={12} />}
                {activeId === m.id ? "learning…" : TAG_TEXT[k.tag]}
              </span>
            </span>
            <span className="vdb-tile-name">{name}</span>
            <Bars k={k} />
            <span className="vdb-tile-addr">{m.addressing?.request ?? "?"} → {m.addressing?.response ?? "?"}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Everything the library learned about one system, read-only. */
export function SystemDetail({ profile, m, deep, blocked, onClose }: {
  profile: VehicleProfile; m: VehicleModule; deep: DeepMap; blocked: string | null; onClose: () => void;
}) {
  const k = knowledgeOf(m);
  const x = m.explored;
  const { short } = splitLabel(m.label);
  const mem = memoryChip(m);
  const ops = new Map((x?.operations ?? []).map((o) => [o.op, o]));
  const ident: [string, string | undefined][] = [
    ["Part number", m.identity?.partNo], ["Supplier", m.identity?.supplier], ["Software", m.identity?.sw],
    ["Hardware", m.identity?.hw], ["Serial", m.identity?.serial],
  ];
  const heldIdent = ident.filter(([, v]) => !!v);
  const running = deep.running && deep.profileId === profile.id;

  return (
    <section className="vdb-sys" aria-label={`${short} — what is known`}>
      <div className="vdb-sys-head">
        <h3 className="ual-h2">{short}</h3>
        <span className="vdb-sys-label">{m.label}</span>
        <button type="button" className="ghost tiny vdb-sys-close" onClick={onClose} aria-label="Close this system">
          <VIcon name="close" size={14} />Close
        </button>
      </div>
      <div className="vdb-chiprow">
        {k.guard
          ? <span className="ual-chip protected" title={k.guard.reason}><VIcon name="shield" size={12} />protected · {k.guard.kind === "restraint" ? "airbag / restraint" : "immobiliser"}</span>
          : <span className={`ual-chip ${k.tag === "mapped" ? "info" : "unread"}`}>{TAG_TEXT[k.tag]}</span>}
        {x && <span className="ual-chip">{x.confidence} confidence · mapped {x.runCount}×{x.lastMappedAt ? ` · ${fmtDate(x.lastMappedAt)}` : ""}</span>}
        <span className="ual-chip ual-mono">{m.addressing?.request ?? "?"} → {m.addressing?.response ?? "?"}</span>
        <span className="ual-chip">{CATEGORY_LABEL[m.category] ?? m.category}</span>
        {m.protocol && m.protocol !== "unknown" && <span className="ual-chip">{m.protocol === "kwp2000" ? "KWP2000" : m.protocol.toUpperCase()}</span>}
        <span className={`ual-chip ${mem.cls}`} title="How its memory can be read (estimate until bench-verified)">memory: {mem.text}</span>
      </div>

      {(m.summary || x?.summary) && <p className="vdb-sys-summary">{m.summary || x?.summary}</p>}

      {heldIdent.length > 0 && (
        <dl className="ual-dl">
          {heldIdent.map(([label, v]) => <Fragment key={label}><dt>{label}</dt><dd className={label === "Supplier" ? undefined : "ual-mono"}>{v}</dd></Fragment>)}
          {m.identity?.observedAt && <><dt>Read off the bus</dt><dd>{fmtDate(m.identity.observedAt)}</dd></>}
          {m.lastSeenAt && <><dt>Last answered</dt><dd>{fmtDate(m.lastSeenAt)}</dd></>}
        </dl>
      )}

      {!k.guard && <Completeness profile={profile} m={m} />}
      {!k.guard && <Labels profile={profile} m={m} />}

      {x ? (
        <div className="vdb-learned-cols">
          <details className="vdb-list" open={k.counts.ident > 0 && k.counts.ident <= 8}>
            <summary>Identity <span className="ual-muted">· {k.counts.ident}</span></summary>
            {k.counts.ident ? <ul>{x.identification!.map((i) => <li key={i.id}><span className="ual-mono">{i.id}</span> {i.label}: <b>{i.value}</b></li>)}</ul>
              : <p className="ual-muted">No identification records yet.</p>}
          </details>
          <details className="vdb-list" open={k.counts.live > 0 && k.counts.live <= 8}>
            <summary>Live data <span className="ual-muted">· {k.counts.live}</span></summary>
            {k.counts.live ? <ul>{x.liveData!.map((l, i) => <li key={`${l.id}-${i}`}><span className="ual-mono">{l.id}</span> {l.label}</li>)}</ul>
              : <p className="ual-muted">No live values learned yet.</p>}
          </details>
          <details className="vdb-list" open={k.counts.codes > 0 && k.counts.codes <= 8}>
            <summary>Fault codes <span className="ual-muted">· {k.counts.codes}</span></summary>
            {k.counts.codes ? <ul>{x.dtcs!.map((d) => <li key={d.code}><span className="ual-mono">{d.code}</span> {d.desc}</li>)}</ul>
              : <p className="ual-muted">No fault codes learned yet.</p>}
          </details>
        </div>
      ) : (
        <p className="ual-muted vdb-sys-empty">
          {m.identity?.partNo ? "Only its part number is on file — nothing has been learned about it yet." : "Only its diagnostic address is on file."}
        </p>
      )}

      {ops.size > 0 && (
        <div className="vdb-caps" aria-label="What the agent found this system supports">
          <span className="vdb-caps-title">What it supports</span>
          {CAPABILITY_CATALOG.filter((c) => !c.write).map((c) => {
            const s = CAP_CHIP[ops.get(c.id)?.status ?? "unknown"];
            return <span key={c.id} className="vdb-cap" title={ops.get(c.id)?.detail || c.blurb}><span className={`ual-chip ${s.cls}`}>{s.text}</span>{c.label}</span>;
          })}
          <span className="vdb-caps-note ual-muted">
            Changes (clear codes, coding, routines…) are noted by the agent but never used here — real cars are read-only.
          </span>
        </div>
      )}

      {k.guard ? (
        <div className="ual-note warn">
          <b>Protected.</b> The AI agent never explores this system automatically, and nothing here writes to it.
          Reading its fault codes in Auto Diagnostic stays allowed.
        </div>
      ) : (
        <div className="vdb-sys-actions">
          <button type="button" className="primary" disabled={!!blocked || deep.running} onClick={() => void deep.start(profile, [m])}>
            {running && deep.activeId === m.id ? "Learning…" : x ? "Map again to go deeper" : "Map this system"}
          </button>
          <span className="ual-muted">
            {blocked ?? (deep.running ? "The agent is busy — wait for the current run or stop it." : "Read-only · about 3–5 minutes and one AI session.")}
          </span>
        </div>
      )}
    </section>
  );
}

/** Systems known only by name, with no diagnostic address yet. */
export function unaddressedNote(profile: VehicleProfile, addressed: number): string | null {
  const n = profile.modules.length - addressed;
  return n > 0 ? `${plural(n, "more system")} on file without a diagnostic address yet — listed under Modules below. Auto Scan finds their addresses.` : null;
}
