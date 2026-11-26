import { useCallback, useEffect, useState } from "react";

import type { KnowledgeCard as Card, VehicleProfile } from "@ecu/vehicle-db";

import { Api } from "../../lib/api";

/**
 * What is known about this vehicle, step by step, with where each piece came from. There is no
 * single "% of everything" — only the maker knows the whole — so the card shows the ladder:
 * found → identified → decoded by a standard → offered by the community and tested on this car
 * → named and proven by our own mapping.
 */
const VERDICT: Record<string, { text: string; cls: string }> = {
  proven: { text: "proven here", cls: "clean" }, fits: { text: "fits this car", cls: "info" }, "out-of-range": { text: "wrong here", cls: "fault" },
};

export function KnowledgeCard({ profile }: { profile: VehicleProfile }) {
  const [card, setCard] = useState<Card | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sync, setSync] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setCard(await Api.knowledge.card({ profileId: profile.id })); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  }, [profile.id]);
  // the profile changes as scans and sweeps are saved: the card follows
  useEffect(() => { void load(); }, [load, profile.provenance?.updatedAt]);

  async function update() {
    setSync("Downloading…"); setErr(null);
    const off = Api.knowledge.onEvent((e) => setSync(e.of ? `Downloading ${e.done}/${e.of}…` : e.text ?? "Working…"));
    try { const r = await Api.knowledge.sync(); setSync(`Updated: ${r.signals.toLocaleString()} definitions, ${r.dtcs.toLocaleString()} fault codes`); await load(); }
    catch (e) { setErr((e as Error).message); setSync(null); }
    finally { off(); }
  }

  if (!card) return err ? <div className="ual-note err">{err}</div> : null;
  const c = card.community, v = c.verdicts;
  const std = card.standard;
  return (
    <section className="vdb-know" aria-label="What is known about this vehicle">
      <div className="vdb-know-head">
        <h3 className="vdb-h3">What we know</h3>
        <span className="ual-muted">every number says where it came from</span>
      </div>
      <dl className="vdb-know-steps">
        <dt>Modules</dt>
        <dd><b>{card.modules.found}</b> found · <b>{card.modules.identified}</b> identified · {card.modules.serials} serial numbers · fault memory read on {card.modules.faultsRead} · {card.modules.protected} protected<span className="ual-chip unread">this car</span></dd>

        <dt>Standard values</dt>
        <dd>
          {card.builtAt ? <><b>{std.definitions}</b> defined by the OBD-II standard</> : "standard definitions not downloaded yet"}
          {std.modules.length ? <> · supported here: {std.modules.map((m) => `${m.module} ${m.supported}`).join(", ")}</> : <> · supported list not read yet</>}
          <span className="ual-chip clean">standard</span>
        </dd>

        <dt>Fault codes</dt>
        <dd>
          {card.faults.length === 0 ? "none on file" : card.faults.map((f) => (
            <span key={f.code + f.module} className="vdb-know-dtc"><span className="ual-mono">{f.code}</span> {f.title ?? (f.makerSpecific ? <span className="ual-muted">maker-specific, no public meaning</span> : <span className="ual-muted">no public meaning found</span>)} <span className="ual-muted">· {f.module}</span></span>
          ))}
          {card.faults.some((f) => f.title) && <span className="ual-chip clean">OBDex</span>}
        </dd>

        <dt>Community</dt>
        <dd>
          {!card.builtAt ? "not downloaded yet" : <>
            {c.modelSets.length ? <>sets for this model: {c.modelSets.join(", ")}</> : <>no set for this model yet</>}{c.makeSet ? <> · make set {c.makeSet}</> : null}
            {" · "}<b>{c.candidates}</b> candidate definitions from related models, <b>{c.tested}</b> for modules this car has: <b>{v.proven}</b> proven, <b>{v.fits}</b> fit, <b>{v["out-of-range"]}</b> wrong here, {v["no-answer"] + v["too-short"]} do not apply, {v["not-swept"]} not testable yet
            <span className="ual-chip info">OBDb</span>
            {c.signals.length > 0 && (
              <details className="vdb-list"><summary>Tested on this car <span className="ual-muted">· {c.signals.length}</span></summary>
                <ul className="vdb-labs">{c.signals.map((s, i) => (
                  <li key={i} className="vdb-lab">
                    <div className="vdb-lab-head"><span className="ual-mono">{s.module} · {s.request}</span><span className={`ual-chip ${VERDICT[s.verdict]?.cls ?? "unread"}`}>{VERDICT[s.verdict]?.text ?? s.verdict}</span></div>
                    <b>{s.name}</b>
                    <span className="vdb-lab-val">{s.values} {s.unit}</span>
                    <span className="ual-muted">{s.note} · from {s.sets.slice(0, 3).join(", ")}{s.sets.length > 3 ? ` and ${s.sets.length - 3} more` : ""}</span>
                  </li>
                ))}</ul>
              </details>
            )}
          </>}
        </dd>

        <dt>Our own mapping</dt>
        <dd>{card.own.swept} modules swept · <b>{card.own.answered}</b> identifiers answer · {card.own.changing} change · {card.own.labelled} labelled: {card.own.named} named, <b>{card.own.proven}</b> proven<span className="ual-chip unread">this car</span></dd>
      </dl>
      <div className="vdb-know-foot">
        <span className="ual-muted">
          {card.sources.length ? card.sources.map((s) => `${s.name.split(" — ")[0]} (${s.licence}, ${new Date(s.retrievedAt).toLocaleDateString()})`).join(" · ") : "Outside sources not downloaded yet."}
          {card.sources.length ? " — downloaded to this PC, used under their licences, not part of the app." : ""}
        </span>
        <button type="button" className="tiny" disabled={!!sync && sync.startsWith("Download")} onClick={() => void update()}>{card.builtAt ? "Update sources" : "Download sources"}</button>
        {sync && <span className="ual-muted">{sync}</span>}
      </div>
      {err && <div className="ual-note err">{err}</div>}
    </section>
  );
}
