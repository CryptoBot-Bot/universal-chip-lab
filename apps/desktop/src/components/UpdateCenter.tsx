import { useEffect, useRef, useState } from "react";

import { Api, type PublishLog, type UpdateState } from "../lib/api";

type Bump = "patch" | "minor" | "major";

function bumpPreview(cur: string, bump: Bump): string {
  const m = cur.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return cur;
  let [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === "major") { a++; b = 0; c = 0; }
  else if (bump === "minor") { b++; c = 0; }
  else c++;
  return `${a}.${b}.${c}`;
}

const KIND_COLOR: Record<string, string> = {
  step: "var(--accent)",
  ok: "var(--accent)",
  err: "var(--warn)",
  fail: "var(--danger)",
  out: "var(--fg-1)",
};

interface Readiness {
  ready: boolean;
  isDev: boolean;
  currentVersion?: string;
  reasons: string[];
}

export function UpdateCenter({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<Readiness | null>(null);
  const [bump, setBump] = useState<Bump>("patch");
  const [log, setLog] = useState<PublishLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [upd, setUpd] = useState<UpdateState | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  function refreshReadiness() {
    Api.publish.readiness().then(setInfo).catch(() => setInfo({ ready: false, isDev: false, reasons: ["Could not read readiness."] }));
  }

  useEffect(() => {
    refreshReadiness();
    Api.updates.getState().then((s) => setUpd(s.last)).catch(() => undefined);
    const offLog = Api.publish.onLog((e) => setLog((x) => [...x, e].slice(-500)));
    const offUpd = Api.updates.onState((s) => setUpd(s));
    return () => { offLog(); offUpd(); };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  async function publish() {
    if (!info?.ready) return;
    setBusy(true);
    setNote(null);
    setLog([]);
    try {
      const r = await Api.publish.run(bump);
      setNote(r.ok ? `✓ Published ${r.tagName} — GitHub Actions is building the installer.` : (r.error ?? "Publish failed."));
    } finally {
      setBusy(false);
      refreshReadiness();
    }
  }

  async function check() {
    setNote(null);
    const r = await Api.updates.check();
    if (!r.ok) setNote(r.error ?? "Check failed.");
    else if (!r.latestVersion || r.latestVersion === r.currentVersion) setNote("You're on the latest version.");
  }

  const cur = info?.currentVersion ?? "?";
  const isDev = info?.isDev ?? false;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
    >
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: 580, maxWidth: "92vw", maxHeight: "88vh", overflow: "auto" }}>
        <div className="row spread">
          <h3>Update Center</h3>
          <button className="tiny" onClick={onClose}>Close</button>
        </div>
        <p className="tiny dim mt-8">
          Current version <strong>v{cur}</strong> · {isDev ? "dev build (you can publish)" : "installed app"}
        </p>

        {isDev ? (
          <>
            <div className="card compact mt-12">
              <div className="row spread">
                <strong className="tiny">Git readiness</strong>
                <button className="tiny" onClick={refreshReadiness}>Refresh</button>
              </div>
              {info?.ready ? (
                <div className="tiny mt-8" style={{ color: "var(--accent)" }}>✓ Clean tree + origin remote — ready to publish.</div>
              ) : (
                <ul className="tiny mt-8" style={{ margin: 0, paddingLeft: 18, color: "var(--warn)" }}>
                  {(info?.reasons ?? []).map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              )}
            </div>

            <div className="mt-12">
              <div className="tiny dim" style={{ marginBottom: 6 }}>Version bump</div>
              <div className="seg">
                {(["patch", "minor", "major"] as Bump[]).map((b) => (
                  <button key={b} className={bump === b ? "active" : ""} onClick={() => setBump(b)}>{b}</button>
                ))}
              </div>
              <div className="tiny dim mt-8">v{cur} → <strong>v{bumpPreview(cur, bump)}</strong></div>
            </div>

            <button className="primary mt-12" style={{ width: "100%" }} onClick={publish} disabled={busy || !info?.ready}>
              {busy ? "Publishing…" : `Publish v${bumpPreview(cur, bump)} → push tag`}
            </button>
            {note && <p className="tiny mt-8" style={{ color: "var(--accent)" }}>{note}</p>}
            {log.length > 0 && (
              <pre ref={logRef} className="mono tiny mt-12" style={{ maxHeight: "32vh", overflow: "auto", margin: 0, whiteSpace: "pre-wrap" }}>
                {log.map((l, i) => <div key={i} style={{ color: KIND_COLOR[l.kind] ?? "var(--fg-1)" }}>{l.line}</div>)}
              </pre>
            )}
          </>
        ) : (
          <div className="mt-12">
            {upd?.state === "ready" ? (
              <button className="primary" style={{ width: "100%" }} onClick={() => Api.updates.install()}>
                Install v{upd?.version} &amp; restart
              </button>
            ) : (
              <button className="primary" style={{ width: "100%" }} onClick={check} disabled={upd?.state === "checking" || upd?.state === "downloading"}>
                {upd?.state === "checking" ? "Checking…" : upd?.state === "downloading" ? `Downloading ${upd?.percent ?? 0}%…` : "Check for updates"}
              </button>
            )}
            {upd?.state === "available" && <p className="tiny mt-8">Update v{upd?.version} found — downloading…</p>}
            {upd?.state === "error" && <p className="tiny mt-8" style={{ color: "var(--danger)" }}>{upd?.error}</p>}
            {note && <p className="tiny mt-8">{note}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
