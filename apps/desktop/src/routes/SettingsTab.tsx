import { useEffect, useState } from "react";

import { formatClockHz, SAFE_FIRST_CONTACT_HZ } from "@ecu/chip-db";

import { Topbar } from "../components/Topbar";
import { Api, type KeyStatus } from "../lib/api";
import { usePico } from "../lib/pico-connection";

const CLOCK_PRESETS: Array<{ label: string; hz: number | null }> = [
  { label: "Auto (chip-rated)", hz: null },
  { label: "Safe · 1 MHz", hz: SAFE_FIRST_CONTACT_HZ },
  { label: "2 MHz", hz: 2_000_000 },
  { label: "4 MHz", hz: 4_000_000 },
  { label: "8 MHz", hz: 8_000_000 },
];

export function SettingsTab() {
  const { spiClockHz, setSpiClockHz } = usePico();
  const [clockCustom, setClockCustom] = useState("");
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

        <div className="card mt-16">
          <h3>SPI clock default</h3>
          <p className="tiny dim mt-8">
            The SCK frequency PicoForge uses for SPI chips (Flash &amp; 25/95 EEPROM). Slower is always
            safe for reads — there's no minimum. If a chip reads back all <span className="mono">0x00</span>
            {" "}(its MISO line isn't being driven fast enough), drop to <strong>Safe · 1 MHz</strong>.
            <strong> Auto</strong> uses each chip's datasheet-rated clock. This is shared with the per-read
            control in the Read &amp; Write tabs.
          </p>
          <div className="card compact mt-12">
            <div className="row spread" style={{ alignItems: "center" }}>
              <div className="tiny dim">Current default</div>
              <div className="tiny">
                <strong>{spiClockHz === null ? "Auto (chip-rated)" : formatClockHz(spiClockHz)}</strong>
              </div>
            </div>
            <div className="seg mt-8" style={{ flexWrap: "wrap" }}>
              {CLOCK_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className={spiClockHz === p.hz ? "active" : ""}
                  onClick={() => setSpiClockHz(p.hz)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="row gap-8 mt-8" style={{ alignItems: "center" }}>
              <span className="tiny dim">custom</span>
              <input
                type="number"
                step="0.5"
                min="0.01"
                placeholder="MHz"
                value={clockCustom}
                onChange={(e) => setClockCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const mhz = Number(clockCustom.trim());
                    if (Number.isFinite(mhz) && mhz > 0) setSpiClockHz(Math.round(mhz * 1_000_000));
                  }
                }}
                style={{ width: 90 }}
              />
              <span className="tiny dim">MHz</span>
              <button
                className="tiny"
                disabled={!clockCustom.trim()}
                onClick={() => {
                  const mhz = Number(clockCustom.trim());
                  if (Number.isFinite(mhz) && mhz > 0) setSpiClockHz(Math.round(mhz * 1_000_000));
                }}
              >
                Set
              </button>
            </div>
            <p className="tiny dim mt-8">Note: I²C and Microwire chips run at fixed firmware clocks — this affects SPI only.</p>
          </div>
        </div>
      </div>
    </>
  );
}
