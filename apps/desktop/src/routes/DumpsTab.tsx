import { useEffect, useMemo, useState } from "react";

import { Topbar } from "../components/Topbar";
import { Api, type DumpEntry } from "../lib/api";
import { base64ToBytes, hexDump } from "../lib/picoforge";

type ViewMode = "hex" | "text" | "strings";
type ExportFmt = "hex" | "strings" | "text" | "md" | "json";

const EXPORTS: { fmt: ExportFmt; label: string; ext: string }[] = [
  { fmt: "strings", label: "Strings", ext: ".strings.txt" },
  { fmt: "text", label: "Text", ext: ".txt" },
  { fmt: "hex", label: "Hex dump", ext: ".hex.txt" },
  { fmt: "md", label: "Report", ext: ".md" },
  { fmt: "json", label: "JSON", ext: ".readable.json" },
];

function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(2)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function textOf(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) s += String.fromCharCode(b);
  }
  return s || "(no printable text in this region)";
}
function stringsOf(bytes: Uint8Array, minLen = 4): string {
  const out: string[] = [];
  let start = -1;
  let cur = "";
  for (let i = 0; i <= bytes.length; i++) {
    const b = i < bytes.length ? bytes[i] : -1;
    if (b >= 0x20 && b < 0x7f) {
      if (start < 0) start = i;
      cur += String.fromCharCode(b);
    } else {
      if (cur.length >= minLen) out.push(`${start.toString(16).padStart(8, "0")}  ${cur}`);
      start = -1;
      cur = "";
    }
  }
  return out.length ? out.join("\n") : "(no strings ≥ 4 chars in this region)";
}

export function DumpsTab() {
  const [dumps, setDumps] = useState<DumpEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("strings");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    try {
      setDumps(await Api.pico.listDumps());
    } catch (err) {
      setMsg((err as Error).message);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  const previewText = useMemo(() => {
    if (!previewBytes) return "";
    if (viewMode === "hex") return hexDump(previewBytes, 256);
    if (viewMode === "text") return textOf(previewBytes);
    return stringsOf(previewBytes);
  }, [previewBytes, viewMode]);

  async function view(name: string) {
    setBusy(true);
    setMsg(null);
    setSelected(name);
    setPreviewBytes(null);
    try {
      const { base64 } = await Api.pico.readDump({ name, offset: 0, length: 16384 });
      setPreviewBytes(base64ToBytes(base64));
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportAs(name: string, fmt: ExportFmt) {
    setBusy(true);
    try {
      const res = await Api.pico.exportDump(name, fmt);
      setMsg(`Wrote ${res.path}`);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    if (!confirm(`Delete dump "${name}"? Removes the .bin and its sidecars.`)) return;
    setBusy(true);
    try {
      await Api.pico.deleteDump(name);
      if (selected === name) { setSelected(null); setPreviewBytes(null); }
      await refresh();
      setMsg(`Deleted ${name}.`);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Topbar title="Dumps" crumb={`${dumps.length} saved`} actions={<button onClick={refresh}>Refresh</button>} />
      <div className="content">
        {msg && <div className="legal-banner mono" style={{ wordBreak: "break-all" }}>{msg}</div>}

        {dumps.length === 0 ? (
          <div className="card">
            <h3>No dumps yet</h3>
            <p className="tiny dim mt-8">Read a chip in the <strong>Read</strong> tab and Save it — verified backups land here.</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {dumps.map((d) => {
              const verified = d.meta.verified === true;
              const open = selected === d.name;
              return (
                <div key={d.name} className="card" style={{ borderColor: open ? "var(--accent)" : undefined }}>
                  <div className="row spread">
                    <div>
                      <strong>{str(d.meta.displayName) || d.name}</strong>{" "}
                      <span className={`badge tiny ${verified ? "ok" : "warn"}`}>{verified ? "✓ verified" : "unverified"}</span>
                      <div className="tiny dim mt-8">
                        {str(d.meta.mode) || "?"} · {fmtBytes(d.sizeBytes)}
                        {d.savedAt ? ` · ${d.savedAt.replace("T", " ").slice(0, 19)}` : ""}
                      </div>
                      <div className="tiny dim mono">SHA-256 {str(d.meta.sha256).slice(0, 24) || "—"}…</div>
                    </div>
                    <div className="row gap-8">
                      <button className="tiny" onClick={() => (open ? (setSelected(null), setPreviewBytes(null)) : view(d.name))} disabled={busy}>
                        {open ? "Close" : "View"}
                      </button>
                      <button className="tiny" onClick={() => remove(d.name)} disabled={busy}>Delete</button>
                    </div>
                  </div>

                  {open && (
                    <div className="mt-12">
                      <div className="row spread">
                        <div className="seg">
                          {(["strings", "text", "hex"] as ViewMode[]).map((m) => (
                            <button key={m} className={viewMode === m ? "active" : ""} onClick={() => setViewMode(m)}>
                              {m === "strings" ? "Strings" : m === "text" ? "Text" : "Hex"}
                            </button>
                          ))}
                        </div>
                        <span className="tiny dim">preview of first {fmtBytes(Math.min(16384, d.sizeBytes))}</span>
                      </div>
                      <pre className="mono tiny" style={{ margin: 0, marginTop: 10, maxHeight: "40vh", overflow: "auto", whiteSpace: "pre-wrap" }}>
                        {previewBytes ? previewText : "loading…"}
                      </pre>
                      <div className="row wrap gap-8 mt-12">
                        <span className="tiny dim" style={{ alignSelf: "center" }}>Export full dump →</span>
                        {EXPORTS.map((e) => (
                          <button key={e.fmt} className="tiny" onClick={() => exportAs(d.name, e.fmt)} disabled={busy} title={`${d.name}${e.ext}`}>
                            {e.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
