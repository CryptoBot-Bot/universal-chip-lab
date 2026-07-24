import { useEffect, useState } from "react";

import { Api, type JobCountStatus } from "../lib/api";

/**
 * Link this Chip Lab to a JobCount repair-shop tenant via the same paired-device
 * tunnel the JobCount softphone uses: the manager generates a 6-digit code in
 * JobCount → paste it here → we redeem it for an encrypted device token scoped
 * to that shop. Once linked, an OBD VIN read drops the vehicle into the shop's
 * garage automatically.
 */
export function JobCountLink() {
  const [status, setStatus] = useState<JobCountStatus | null>(null);
  const [server, setServer] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function refresh() {
    Api.jobcount.status().then((s) => {
      setStatus(s);
      if (s.serverUrl && !server) setServer(s.serverUrl);
    }).catch(() => undefined);
  }
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When already linked, confirm the token still works against the server.
  useEffect(() => {
    if (status?.linked) {
      Api.jobcount.verify().then((v) => {
        if (!v.ok) setMsg({ ok: false, text: `Link check failed: ${v.error}. The shop may have revoked this device — re-pair below.` });
      }).catch(() => undefined);
    }
  }, [status?.linked]);

  async function pair() {
    setBusy(true); setMsg(null);
    try {
      const s = await Api.jobcount.pair(server.trim(), code.trim());
      setStatus(s);
      setCode("");
      setMsg({ ok: true, text: `Linked to ${s.shopName}. VIN reads now sync to this shop's garage.` });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally { setBusy(false); }
  }

  async function unlink() {
    setBusy(true); setMsg(null);
    try {
      const s = await Api.jobcount.unpair();
      setStatus(s);
      setMsg({ ok: true, text: "Unlinked on this PC. (To fully revoke, remove the device in JobCount.)" });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally { setBusy(false); }
  }

  return (
    <div className="card mt-16">
      <h3>JobCount shop link</h3>
      <p className="tiny dim mt-8">
        Connect this Chip Lab to your <strong>JobCount</strong> auto-shop over the same secure paired-device
        tunnel the softphone uses. Once linked, every VIN you read with the OBD tool is added to that shop's
        Garage. The device token is stored encrypted on this computer.
      </p>

      {status?.linked ? (
        <div className="card compact mt-12" style={{ borderColor: "var(--accent)" }}>
          <div className="row spread" style={{ alignItems: "center" }}>
            <span className="badge ok">✓ linked</span>
            <button className="tiny" onClick={unlink} disabled={busy}>Unlink</button>
          </div>
          <p className="tiny mt-8"><strong>{status.shopName}</strong></p>
          <p className="tiny dim mono">{status.serverUrl}</p>
          {status.storedUnencrypted && (
            <p className="tiny mt-8" style={{ color: "var(--warn)" }}>
              ⚠ OS keychain unavailable — the device token is stored unencrypted on this PC.
            </p>
          )}
        </div>
      ) : (
        <div className="mt-12">
          <div className="tiny dim" style={{ marginBottom: 6 }}>
            In JobCount: open your shop → <strong>Devices → Pair new device</strong> → it shows a 6-digit code.
            Enter the server address and that code here.
          </div>
          <input
            placeholder="JobCount address — e.g. https://jobcount.org or http://localhost:4000"
            value={server}
            onChange={(e) => setServer(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            style={{ width: "100%" }}
          />
          <div className="row gap-8 mt-8" style={{ alignItems: "center" }}>
            <input
              placeholder="6-digit code"
              value={code}
              inputMode="numeric"
              maxLength={6}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter" && server.trim() && code.length === 6) pair(); }}
              style={{ width: 130, letterSpacing: "0.2em", fontFamily: "var(--mono, monospace)" }}
            />
            <button className="primary" onClick={pair} disabled={busy || !server.trim() || code.length !== 6}>
              {busy ? "Linking…" : "Link shop"}
            </button>
          </div>
        </div>
      )}

      {msg && <p className="tiny mt-12" style={{ color: msg.ok ? "var(--accent)" : "var(--danger)" }}>{msg.text}</p>}
    </div>
  );
}
