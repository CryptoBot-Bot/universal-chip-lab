import { useEffect, useState } from "react";

import { Topbar } from "../components/Topbar";
import { Api, type KeyStatus } from "../lib/api";

export function SettingsTab() {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function refresh() {
    Api.settings.getKeyStatus().then(setStatus).catch(() => undefined);
  }
  useEffect(refresh, []);

  async function save() {
    if (!keyInput.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await Api.settings.setApiKey(keyInput.trim());
      const test = await Api.settings.testApiKey();
      refresh();
      setKeyInput("");
      setMsg(test.ok
        ? { ok: true, text: "Key saved and verified — the AI chip resolver is ready." }
        : { ok: false, text: `Key saved, but the test call failed: ${test.error}` });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await Api.settings.testApiKey();
      setMsg(r.ok ? { ok: true, text: "Key works ✓" } : { ok: false, text: r.error ?? "Test failed." });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setMsg(null);
    try {
      await Api.settings.clearApiKey();
      refresh();
      setMsg({ ok: true, text: "Key removed." });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Topbar title="Settings" crumb="API key & preferences" />
      <div className="content">
        <div className="card">
          <h3>Anthropic API key</h3>
          <p className="tiny dim mt-8">
            The AI chip resolver (photo → identify) uses Anthropic's API. <strong>Bring your own key</strong> —
            it stays on this computer, encrypted by your OS, and is never sent anywhere except Anthropic.
            Get one at <span className="mono">console.anthropic.com</span>.
          </p>

          {status && (
            <div className="card compact mt-12" style={{ borderColor: status.hasKey ? "var(--accent)" : "var(--warn)" }}>
              <span className={`badge ${status.hasKey ? "ok" : "warn"}`}>
                {status.hasKey ? "✓ key configured" : "no key set"}
              </span>
              {status.hasKey && (
                <p className="tiny dim mt-8 mono">
                  {status.masked} · source: {status.source === "env" ? "environment (.env / system)" : "saved in app"}
                </p>
              )}
              {status.source === "env" && (
                <p className="tiny dim mt-8">An ANTHROPIC_API_KEY environment variable is set and takes priority over a saved key.</p>
              )}
              {status.hasKey && status.storedUnencrypted && (
                <p className="tiny mt-8" style={{ color: "var(--warn)" }}>
                  ⚠ Your OS keychain is unavailable, so the key is stored unencrypted. Use with caution.
                </p>
              )}
              {!status.encryptionAvailable && (
                <p className="tiny dim mt-8">Note: OS-level encryption isn't available on this system.</p>
              )}
            </div>
          )}

          <div className="mt-12">
            <div className="tiny dim" style={{ marginBottom: 6 }}>
              {status?.source === "env" ? "Save a key here (used only if the env var is removed)" : "Paste your API key"}
            </div>
            <input
              type="password"
              placeholder="sk-ant-…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
              autoComplete="off"
              spellCheck={false}
              style={{ width: "100%" }}
            />
            <div className="row gap-8 mt-12">
              <button className="primary" onClick={save} disabled={busy || !keyInput.trim()}>
                {busy ? "Working…" : "Save & verify"}
              </button>
              <button onClick={test} disabled={busy || !status?.hasKey}>Test current key</button>
              <button onClick={clear} disabled={busy || status?.source !== "stored"}>Remove saved key</button>
            </div>
          </div>

          {msg && (
            <p className="tiny mt-12" style={{ color: msg.ok ? "var(--accent)" : "var(--danger)" }}>{msg.text}</p>
          )}
        </div>
      </div>
    </>
  );
}
