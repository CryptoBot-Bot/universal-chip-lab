import { useState } from "react";

import type { VehicleModule, VehicleProfile } from "@ecu/vehicle-db";

import { ymmLabel } from "../../lib/diag";
import { VIcon } from "./icons";
import type { DeepMap } from "./useDeepMap";
import { fmtDate, guardOf, knowledgeOf, plural, splitLabel } from "./vehicleFacts";

/** Where the agent would run right now — always the device picked in the header pill. */
export interface RunsOn {
  kind: "off" | "demo" | "sim" | "real";
  title: string;
  sub: string;
  /** Set when the virtual car that answers is known not to be this model. */
  mismatch: string | null;
}

const short = (m: VehicleModule) => splitLabel(m.label).short;

function listNames(ms: VehicleModule[], max = 8): string {
  const names = ms.slice(0, max).map(short);
  return ms.length > max ? `${names.join(", ")} and ${ms.length - max} more` : names.join(", ");
}

/** The systems the agent would take next: not protected, not learned, part numbers first. */
export function nextUp(systems: VehicleModule[]): VehicleModule[] {
  return systems
    .filter((m) => !guardOf(m) && !m.explored)
    .sort((a, b) => Number(!!b.identity?.partNo) - Number(!!a.identity?.partNo));
}

export function AgentPanel({ profile, systems, deep, runsOn, otherRun }: {
  profile: VehicleProfile | null;
  systems: VehicleModule[];
  deep: DeepMap;
  runsOn: RunsOn;
  /** Name of another vehicle the agent is busy with, if any. */
  otherRun: string | null;
}) {
  const [ask, setAsk] = useState(false);
  const todo = nextUp(systems);
  const prot = systems.filter((m) => guardOf(m));
  const mine = !!profile && deep.profileId === profile.id;
  const running = deep.running && mine;
  const withPart = todo.filter((m) => m.identity?.partNo).length;

  const reason = !profile ? "This model has no system map yet. Run Auto Scan on it in Auto Diagnostic first — that files its systems here."
    : runsOn.kind === "off" ? "Connect a device from the pill at the top right — the agent reads the car through it."
    : otherRun ? `The agent is busy with ${otherRun}.`
    : !systems.length ? "No systems with a diagnostic address yet — Auto Scan in Auto Diagnostic finds them."
    : !todo.length ? "Every system that may be mapped has been learned. Pick a system in the map to map it again and go deeper."
    : null;

  return (
    <section className="ual-card dark pad vdb-agent" aria-labelledby="vdb-agent-title">
      <span className="ual-eyebrow vdb-eyebrow"><VIcon name="spark" />AI agent</span>
      <h2 id="vdb-agent-title" className="ual-h2 vdb-agent-title">Dig deeper</h2>
      <p>
        {!profile ? "Nothing to dig into yet."
          : todo.length ? <>Next up: <b>{listNames(todo)}</b> — {plural(todo.length, "system")} {withPart === todo.length ? "with a part number but nothing learned yet" : "not learned yet"}.</>
          : systems.length ? "Every system that may be mapped has been learned at least once."
          : "No systems are on file for this model yet."}
      </p>
      {prot.length > 0 && <p className="vdb-agent-small">Left out: {listNames(prot)} — protected (airbag / immobiliser). Never mapped automatically.</p>}

      <div className="vdb-runs-on" aria-label="Where the agent runs">
        <span className="lbl">Runs on</span>
        <b>{runsOn.title}</b>
        <small>{runsOn.sub}</small>
      </div>
      {runsOn.mismatch && <div className="vdb-dnote warn">{runsOn.mismatch}</div>}

      {running ? (
        <div className="vdb-agent-run" aria-live="polite">
          <span>{deep.phase || "Working…"}</span>
          {deep.prog && <div className="ual-progress" role="progressbar" aria-valuemin={0} aria-valuemax={deep.prog.total} aria-valuenow={deep.prog.done}
            aria-label="Systems learned in this run"><i style={{ width: `${deep.prog.total ? Math.round((deep.prog.done / deep.prog.total) * 100) : 0}%` }} /></div>}
          {deep.feed.length > 0 && <div className="vdb-feed">{deep.feed.slice(-7).map((l, i) => <div key={i}>{l}</div>)}</div>}
          <button type="button" onClick={() => deep.stop()}>Stop</button>
        </div>
      ) : otherRun ? (
        <div className="vdb-agent-run">
          <span>Busy mapping {otherRun}{deep.phase ? ` — ${deep.phase}` : ""}.</span>
          <button type="button" onClick={() => deep.stop()}>Stop that run</button>
        </div>
      ) : ask && profile && !reason ? (
        <div className="vdb-dnote">
          Map {plural(todo.length, "system")} of {ymmLabel(profile)} now? Each takes about 3–5 minutes and one AI session on your API key;
          {runsOn.kind === "real" ? " the car must stay connected with the ignition on." : " the virtual car must keep running."}
          {runsOn.mismatch ? " The car answering does not look like this model — what it answers is saved to this model." : ""}
          <span className="vdb-ask">
            <button type="button" className="vdb-go" onClick={() => { setAsk(false); void deep.start(profile, todo); }}>Start</button>
            <button type="button" onClick={() => setAsk(false)}>Cancel</button>
          </span>
        </div>
      ) : (
        <button type="button" className="vdb-go" disabled={!!reason} onClick={() => setAsk(true)}>Start deep map</button>
      )}
      {!running && !otherRun && reason && <p className="vdb-agent-small">{reason}</p>}

      {mine && deep.err && <div className="vdb-dnote err" role="alert">{deep.err}</div>}
      {mine && deep.note && <div className="vdb-dnote ok" role="status">{deep.note}</div>}
      {mine && !deep.running && (deep.err || deep.note) && <button type="button" className="tiny vdb-dismiss" onClick={() => deep.dismiss()}>Dismiss</button>}

      <span className="vdb-agent-foot">Reads only · airbag and immobiliser are left out</span>
    </section>
  );
}

export function LearnedList({ systems }: { systems: VehicleModule[] }) {
  const learned = systems.filter((m) => m.explored);
  return (
    <section className="ual-card pad vdb-learned" aria-labelledby="vdb-learned-title">
      <span id="vdb-learned-title" className="ual-eyebrow">Learned so far · identity / live / codes</span>
      {learned.length === 0 && <p className="ual-muted vdb-learned-empty">Nothing learned yet. Start a deep map, or pick a system in the map.</p>}
      {learned.map((m) => {
        const k = knowledgeOf(m);
        return (
          <div className="vdb-learned-row" key={m.id}>
            <span>
              <b>{short(m)}</b> · {m.explored!.confidence}
              {k.guard && <span className="vdb-learned-prot" title={k.guard.reason}> · protected</span>}
              <small>mapped {m.explored!.runCount}×{m.explored!.lastMappedAt ? ` · ${fmtDate(m.explored!.lastMappedAt)}` : ""}</small>
            </span>
            <span className="n" aria-label={`${k.counts.ident} identity, ${k.counts.live} live, ${k.counts.codes} codes`}>
              {k.counts.ident} / {k.counts.live} / {k.counts.codes}
            </span>
          </div>
        );
      })}
    </section>
  );
}
