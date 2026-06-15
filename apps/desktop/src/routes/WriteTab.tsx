import { useEffect, useMemo, useState } from "react";

import type { ChipProfile } from "@ecu/chip-db";
import { effectiveSpiClockHz, picoModeForChip } from "@ecu/chip-db";

import { ClockControl } from "../components/ClockControl";
import { HexEditor } from "../components/HexEditor";
import { Topbar } from "../components/Topbar";
import { Api, type DumpEntry } from "../lib/api";
import { usePico } from "../lib/pico-connection";
import {
  base64ToBytes,
  dirtyRuns,
  eraseChip,
  eraseFlash,
  isEeprom,
  readChip,
  sha256Hex,
  unlockChip,
  writeAt,
  writeChip,
} from "../lib/picoforge";

type Tool = "write" | "erase" | "edit";
type Phase = "idle" | "writing" | "verifying" | "done";

function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(2)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export function WriteTab() {
  const { port, spiClockHz, setSpiClockHz } = usePico();
  const [tool, setTool] = useState<Tool>("write");
  const [dumps, setDumps] = useState<DumpEntry[]>([]);
  const [chips, setChips] = useState<ChipProfile[]>([]);
  const [query, setQuery] = useState("");
  const [chipId, setChipId] = useState("");

  // write-image tool
  const [dumpName, setDumpName] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [eraseFirst, setEraseFirst] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<{ ok: boolean; srcSha: string; backSha: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // erase tool
  const [eraseConfirm, setEraseConfirm] = useState("");
  const [eraseBusy, setEraseBusy] = useState(false);
  const [eraseProgress, setEraseProgress] = useState("");
  const [eraseResult, setEraseResult] = useState<{ ok: boolean; nonBlank: number } | null>(null);
  const [eraseError, setEraseError] = useState<string | null>(null);

  // edit tool
  const [buf, setBuf] = useState<Uint8Array | null>(null);
  const [orig, setOrig] = useState<Uint8Array | null>(null);
  const [dirty, setDirty] = useState<Map<number, number>>(new Map());
  const [editConfirm, setEditConfirm] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editProgress, setEditProgress] = useState("");
  const [editResult, setEditResult] = useState<{ ok: boolean; bytes: number; runs: number } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  // text/blank staging inputs
  const [textOff, setTextOff] = useState("0");
  const [textVal, setTextVal] = useState("");
  const [blankOff, setBlankOff] = useState("0");
  const [blankLen, setBlankLen] = useState("");
  const [blankFill, setBlankFill] = useState("ff");

  useEffect(() => {
    Api.pico.listDumps().then(setDumps).catch(() => undefined);
    Api.chips.list().then(setChips).catch(() => undefined);
  }, []);

  const dump = useMemo(() => dumps.find((d) => d.name === dumpName) ?? null, [dumps, dumpName]);
  const chip = useMemo(() => chips.find((c) => c.chipProfileId === chipId) ?? null, [chips, chipId]);
  const modeInfo = chip ? picoModeForChip(chip) : null;
  const mode = modeInfo?.mode ?? null;
  const isFlash = mode === 0;
  const eeprom = mode !== null && isEeprom(mode);
  const clockHz = chip ? effectiveSpiClockHz(chip, spiClockHz ?? undefined) : undefined;

  const supportedChips = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = chips.filter((c) => picoModeForChip(c) !== null);
    if (!q) return list.slice(0, 30);
    return list.filter((c) => [c.displayName, c.family].join(" ").toLowerCase().includes(q)).slice(0, 30);
  }, [chips, query]);

  function pickChip(id: string) {
    setChipId(id);
    setConfirmText("");
    setEraseConfirm("");
    setEditConfirm("");
    setResult(null);
    setEraseResult(null);
    setEditResult(null);
    setBuf(null);
    setOrig(null);
    setDirty(new Map());
  }

  // ---------- write image ----------
  const sizeOk = !!dump && !!chip && dump.sizeBytes === chip.sizeBytes;
  const verified = dump?.meta.verified === true;
  const armed = !!chip && confirmText.trim() === chip.displayName;
  const busy = phase === "writing" || phase === "verifying";
  const canWrite = !!port && !!dump && !!chip && mode !== null && sizeOk && armed && !busy;

  async function doWrite() {
    if (!canWrite || !dump || !chip || mode === null || !port) return;
    setError(null);
    setResult(null);
    try {
      setPhase("writing");
      setProgress("loading dump…");
      const { base64 } = await Api.pico.readDump({ name: dump.name, offset: 0, length: dump.sizeBytes });
      const src = base64ToBytes(base64);
      const srcSha = await sha256Hex(src);
      if (isFlash && eraseFirst) {
        setProgress("erasing flash (tens of seconds)…");
        await eraseFlash(port, clockHz);
      } else if (eeprom) {
        setProgress("unlocking (clearing write-protect)…");
        await unlockChip(port, mode, clockHz);
      }
      await writeChip(port, mode, src, (d, t) => setProgress(`writing — ${d.toLocaleString()}/${t.toLocaleString()} B`), isFlash, clockHz);
      setPhase("verifying");
      const back = await readChip(port, mode, dump.sizeBytes, (d, t) => setProgress(`reading back — ${d.toLocaleString()}/${t.toLocaleString()} B`), clockHz);
      const backSha = await sha256Hex(back);
      setResult({ ok: backSha === srcSha, srcSha, backSha });
      setPhase("done");
      setConfirmText("");
    } catch (err) {
      setError((err as Error).message);
      setPhase("idle");
    } finally {
      setProgress("");
    }
  }

  // ---------- erase ----------
  const eraseArmed = !!chip && eraseConfirm.trim() === "ERASE";
  const canErase = !!port && !!chip && mode !== null && eraseArmed && !eraseBusy;

  async function doErase() {
    if (!canErase || !chip || mode === null || !port) return;
    setEraseError(null);
    setEraseResult(null);
    setEraseBusy(true);
    try {
      setEraseProgress(isFlash ? "erasing flash (tens of seconds)…" : "erasing (writing 0xFF)…");
      await eraseChip(port, mode, chip.sizeBytes, (d, t) => setEraseProgress(`erasing — ${d.toLocaleString()}/${t.toLocaleString()} B`), undefined, clockHz);
      setEraseProgress("verifying blank…");
      const back = await readChip(port, mode, chip.sizeBytes, (d, t) => setEraseProgress(`verifying — ${d.toLocaleString()}/${t.toLocaleString()} B`), clockHz);
      let nonBlank = 0;
      for (let i = 0; i < back.length; i++) if (back[i] !== 0xff) nonBlank++;
      setEraseResult({ ok: nonBlank === 0, nonBlank });
      setEraseConfirm("");
    } catch (err) {
      setEraseError((err as Error).message);
    } finally {
      setEraseBusy(false);
      setEraseProgress("");
    }
  }

  // ---------- surgical edit ----------
  async function readForEdit() {
    if (!port || !chip || mode === null) return;
    setEditError(null);
    setEditResult(null);
    setEditBusy(true);
    try {
      setEditProgress("reading chip…");
      const back = await readChip(port, mode, chip.sizeBytes, (d, t) => setEditProgress(`reading — ${d.toLocaleString()}/${t.toLocaleString()} B`), clockHz);
      setOrig(back.slice());
      setBuf(back.slice());
      setDirty(new Map());
    } catch (err) {
      setEditError((err as Error).message);
    } finally {
      setEditBusy(false);
      setEditProgress("");
    }
  }

  function onEdit(offset: number, value: number) {
    stageBytes(offset, [value & 0xff]);
  }

  /** Stages one or more byte values starting at `offset` into buf + dirty. */
  function stageBytes(offset: number, vals: number[]): number {
    if (!buf || !orig) return 0;
    const next = buf.slice();
    const m = new Map(dirty);
    let n = 0;
    for (let i = 0; i < vals.length; i++) {
      const o = offset + i;
      if (o < 0 || o >= next.length) break;
      next[o] = vals[i] & 0xff;
      if (orig[o] === next[o]) m.delete(o);
      else m.set(o, next[o]);
      n++;
    }
    setBuf(next);
    setDirty(m);
    return n;
  }

  function parseOffset(s: string): number {
    const v = s.trim().toLowerCase();
    if (!v) return NaN;
    return v.startsWith("0x") ? parseInt(v.slice(2), 16) : /^[0-9]+$/.test(v) ? parseInt(v, 10) : parseInt(v, 16);
  }

  function stageText() {
    const off = parseOffset(textOff);
    if (!buf || !Number.isFinite(off) || off < 0 || off >= buf.length || !textVal) return;
    const bytes = Array.from(new TextEncoder().encode(textVal));
    const n = stageBytes(off, bytes);
    setEditError(n < bytes.length ? `Text truncated — only ${n} of ${bytes.length} bytes fit before end of chip.` : null);
    setTextVal("");
  }

  function stageBlank() {
    const off = parseOffset(blankOff);
    const len = parseInt(blankLen.trim(), 10);
    const fill = parseInt(blankFill.trim(), 16) & 0xff;
    if (!buf || !Number.isFinite(off) || off < 0 || off >= buf.length || !Number.isFinite(len) || len <= 0 || Number.isNaN(fill)) return;
    stageBytes(off, new Array(len).fill(fill));
    setEditError(null);
  }

  const editArmed = editConfirm.trim() === "EDIT";
  const canApply = !!port && !!buf && mode !== null && eeprom && dirty.size > 0 && editArmed && !editBusy;

  async function applyEdits() {
    if (!canApply || !port || !buf || mode === null) return;
    setEditError(null);
    setEditResult(null);
    setEditBusy(true);
    try {
      const runs = dirtyRuns(dirty.keys());
      if (mode === 1) {
        setEditProgress("unlocking (clearing write-protect)…");
        await unlockChip(port, mode, clockHz);
      }
      let done = 0;
      for (const [s, e] of runs) {
        setEditProgress(`writing ${runs.length} run(s) — ${++done}/${runs.length}`);
        await writeAt(port, mode, s, buf.subarray(s, e), undefined, clockHz);
      }
      setEditProgress("reading back to verify…");
      const back = await readChip(port, mode, buf.length, (d, t) => setEditProgress(`verifying — ${d.toLocaleString()}/${t.toLocaleString()} B`), clockHz);
      let bad = 0;
      for (const off of dirty.keys()) if (back[off] !== buf[off]) bad++;
      setEditResult({ ok: bad === 0, bytes: dirty.size, runs: runs.length });
      // adopt the read-back as the new baseline
      setOrig(back.slice());
      setBuf(back.slice());
      setDirty(new Map());
      setEditConfirm("");
    } catch (err) {
      setEditError((err as Error).message);
    } finally {
      setEditBusy(false);
      setEditProgress("");
    }
  }

  if (!port) {
    return (
      <>
        <Topbar title="Write" crumb="not connected" />
        <div className="content">
          <div className="card">
            <h3>Connect PicoForge to begin</h3>
            <p className="tiny dim mt-8">Use <strong>Connect device</strong> in the sidebar.</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar title="Write" crumb={`PicoForge · ${port}`} />
      <div className="content">
        <div className="legal-banner" style={{ borderColor: "var(--warn)" }}>
          ⚠ These tools modify the chip. EEPROM writes auto-clear write-protect first, then read back and
          SHA-256 / byte verify what actually landed.
        </div>

        <div className="seg" style={{ marginBottom: 16 }}>
          <button className={tool === "write" ? "active" : ""} onClick={() => setTool("write")}>Write image</button>
          <button className={tool === "erase" ? "active warn" : ""} onClick={() => setTool("erase")}>Erase</button>
          <button className={tool === "edit" ? "active" : ""} onClick={() => setTool("edit")}>Edit bytes</button>
        </div>

        {/* shared chip picker */}
        <div className="card">
          <h3>Target chip</h3>
          <input type="text" placeholder="Search chips… e.g. 24C32, S-25A320A, 95080" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="grid cols-2 mt-8" style={{ maxHeight: "22vh", overflowY: "auto" }}>
            {supportedChips.map((c) => {
              const m = picoModeForChip(c);
              return (
                <button
                  key={c.chipProfileId}
                  className={chipId === c.chipProfileId ? "primary" : ""}
                  style={{ textAlign: "left", padding: 10 }}
                  onClick={() => pickChip(c.chipProfileId)}
                >
                  <div style={{ fontWeight: 600 }}>{c.displayName}</div>
                  <div className="tiny dim">MODE {m?.mode} · {m?.label} · {c.sizeBytes.toLocaleString()} B</div>
                </button>
              );
            })}
          </div>
          {chip && modeInfo && (
            <>
              <p className="tiny dim mt-8">
                Selected <strong>{chip.displayName}</strong> · {modeInfo.label} ·{" "}
                {isFlash ? "flash (erase-before-write)" : "EEPROM (byte-writable)"} · {fmtBytes(chip.sizeBytes)}
              </p>
              <ClockControl profile={chip} mode={modeInfo.mode} value={spiClockHz} onChange={setSpiClockHz} disabled={busy || eraseBusy || editBusy} />
            </>
          )}
        </div>

        {/* ============ WRITE IMAGE ============ */}
        {tool === "write" && (
          <>
            <div className="card mt-16">
              <h3>Source dump</h3>
              {dumps.length === 0 ? (
                <p className="tiny dim mt-8">No dumps yet — read &amp; save a chip first.</p>
              ) : (
                <div className="mt-8" style={{ maxHeight: "22vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                  {dumps.map((d) => (
                    <button
                      key={d.name}
                      className={dumpName === d.name ? "primary" : ""}
                      style={{ textAlign: "left", padding: 10 }}
                      onClick={() => { setDumpName(d.name); setResult(null); }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        {str(d.meta.displayName) || d.name}{" "}
                        <span className={`badge tiny ${d.meta.verified === true ? "ok" : "warn"}`}>
                          {d.meta.verified === true ? "✓ verified" : "unverified"}
                        </span>
                      </div>
                      <div className="tiny dim">{str(d.meta.mode)} · {fmtBytes(d.sizeBytes)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {dump && chip && modeInfo && (
              <div className="card mt-16">
                <h3>Write gate</h3>
                <div className="tiny mt-8" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <span style={{ width: 14, flex: "0 0 14px" }}>{sizeOk ? "✓" : "✗"}</span>
                    <span>Size match — dump {fmtBytes(dump.sizeBytes)} {sizeOk ? "=" : "≠"} chip {fmtBytes(chip.sizeBytes)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <span style={{ width: 14, flex: "0 0 14px" }}>✓</span>
                    <span>Target — {modeInfo.label}{isFlash ? " (flash — erased to 0xFF before writing)" : " (EEPROM — auto-unlock + byte write)"}</span>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <span style={{ width: 14, flex: "0 0 14px" }}>{verified ? "✓" : "⚠"}</span>
                    <span>Source is {verified ? "a verified backup" : "UNVERIFIED — proceed with caution"}</span>
                  </div>
                </div>

                {sizeOk ? (
                  <>
                    <p className="tiny dim mt-12">To arm the write, type the target chip name exactly: <strong>{chip.displayName}</strong></p>
                    <input type="text" placeholder={chip.displayName} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} style={{ width: "100%", marginTop: 8 }} />
                    {isFlash && (
                      <div className="mt-12">
                        <div className="tiny dim" style={{ marginBottom: 6 }}>Flash operation</div>
                        <div className="seg">
                          <button className={eraseFirst ? "active warn" : ""} onClick={() => setEraseFirst(true)}>⚡ Erase first</button>
                          <button className={!eraseFirst ? "active" : ""} onClick={() => setEraseFirst(false)}>Skip erase · blank chip</button>
                        </div>
                      </div>
                    )}
                    <button className="primary mt-12" style={{ width: "100%" }} onClick={doWrite} disabled={!canWrite}>
                      {busy ? "Working…" : isFlash && eraseFirst ? "Erase · Write · Verify" : "Write & Verify"}
                    </button>
                  </>
                ) : (
                  <p className="tiny mt-8" style={{ color: "var(--danger)" }}>Resolve the ✗ checks above before writing.</p>
                )}
                {progress && <p className="tiny mt-8 mono">{progress}</p>}
                {error && <p className="tiny mt-8" style={{ color: "var(--danger)" }}>{error}</p>}
              </div>
            )}

            {result && (
              <div className="card mt-16" style={{ borderColor: result.ok ? "var(--accent)" : "var(--danger)" }}>
                <span className={`badge ${result.ok ? "ok" : "warn"}`}>
                  {result.ok ? "✓ written & verified byte-exact" : "✗ MISMATCH — read-back differs from source"}
                </span>
                <p className="tiny dim mt-8 mono">source   {result.srcSha}</p>
                <p className="tiny dim mono">read-back {result.backSha}</p>
                {!result.ok && (
                  <p className="tiny mt-8" style={{ color: "var(--danger)" }}>
                    Read-back differs. Reseat the clip; if it persists the chip may be hardware write-protected
                    (I²C: WP pin must be GND) or failing.
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {/* ============ ERASE ============ */}
        {tool === "erase" && (
          <div className="card mt-16">
            <h3>Erase chip</h3>
            {!chip || mode === null ? (
              <p className="tiny dim mt-8">Pick a target chip above.</p>
            ) : (
              <>
                <p className="tiny dim mt-8">
                  Erases <strong>{chip.displayName}</strong> ({fmtBytes(chip.sizeBytes)}) to all <span className="mono">0xFF</span>
                  {isFlash ? " via chip-erase." : eeprom && mode === 1 ? " via FILL (auto-unlocks first)." : " by writing 0xFF."}
                  {" "}Then reads it back to confirm it's blank.
                </p>
                <p className="tiny dim mt-12">Type <strong>ERASE</strong> to confirm:</p>
                <input type="text" placeholder="ERASE" value={eraseConfirm} onChange={(e) => setEraseConfirm(e.target.value)} style={{ width: "100%", marginTop: 8 }} />
                <button className="primary mt-12 warn" style={{ width: "100%" }} onClick={doErase} disabled={!canErase}>
                  {eraseBusy ? "Working…" : "Erase & Verify Blank"}
                </button>
                {eraseProgress && <p className="tiny mt-8 mono">{eraseProgress}</p>}
                {eraseError && <p className="tiny mt-8" style={{ color: "var(--danger)" }}>{eraseError}</p>}
                {eraseResult && (
                  <div className="card compact mt-12" style={{ borderColor: eraseResult.ok ? "var(--accent)" : "var(--danger)" }}>
                    <span className={`badge ${eraseResult.ok ? "ok" : "warn"}`}>
                      {eraseResult.ok ? "✓ erased — chip is all 0xFF" : `✗ ${eraseResult.nonBlank.toLocaleString()} byte(s) not 0xFF`}
                    </span>
                    {!eraseResult.ok && (
                      <p className="tiny mt-8" style={{ color: "var(--danger)" }}>
                        Some bytes didn't clear — likely write-protect (I²C WP pin to GND) or a bad contact. Reseat and retry.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ============ EDIT BYTES ============ */}
        {tool === "edit" && (
          <div className="card mt-16">
            <h3>Edit bytes</h3>
            {!chip || mode === null ? (
              <p className="tiny dim mt-8">Pick a target chip above.</p>
            ) : isFlash ? (
              <p className="tiny mt-8" style={{ color: "var(--warn)" }}>
                Surgical byte editing is EEPROM-only. Flash can't flip individual bits without erasing the whole
                sector — use <strong>Write image</strong> (erase + write) for flash.
              </p>
            ) : (
              <>
                <div className="row gap-8 mt-8" style={{ alignItems: "center" }}>
                  <button onClick={readForEdit} disabled={editBusy}>{buf ? "Re-read chip" : "Read chip"}</button>
                  {buf && <span className="tiny dim">{fmtBytes(buf.length)} loaded · <strong>{dirty.size}</strong> byte(s) changed</span>}
                </div>
                {editProgress && <p className="tiny mt-8 mono">{editProgress}</p>}

                {buf && (
                  <div className="mt-12">
                    <div className="card compact" style={{ marginBottom: 12 }}>
                      <div className="tiny dim" style={{ marginBottom: 6 }}>✍ Write text at offset</div>
                      <div className="row gap-8" style={{ alignItems: "center", flexWrap: "wrap" }}>
                        <input type="text" placeholder="offset (0x… or dec)" value={textOff} onChange={(e) => setTextOff(e.target.value)} style={{ width: 130 }} />
                        <input type="text" placeholder="text to write" value={textVal} onChange={(e) => setTextVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") stageText(); }} style={{ flex: 1, minWidth: 160 }} />
                        <button onClick={stageText} disabled={!textVal}>Stage</button>
                      </div>
                      <div className="tiny dim mt-8" style={{ marginBottom: 6, marginTop: 10 }}>🗑 Blank a range (your "delete")</div>
                      <div className="row gap-8" style={{ alignItems: "center", flexWrap: "wrap" }}>
                        <input type="text" placeholder="offset" value={blankOff} onChange={(e) => setBlankOff(e.target.value)} style={{ width: 110 }} />
                        <input type="text" placeholder="length" value={blankLen} onChange={(e) => setBlankLen(e.target.value)} style={{ width: 90 }} />
                        <span className="tiny dim">fill</span>
                        <input type="text" placeholder="ff" value={blankFill} maxLength={2} onChange={(e) => setBlankFill(e.target.value)} style={{ width: 44 }} />
                        <button onClick={stageBlank} disabled={!blankLen}>Stage</button>
                      </div>
                      <p className="tiny dim mt-8">Staged edits show highlighted below; nothing is written until you Apply. Fixed-size chip — text overwrites in place (no insert/shift).</p>
                    </div>
                    <HexEditor bytes={buf} dirty={dirty} onEdit={onEdit} />
                    <p className="tiny dim mt-12">
                      Edit any cell (hex). Changed bytes highlight. Apply writes only the changed run(s) — currently{" "}
                      <strong>{dirty.size}</strong> byte(s) across <strong>{dirtyRuns(dirty.keys()).length}</strong> run(s).
                    </p>
                    <p className="tiny dim mt-8">Type <strong>EDIT</strong> to confirm:</p>
                    <input type="text" placeholder="EDIT" value={editConfirm} onChange={(e) => setEditConfirm(e.target.value)} style={{ width: "100%", marginTop: 8 }} />
                    <div className="row gap-8 mt-12">
                      <button className="primary" style={{ flex: 1 }} onClick={applyEdits} disabled={!canApply}>
                        {editBusy ? "Working…" : `Apply ${dirty.size} change(s) & Verify`}
                      </button>
                      <button onClick={() => { if (orig) { setBuf(orig.slice()); setDirty(new Map()); setEditConfirm(""); setEditError(null); } }} disabled={editBusy || dirty.size === 0}>
                        Revert staged
                      </button>
                    </div>
                  </div>
                )}
                {editError && <p className="tiny mt-8" style={{ color: "var(--danger)" }}>{editError}</p>}
                {editResult && (
                  <div className="card compact mt-12" style={{ borderColor: editResult.ok ? "var(--accent)" : "var(--danger)" }}>
                    <span className={`badge ${editResult.ok ? "ok" : "warn"}`}>
                      {editResult.ok
                        ? `✓ ${editResult.bytes} byte(s) in ${editResult.runs} run(s) written & verified`
                        : "✗ read-back mismatch on edited bytes"}
                    </span>
                    {!editResult.ok && (
                      <p className="tiny mt-8" style={{ color: "var(--danger)" }}>
                        Edited bytes didn't stick — write-protect or contact. Reseat and retry.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
