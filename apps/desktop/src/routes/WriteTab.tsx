import { useEffect, useMemo, useState } from "react";

import type { ChipProfile } from "@ecu/chip-db";
import { picoModeForChip } from "@ecu/chip-db";

import { Topbar } from "../components/Topbar";
import { Api, type DumpEntry } from "../lib/api";
import { usePico } from "../lib/pico-connection";
import { base64ToBytes, eraseFlash, readChip, sha256Hex, writeChip } from "../lib/picoforge";

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
  const { port } = usePico();
  const [dumps, setDumps] = useState<DumpEntry[]>([]);
  const [chips, setChips] = useState<ChipProfile[]>([]);
  const [dumpName, setDumpName] = useState("");
  const [query, setQuery] = useState("");
  const [chipId, setChipId] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [eraseFirst, setEraseFirst] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<{ ok: boolean; srcSha: string; backSha: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // "Write text to flash" (erase → write → read back)
  const [bookText, setBookText] = useState("");
  const [bookConfirm, setBookConfirm] = useState("");
  const [bookErase, setBookErase] = useState(true);
  const [bookBusy, setBookBusy] = useState(false);
  const [bookProgress, setBookProgress] = useState("");
  const [bookResult, setBookResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);
  const [bookChipId, setBookChipId] = useState("");

  useEffect(() => {
    Api.pico.listDumps().then(setDumps).catch(() => undefined);
    Api.chips.list().then(setChips).catch(() => undefined);
  }, []);

  const bookBytes = useMemo(() => new TextEncoder().encode(bookText), [bookText]);
  const bookChip = useMemo(() => chips.find((c) => c.chipProfileId === bookChipId) ?? null, [chips, bookChipId]);
  const bookMode = bookChip ? picoModeForChip(bookChip) : null;
  const bookIsFlash = bookMode?.mode === 0;
  const bookFits = !!bookChip && bookBytes.length > 0 && bookBytes.length <= bookChip.sizeBytes;
  const bookWord = bookIsFlash && bookErase ? "ERASE" : "WRITE";

  async function writeBook() {
    if (!port || !bookChip || !bookMode || !bookFits || bookConfirm.trim() !== bookWord) return;
    setBookBusy(true);
    setBookError(null);
    setBookResult(null);
    try {
      if (bookIsFlash && bookErase) {
        setBookProgress("erasing flash (can take tens of seconds)…");
        await eraseFlash(port);
      }
      await writeChip(port, bookMode.mode, bookBytes, (d, t) => setBookProgress(`writing — ${d.toLocaleString()}/${t.toLocaleString()} B`), bookIsFlash);
      setBookProgress("reading back…");
      const back = await readChip(port, bookMode.mode, bookBytes.length, (d, t) => setBookProgress(`verifying — ${d.toLocaleString()}/${t.toLocaleString()} B`));
      const ok = (await sha256Hex(back)) === (await sha256Hex(bookBytes));
      setBookResult({ ok, text: new TextDecoder().decode(back.subarray(0, 400)) });
      setBookConfirm("");
    } catch (err) {
      setBookError((err as Error).message);
    } finally {
      setBookBusy(false);
      setBookProgress("");
    }
  }

  async function loadTextFile(file: File) {
    setBookText(await file.text());
  }

  const dump = useMemo(() => dumps.find((d) => d.name === dumpName) ?? null, [dumps, dumpName]);
  const chip = useMemo(() => chips.find((c) => c.chipProfileId === chipId) ?? null, [chips, chipId]);
  const modeInfo = chip ? picoModeForChip(chip) : null;

  const sizeOk = !!dump && !!chip && dump.sizeBytes === chip.sizeBytes;
  const isFlash = modeInfo?.mode === 0;
  const verified = dump?.meta.verified === true;
  const armed = !!chip && confirmText.trim() === chip.displayName;
  const busy = phase === "writing" || phase === "verifying";
  const canWrite = !!port && !!dump && !!chip && !!modeInfo && sizeOk && armed && !busy;

  const supportedChips = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = chips.filter((c) => picoModeForChip(c) !== null);
    if (!q) return list.slice(0, 30);
    return list.filter((c) => [c.displayName, c.family].join(" ").toLowerCase().includes(q)).slice(0, 30);
  }, [chips, query]);

  async function doWrite() {
    if (!canWrite || !dump || !chip || !modeInfo || !port) return;
    setError(null);
    setResult(null);
    try {
      setPhase("writing");
      setProgress("loading dump…");
      const { base64 } = await Api.pico.readDump({ name: dump.name, offset: 0, length: dump.sizeBytes });
      const src = base64ToBytes(base64);
      const srcSha = await sha256Hex(src);
      if (modeInfo.mode === 0 && eraseFirst) {
        setProgress("erasing flash (tens of seconds)…");
        await eraseFlash(port);
      }
      // On flash the chip is now all-FF (erased or blank), so skip FF chunks for speed.
      await writeChip(port, modeInfo.mode, src, (d, t) => setProgress(`writing — ${d.toLocaleString()}/${t.toLocaleString()} B`), modeInfo.mode === 0);
      setPhase("verifying");
      const back = await readChip(port, modeInfo.mode, dump.sizeBytes, (d, t) => setProgress(`reading back — ${d.toLocaleString()}/${t.toLocaleString()} B`));
      const backSha = await sha256Hex(back);
      setResult({ ok: backSha === srcSha, srcSha, backSha });
      setPhase("done");
      setConfirmText(""); // disarm
    } catch (err) {
      setError((err as Error).message);
      setPhase("idle");
    } finally {
      setProgress("");
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
          ⚠ Writing overwrites the chip. The gate below requires a size match, an EEPROM target, and a
          typed confirmation — then it reads back and SHA-256 verifies what landed.
        </div>

        <div className="card">
          <h3>1 · Source dump</h3>
          {dumps.length === 0 ? (
            <p className="tiny dim mt-8">No dumps yet — read &amp; save a chip first.</p>
          ) : (
            <div className="mt-8" style={{ maxHeight: "24vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
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

        <div className="card mt-16">
          <h3>2 · Target chip</h3>
          <input type="text" placeholder="Search chips… e.g. 24C32, 95080, 93C86" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="grid cols-2 mt-8" style={{ maxHeight: "24vh", overflowY: "auto" }}>
            {supportedChips.map((c) => {
              const m = picoModeForChip(c);
              return (
                <button
                  key={c.chipProfileId}
                  className={chipId === c.chipProfileId ? "primary" : ""}
                  style={{ textAlign: "left", padding: 10 }}
                  onClick={() => { setChipId(c.chipProfileId); setConfirmText(""); setResult(null); }}
                >
                  <div style={{ fontWeight: 600 }}>{c.displayName}</div>
                  <div className="tiny dim">MODE {m?.mode} · {m?.label} · {c.sizeBytes.toLocaleString()} B</div>
                </button>
              );
            })}
          </div>
        </div>

        {dump && chip && modeInfo && (
          <div className="card mt-16">
            <h3>3 · Write gate</h3>
            <div className="tiny mt-8" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ width: 14, flex: "0 0 14px" }}>{sizeOk ? "✓" : "✗"}</span>
                <span>Size match — dump {fmtBytes(dump.sizeBytes)} {sizeOk ? "=" : "≠"} chip {fmtBytes(chip.sizeBytes)}</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ width: 14, flex: "0 0 14px" }}>✓</span>
                <span>Target — {modeInfo.label}{isFlash ? " (flash — must be erased to 0xFF before writing)" : " (EEPROM — byte-writable)"}</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ width: 14, flex: "0 0 14px" }}>{verified ? "✓" : "⚠"}</span>
                <span>Source is {verified ? "a verified backup" : "UNVERIFIED — proceed with caution"}</span>
              </div>
            </div>

            {sizeOk ? (
              <>
                <p className="tiny dim mt-12">
                  To arm the write, type the target chip name exactly: <strong>{chip.displayName}</strong>
                </p>
                <input
                  type="text"
                  placeholder={chip.displayName}
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  style={{ width: "100%", marginTop: 8 }}
                />
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
              <p className="tiny mt-8" style={{ color: "var(--danger)" }}>
                Resolve the ✗ checks above before writing.
              </p>
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
                The chip does NOT match the dump. Do not rely on it — reseat, check the chip isn't write-protected, and retry.
              </p>
            )}
          </div>
        )}

        {/* Fun: write arbitrary text to any chip */}
        <div className="card mt-16">
          <h3>📖 Write text to a chip</h3>
          <p className="tiny dim mt-8">
            Paste text (or load a <span className="mono">.txt</span>) and it writes it to the clipped chip,
            then reads it back to prove it landed. Works on EEPROMs and flash — stash a secret in a 24C32
            or a whole book in a 4 MB flash. <strong>EEPROMs never need erasing</strong>; only re-used
            flash does.
          </p>
          <div className="mt-8">
            <div className="tiny dim" style={{ marginBottom: 6 }}>Target chip</div>
            <select value={bookChipId} onChange={(e) => { setBookChipId(e.target.value); setBookResult(null); }} style={{ width: "100%" }}>
              <option value="">— pick the chip you've clipped —</option>
              {supportedChips.map((c) => {
                const m = picoModeForChip(c);
                return <option key={c.chipProfileId} value={c.chipProfileId}>{c.displayName} — MODE {m?.mode} {m?.label} · {c.sizeBytes.toLocaleString()} B</option>;
              })}
            </select>
          </div>
          <textarea
            value={bookText}
            onChange={(e) => setBookText(e.target.value)}
            placeholder="Once upon a time…  (or load a .txt file)"
            rows={6}
            style={{ width: "100%", marginTop: 8 }}
          />
          <div className="row gap-8 mt-8" style={{ alignItems: "center" }}>
            <input type="file" accept=".txt,text/plain" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadTextFile(f); e.target.value = ""; }} />
            <span className="tiny dim">
              {fmtBytes(bookBytes.length)} of text
              {bookChip && ` · target holds ${fmtBytes(bookChip.sizeBytes)}`}
              {bookChip && bookBytes.length > bookChip.sizeBytes && <span style={{ color: "var(--danger)" }}> · too big for this chip!</span>}
            </span>
          </div>
          {bookIsFlash && (
            <div className="mt-12">
              <div className="tiny dim" style={{ marginBottom: 6 }}>Flash operation</div>
              <div className="seg">
                <button className={bookErase ? "active warn" : ""} onClick={() => setBookErase(true)}>⚡ Erase first</button>
                <button className={!bookErase ? "active" : ""} onClick={() => setBookErase(false)}>Skip erase · blank chip</button>
              </div>
            </div>
          )}
          <p className="tiny dim mt-12">Type <strong>{bookWord}</strong> to confirm:</p>
          <input type="text" placeholder={bookWord} value={bookConfirm} onChange={(e) => setBookConfirm(e.target.value)} style={{ width: "100%", marginTop: 8 }} />
          <button
            className="primary mt-12"
            style={{ width: "100%" }}
            onClick={writeBook}
            disabled={bookBusy || !bookFits || bookConfirm.trim() !== bookWord}
          >
            {bookBusy ? "Working…" : bookIsFlash && bookErase ? "Erase · Write · Verify" : "Write · Verify"}
          </button>
          {bookProgress && <p className="tiny mt-8 mono">{bookProgress}</p>}
          {bookError && <p className="tiny mt-8" style={{ color: "var(--danger)" }}>{bookError}</p>}
          {bookResult && (
            <div className="card compact mt-12" style={{ borderColor: bookResult.ok ? "var(--accent)" : "var(--danger)" }}>
              <span className={`badge ${bookResult.ok ? "ok" : "warn"}`}>
                {bookResult.ok ? "✓ written & verified byte-exact" : "✗ read-back mismatch"}
              </span>
              <p className="tiny dim mt-8">First 400 bytes read back from the chip:</p>
              <pre className="mono tiny" style={{ margin: 0, marginTop: 6, maxHeight: "26vh", overflow: "auto", whiteSpace: "pre-wrap" }}>
                {bookResult.text}
              </pre>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
