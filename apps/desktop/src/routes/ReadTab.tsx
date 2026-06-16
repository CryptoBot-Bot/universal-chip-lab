import { useEffect, useMemo, useState } from "react";

import type { ChipIdentification, ChipProfile } from "@ecu/chip-db";
import { accessGuideFor, draftProfileFromIdentification, picoModeForChip } from "@ecu/chip-db";

import { ClockControl } from "../components/ClockControl";
import { Topbar } from "../components/Topbar";
import { Api } from "../lib/api";
import { usePico } from "../lib/pico-connection";
import { bytesToBase64, hexDump, sha256Hex } from "../lib/picoforge";

type Img = { data: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" };

interface ReadResult {
  sha: string;
  verified: boolean;
  preview: string;
  size: number;
  modeLabel: string;
  bytes: Uint8Array;
}

async function fileToImage(file: File): Promise<Img> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error("Could not read image."));
    r.readAsDataURL(file);
  });
  const mediaType = dataUrl.substring(5, dataUrl.indexOf(";")) as Img["mediaType"];
  return { data: dataUrl.slice(dataUrl.indexOf(",") + 1), mediaType };
}

export function ReadTab() {
  const { port, device, backend, spiClockHz, setSpiClockHz } = usePico();
  const [chips, setChips] = useState<ChipProfile[]>([]);
  const [query, setQuery] = useState("");
  const [chipId, setChipId] = useState("");

  // photo resolver
  const [images, setImages] = useState<Img[]>([]);
  const [hint, setHint] = useState("");
  const [resolving, setResolving] = useState(false);
  const [ident, setIdent] = useState<ChipIdentification | null>(null);
  const [resolvedChip, setResolvedChip] = useState<ChipProfile | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [saveChipMsg, setSaveChipMsg] = useState<string | null>(null);

  // read
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<ReadResult | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    Api.chips.list().then(setChips).catch(() => undefined);
  }, []);

  const dbChip = useMemo(() => chips.find((c) => c.chipProfileId === chipId) ?? null, [chips, chipId]);
  const activeChip = resolvedChip ?? dbChip;
  const modeInfo = activeChip ? picoModeForChip(activeChip) : null;
  const sizeReady = !!activeChip && activeChip.sizeBytes > 0;
  // The Simulator reaches every chip; PicoForge only serial families (those with a Pico mode).
  const reachable = !!activeChip && (device === "simulator" || modeInfo !== null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chips.slice(0, 40);
    return chips
      .filter((c) => [c.displayName, c.family, c.manufacturer ?? "", c.package, c.protocol].join(" ").toLowerCase().includes(q))
      .slice(0, 40);
  }, [chips, query]);

  async function onFiles(files: FileList | null) {
    if (!files) return;
    const imgs = await Promise.all(Array.from(files).map(fileToImage));
    setImages(imgs);
  }

  async function identify() {
    if (images.length === 0) return;
    setResolving(true);
    setResolveError(null);
    setIdent(null);
    setResolvedChip(null);
    setSaveChipMsg(null);
    setResult(null);
    try {
      const id = await Api.chips.resolve({ images, markingsHint: hint || undefined });
      setIdent(id);
      const draft = draftProfileFromIdentification(id, { createdAt: new Date().toISOString(), model: "claude-opus-4-8" });
      setResolvedChip(draft);
      setChipId("");
    } catch (err) {
      setResolveError((err as Error).message);
    } finally {
      setResolving(false);
    }
  }

  async function saveResolvedChip() {
    if (!resolvedChip) return;
    try {
      await Api.chips.saveProfile(resolvedChip);
      setChips(await Api.chips.list());
      setSaveChipMsg("Saved to Chip Database as AI-suggested. Verify on silicon before any write.");
    } catch (err) {
      setSaveChipMsg((err as Error).message);
    }
  }

  async function readAndVerify() {
    if (!backend || !activeChip || !sizeReady || !reachable) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setSaveMsg(null);
    try {
      const r1 = await backend.readChip(activeChip, (d, t) => setProgress(`read 1/2 — ${d.toLocaleString()}/${t.toLocaleString()} B`));
      const r2 = await backend.readChip(activeChip, (d, t) => setProgress(`read 2/2 — ${d.toLocaleString()}/${t.toLocaleString()} B`));
      const s1 = await sha256Hex(r1);
      const s2 = await sha256Hex(r2);
      const modeLabel = modeInfo?.label ?? `${accessGuideFor(activeChip).label} (simulated)`;
      setResult({ sha: s1, verified: s1 === s2, preview: hexDump(r1), size: activeChip.sizeBytes, modeLabel, bytes: r1 });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  async function saveDump() {
    if (!activeChip || !result) return;
    try {
      const res = await Api.pico.saveDump({
        name: activeChip.displayName,
        base64: bytesToBase64(result.bytes),
        meta: {
          chipProfileId: activeChip.chipProfileId,
          displayName: activeChip.displayName,
          family: activeChip.family,
          mode: result.modeLabel,
          sizeBytes: result.size,
          sha256: result.sha,
          verified: result.verified,
        },
      });
      setSaveMsg(`Saved ${res.bytes.toLocaleString()} bytes → ${res.path}`);
    } catch (err) {
      setSaveMsg(`Save failed: ${(err as Error).message}`);
    }
  }

  if (!port || !backend) {
    return (
      <>
        <Topbar title="Read" crumb="not connected" />
        <div className="content">
          <div className="card">
            <h3>Connect a device to begin</h3>
            <p className="tiny dim mt-8">
              Pick <strong>PicoForge</strong> or <strong>Simulator</strong> and hit <strong>Connect device</strong> in the
              sidebar. The Simulator needs no hardware — great for trying the full read/verify flow.
            </p>
          </div>
        </div>
      </>
    );
  }

  const deviceName = device === "simulator" ? "Simulator" : "PicoForge";

  return (
    <>
      <Topbar title="Read" crumb={`${deviceName} · ${port}`} />
      <div className="content">
        {/* Identify from photo */}
        <div className="card">
          <h3>Identify from photo <span className="tiny dim">— add a new chip smartly</span></h3>
          <p className="tiny dim mt-8">
            Upload a sharp photo of the chip's top markings. The AI reads it and picks the family,
            size, and the PicoForge mode for you.
          </p>
          <div className="row gap-8 mt-8">
            <input type="file" accept="image/*" multiple onChange={(e) => onFiles(e.target.files)} />
            <input type="text" placeholder="markings hint (optional)" value={hint} onChange={(e) => setHint(e.target.value)} style={{ flex: 1 }} />
            <button className="primary" onClick={identify} disabled={resolving || images.length === 0}>
              {resolving ? "Identifying…" : "Identify"}
            </button>
          </div>
          {resolveError && <p className="tiny mt-8" style={{ color: "var(--danger)" }}>{resolveError}</p>}

          {ident && resolvedChip && (
            <div className="card compact mt-12">
              <div className="row spread">
                <div>
                  <strong>{resolvedChip.displayName}</strong>{" "}
                  <span className={`badge tiny ${ident.confidence === "high" ? "ok" : "warn"}`}>{ident.confidence} confidence</span>
                </div>
                <button className="tiny" onClick={saveResolvedChip}>Save to database</button>
              </div>
              <div className="tiny dim mt-8">
                Markings: <span className="mono">{ident.markings || "—"}</span> · {ident.family}
              </div>
              <div className="tiny mt-8">
                {picoModeForChip(resolvedChip) ? (
                  <span className="badge tiny info">MODE {picoModeForChip(resolvedChip)!.mode} · {picoModeForChip(resolvedChip)!.label}</span>
                ) : (
                  <span style={{ color: "var(--danger)" }}>PicoForge can't read this family (internal MCU).</span>
                )}{" "}
                <span className="dim">size</span>{" "}
                <input
                  type="number"
                  value={resolvedChip.sizeBytes}
                  onChange={(e) => setResolvedChip({ ...resolvedChip, sizeBytes: Number(e.target.value) || 0 })}
                  style={{ width: 110 }}
                /> bytes
                {resolvedChip.sizeBytes === 0 && <span style={{ color: "var(--warn)" }}> ← set the capacity to read</span>}
              </div>
              <p className="tiny dim mt-8">{ident.reasoning}</p>
              {saveChipMsg && <p className="tiny mt-8" style={{ color: "var(--accent)" }}>{saveChipMsg}</p>}
            </div>
          )}
        </div>

        {/* Pick from DB — ALL chips. The Simulator reaches every one; PicoForge serial only. */}
        <div className="card mt-16">
          <h3>…or pick any chip <span className="tiny dim">— all {chips.length} in your database</span></h3>
          <input
            type="text"
            placeholder="Search all chips… e.g. 24C32, 95080, W25Q, SPC5668, TC1767, 29F040"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {device !== "simulator" && (
            <p className="tiny dim mt-8">
              On <strong>PicoForge</strong>, only serial chips (📎) can be read. Switch to the <strong>Simulator</strong> to open any chip.
            </p>
          )}
          <div className="grid cols-2 mt-8" style={{ maxHeight: "26vh", overflowY: "auto" }}>
            {filtered.map((c) => {
              const g = accessGuideFor(c);
              const reach = device === "simulator" || picoModeForChip(c) !== null;
              return (
                <button
                  key={c.chipProfileId}
                  className={!resolvedChip && chipId === c.chipProfileId ? "primary" : ""}
                  style={{ textAlign: "left", padding: 10, opacity: reach ? 1 : 0.55 }}
                  onClick={() => { setChipId(c.chipProfileId); setResolvedChip(null); setIdent(null); setResult(null); setSaveMsg(null); }}
                >
                  <div style={{ fontWeight: 600 }}>{c.displayName}</div>
                  <div className="tiny dim">
                    {g.icon} {g.label} · {c.sizeBytes.toLocaleString()} B
                    {!reach && <span style={{ color: "var(--warn)" }}> · needs Simulator</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Read */}
        {activeChip && (
          <div className="card mt-16">
            <div className="row spread">
              <div>
                <h3>{activeChip.displayName}</h3>
                <div className="tiny dim mt-8">
                  {modeInfo
                    ? <span className="badge tiny info">MODE {modeInfo.mode} · {modeInfo.label}</span>
                    : <span className="badge tiny">{accessGuideFor(activeChip).icon} {accessGuideFor(activeChip).label}</span>}{" "}
                  · {activeChip.sizeBytes.toLocaleString()} bytes · {activeChip.voltage.min}–{activeChip.voltage.max} V
                </div>
              </div>
              <button className="primary" onClick={readAndVerify} disabled={busy || !sizeReady || !reachable}>
                {busy ? "Reading…" : "Read & verify"}
              </button>
            </div>
            {!sizeReady && <p className="tiny mt-8" style={{ color: "var(--warn)" }}>Set the chip capacity above before reading.</p>}
            {!reachable && (
              <p className="tiny mt-8" style={{ color: "var(--warn)" }}>
                PicoForge can't reach this chip ({accessGuideFor(activeChip).label}). Switch to the <strong>Simulator</strong> to
                read it now, or use a T48 / CH347 (coming soon).
              </p>
            )}
            {device !== "simulator" && modeInfo && (
              <ClockControl profile={activeChip} mode={modeInfo.mode} value={spiClockHz} onChange={setSpiClockHz} disabled={busy} />
            )}
            {reachable && (
              <p className="tiny dim mt-8">
                {device === "simulator"
                  ? "Simulator: returns deterministic, repeatable contents for this chip — no wiring needed. Reads twice and SHA-verifies, exactly like hardware."
                  : `Plug the ${modeInfo?.label} adapter, clip the chip (red→pin 1), meter pin-8 = 3.3 V / GND = 0 V, then read.`}
              </p>
            )}
            {progress && <p className="tiny mt-8 mono">{progress}</p>}
            {error && <p className="tiny mt-8" style={{ color: "var(--danger)" }}>{error}</p>}
          </div>
        )}

        {result && (
          <div className="card mt-16" style={{ borderColor: result.verified ? "var(--accent)" : "var(--warn)" }}>
            <div className="row spread">
              <span className={`badge ${result.verified ? "ok" : "warn"}`}>
                {result.verified ? "✓ verified backup" : "⚠ reads differ — reseat & retry"}
              </span>
              <button className="primary" onClick={saveDump} disabled={busy}>Save dump</button>
            </div>
            <p className="tiny dim mt-8 mono">SHA-256 {result.sha}</p>
            <pre className="mono tiny" style={{ margin: 0, marginTop: 8, maxHeight: "32vh", overflow: "auto" }}>
              {result.preview}
            </pre>
            {saveMsg && <p className="tiny mt-8" style={{ color: "var(--accent)" }}>{saveMsg}</p>}
          </div>
        )}
      </div>
    </>
  );
}
