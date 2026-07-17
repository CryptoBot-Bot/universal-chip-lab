import { useEffect, useRef, useState } from "react";

import { benchModuleId, type BenchModuleProfile } from "@ecu/vehicle-db";

import { Topbar } from "../components/Topbar";
import { ModuleCockpit } from "../components/bench/ModuleCockpit";
import { Api, type ModuleMapResult } from "../lib/api";

/**
 * Bench Module Master — the workbench for a control module you're holding in your
 * hand. Two places only: IDENTIFY (photo + description → AI hookup map, saved to the
 * library) and the WORKSPACE (one page: visualised hook-up → connect the Super Device
 * → AI-explorer run history → live diagnostics). Real hardware only. Every run sharpens
 * the stored map of that exact unit, growing a self-building library.
 */

type Stage = "identify" | "workspace";
type SupportedMedia = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const SUPPORTED: SupportedMedia[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

interface PhotoInput { data: string; mediaType: SupportedMedia; url: string; name: string }

function fileToPhoto(file: File): Promise<PhotoInput | null> {
  return new Promise((resolve) => {
    if (!SUPPORTED.includes(file.type as SupportedMedia)) { resolve(null); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result);
      const comma = res.indexOf(",");
      resolve({ data: res.slice(comma + 1), mediaType: file.type as SupportedMedia, url: res, name: file.name });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** Turn a fresh AI map into an ai_suggested profile (untrusted until bench-verified). */
export function draftToProfile(d: ModuleMapResult): BenchModuleProfile {
  const id = benchModuleId(d.brand, d.displayName) || `module-${Date.now()}`;
  return {
    id,
    displayName: d.displayName,
    brand: d.brand,
    category: d.category,
    partNumbers: d.partNumbers,
    applications: d.applications,
    powerNote: d.powerNote,
    hookup: d.hookup,
    buses: d.buses,
    asciiConnector: d.asciiConnector,
    cautions: d.cautions,
    references: d.references,
    diagnostics: {
      simTemplateKey: d.category,
      sessions: [],
      sampleServices: [],
      knownDtcs: d.knownDtcs,
      capabilities: d.capabilities,
    },
    provenance: {
      source: "ai_resolved",
      confidence: "ai_suggested",
      createdAt: new Date().toISOString(),
      notes: d.rationale,
      evidence: { model: "claude-opus-4-8", markings: d.partNumbers.join(", ") || undefined },
    },
  };
}

export function BenchTab() {
  const [library, setLibrary] = useState<BenchModuleProfile[]>([]);
  const [stage, setStage] = useState<Stage>("identify");
  const [active, setActive] = useState<BenchModuleProfile | null>(null);
  const [, setActiveSaved] = useState(false); // tracks whether `active` is persisted (setters keep library in sync)

  // identify inputs
  const [photos, setPhotos] = useState<PhotoInput[]>([]);
  const [desc, setDesc] = useState("");
  const [mapping, setMapping] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [bakeMsg, setBakeMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function refreshLibrary() {
    try { setLibrary(await Api.benchModules.list()); } catch { /* empty until first save */ }
  }
  useEffect(() => { void refreshLibrary(); }, []);

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const out: PhotoInput[] = [];
    let skipped = 0;
    for (const f of Array.from(files)) {
      const p = await fileToPhoto(f);
      if (p) out.push(p); else skipped++;
    }
    setPhotos((prev) => [...prev, ...out]);
    if (skipped) setErr(`Skipped ${skipped} file(s) — use JPEG, PNG, GIF or WebP.`);
  }

  async function runMapper() {
    if (photos.length === 0 && !desc.trim()) { setErr("Add a photo of the module, or type what it is."); return; }
    setMapping(true); setErr(null);
    try {
      const result = await Api.benchModules.analyze({
        images: photos.map((p) => ({ data: p.data, mediaType: p.mediaType })),
        description: desc,
      });
      const profile = draftToProfile(result);
      // Save the fresh draft straight into the library so it's never orphaned — it
      // lands in the workspace as an "AI draft" you verify (or delete) on the bench.
      await saveActive(profile);
      setStage("workspace");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setMapping(false);
    }
  }

  function openSaved(m: BenchModuleProfile) {
    setActive(m); setActiveSaved(true); setStage("workspace");
  }

  async function saveActive(next: BenchModuleProfile): Promise<void> {
    const saved = await Api.benchModules.save(next);
    setLibrary(saved);
    setActive(next);
    setActiveSaved(true);
    // attach the photos we mapped from, once, as the module's gallery — then clear
    // them so later saves (connector edits, explorer applies) don't re-upload dupes.
    if (photos.length) {
      for (const p of photos) {
        try { await Api.benchModules.addAsset({ moduleId: next.id, fileName: p.name, base64: p.data, mediaType: p.mediaType }); }
        catch { /* non-fatal */ }
      }
      setPhotos([]);
    }
  }

  async function deleteModule(m: BenchModuleProfile, e: React.MouseEvent) {
    e.stopPropagation();
    const isSeed = m.provenance.source === "seed";
    const msg = isSeed
      ? `Reset "${m.displayName}"?\n\nThis is a shipped reference module — deleting removes your learned edits and restores the pristine seed.`
      : `Delete "${m.displayName}" from your library?\n\nThis permanently removes the saved module and its explorer runs stay on disk.`;
    if (!window.confirm(msg)) return;
    try {
      const r = await Api.benchModules.delete(m.id);
      setLibrary(r.records);
      if (active?.id === m.id) { setActive(null); setActiveSaved(false); setStage("identify"); }
    } catch (err) { setErr((err as Error).message); }
  }

  function newModule() {
    setActive(null); setActiveSaved(false); setPhotos([]); setDesc(""); setErr(null); setStage("identify");
  }

  const crumb = stage === "identify" ? "Identify a module" : active?.displayName ?? "Module workspace";

  return (
    <>
      <Topbar title="Bench Module Master" crumb={crumb} actions={
        <button className="tiny" onClick={newModule}>+ New module</button>
      } />
      <div className="content bm-wrap">
        <style>{styles}</style>

        <aside className="bm-lib">
          <div className="bm-lib-head">Module library <span className="badge dim">{library.length}</span></div>
          <button className={`bm-lib-new ${stage === "identify" ? "on" : ""}`} onClick={newModule}>＋ Identify a new module</button>
          <div className="bm-lib-list">
            {library.length === 0 && <div className="tiny dim" style={{ padding: "8px 4px" }}>No modules yet. Map your first one →</div>}
            {library.map((m) => (
              <div key={m.id} className={`bm-lib-item ${active?.id === m.id ? "sel" : ""}`} onClick={() => openSaved(m)} role="button" tabIndex={0}>
                <span className="bm-li-name">{m.displayName}</span>
                <span className="bm-li-sub">{m.brand} · {m.category.toUpperCase()}</span>
                <TrustPill confidence={m.provenance.confidence} />
                <button className="bm-li-del" title={m.provenance.source === "seed" ? "Reset to shipped seed" : "Delete module"}
                  onClick={(e) => void deleteModule(m, e)}>✕</button>
              </div>
            ))}
          </div>
          <div className="bm-lib-foot">
            <button className="tiny" title="Fold your saved modules into the shipped catalog (dev builds only)"
              onClick={async () => {
                setBakeMsg("Baking…");
                try { const r = await Api.benchModules.bake(); setBakeMsg(`Baked ${r.count} module(s) into the shipped catalog.`); }
                catch (e) { setBakeMsg((e as Error).message); }
              }}>⤓ Bake to catalog</button>
            {bakeMsg && <div className="tiny dim" style={{ marginTop: 6 }}>{bakeMsg}</div>}
          </div>
        </aside>

        <main className="bm-main">
          {stage === "identify" && (
            <IdentifyPanel
              photos={photos} desc={desc} mapping={mapping} err={err}
              onDesc={setDesc} onPick={() => fileRef.current?.click()}
              onRemove={(i) => setPhotos((p) => p.filter((_, k) => k !== i))}
              onMap={runMapper}
              onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer.files); }}
            />
          )}
          {stage === "workspace" && active && (
            <ModuleCockpit
              profile={active}
              onBack={() => setStage("identify")}
              onUpdate={saveActive}
              onBenchVerified={async () => {
                const promoted: BenchModuleProfile = {
                  ...active,
                  provenance: {
                    ...active.provenance,
                    source: active.provenance.source === "seed" ? "seed" : "operator",
                    confidence: "bench_verified",
                    evidence: { ...active.provenance.evidence, observedOn: "bench (real comms confirmed)" },
                  },
                };
                await saveActive(promoted);
              }}
            />
          )}
        </main>
      </div>

      <input ref={fileRef} type="file" accept="image/*" multiple hidden
        onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
    </>
  );
}

// ---- identify landing --------------------------------------------------------

function IdentifyPanel(props: {
  photos: PhotoInput[]; desc: string; mapping: boolean; err: string | null;
  onDesc: (v: string) => void; onPick: () => void; onRemove: (i: number) => void;
  onMap: () => void; onDrop: (e: React.DragEvent) => void;
}) {
  const { photos, desc, mapping, err } = props;
  return (
    <div className="bm-identify">
      <div className="bm-hero">
        <h2>What module are you holding?</h2>
        <p className="dim">Photograph the connector, the label, and the board. Type the model or part number if you know it. The AI maps how to power it and wire CAN so you can bring it up on the bench.</p>
      </div>

      <div className="bm-drop" onClick={props.onPick} onDragOver={(e) => e.preventDefault()} onDrop={props.onDrop}>
        {photos.length === 0 ? (
          <>
            <div className="bm-drop-ico">📷</div>
            <div><b>Drop photos here</b> or click to choose</div>
            <div className="tiny dim">Connector + label + PCB give the best map · JPEG/PNG/GIF/WebP</div>
          </>
        ) : (
          <div className="bm-thumbs" onClick={(e) => e.stopPropagation()}>
            {photos.map((p, i) => (
              <div key={i} className="bm-thumb">
                <img src={p.url} alt={p.name} />
                <button className="bm-thumb-x" onClick={() => props.onRemove(i)} title="Remove">✕</button>
              </div>
            ))}
            <button className="bm-thumb-add" onClick={props.onPick}>＋</button>
          </div>
        )}
      </div>

      <label className="bm-field">
        <span className="tiny dim">Model / part number / vehicle (optional but helps)</span>
        <textarea rows={3} value={desc} onChange={(e) => props.onDesc(e.target.value)}
          placeholder="e.g. Bosch ME7.9.7 ECU from a 2006 VW Golf, or the part number 06A906032… — anything you can read off the label." />
      </label>

      {err && <div className="bm-err">{err}</div>}

      <div className="row" style={{ gap: 10 }}>
        <button className="primary bm-map" disabled={mapping} onClick={props.onMap}>
          {mapping ? "Mapping the module…" : "🧠 Map this module"}
        </button>
        <span className="tiny dim">Uses the AI mapper (needs your Anthropic key in Settings).</span>
      </div>

      <div className="bm-safety tiny">
        ⚠ Always confirm pin 1 and check continuity with a meter before applying 12 V — a wrong power/ground pin can destroy the module. Lawful repair &amp; recovery only.
      </div>
    </div>
  );
}

function TrustPill({ confidence }: { confidence: BenchModuleProfile["provenance"]["confidence"] }) {
  const map = {
    bench_verified: { t: "verified", c: "ok" },
    ai_suggested: { t: "AI draft", c: "warn" },
    unverified: { t: "unverified", c: "dim" },
  } as const;
  const m = map[confidence];
  return <span className={`badge ${m.c} bm-li-trust`}>{m.t}</span>;
}

export const TRUST_LABEL: Record<BenchModuleProfile["provenance"]["confidence"], string> = {
  bench_verified: "Bench-verified",
  ai_suggested: "AI draft — verify on the bench",
  unverified: "Unverified",
};

const styles = `
.bm-wrap { display: grid; grid-template-columns: 240px 1fr; gap: 0; padding: 0; height: calc(100vh - 52px); overflow: hidden; }
.bm-lib { border-right: 1px solid var(--border); padding: 14px 12px; display: flex; flex-direction: column; gap: 10px; overflow: hidden; background: var(--bg-1); }
.bm-lib-head { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--fg-2); display: flex; align-items: center; gap: 6px; }
.bm-lib-new { text-align: left; background: var(--bg-2); border: 1px dashed var(--border-strong); border-radius: 8px; padding: 8px 10px; font-size: 12px; color: var(--fg-1); cursor: pointer; }
.bm-lib-new.on, .bm-lib-new:hover { border-color: var(--accent); color: var(--accent); }
.bm-lib-list { display: flex; flex-direction: column; gap: 6px; overflow-y: auto; flex: 1; }
.bm-lib-foot { border-top: 1px solid var(--border); padding-top: 8px; }
.bm-lib-item { position: relative; text-align: left; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
.bm-lib-item:hover { border-color: var(--border-strong); }
.bm-lib-item.sel { border-color: var(--accent); }
.bm-li-del { position: absolute; top: 6px; right: 6px; width: 20px; height: 20px; border-radius: 5px; border: 1px solid transparent; background: transparent; color: var(--fg-2); font-size: 12px; line-height: 1; cursor: pointer; opacity: 0; transition: opacity .12s, background .12s, color .12s; }
.bm-lib-item:hover .bm-li-del { opacity: 1; }
.bm-li-del:hover { background: var(--danger-dim); color: var(--danger); border-color: var(--danger); }
.bm-li-name { font-size: 13px; color: var(--fg-0); }
.bm-li-sub { font-size: 11px; color: var(--fg-2); }
.bm-li-trust { position: absolute; top: 8px; right: 8px; }
.bm-main { overflow-y: auto; padding: 20px 24px; }

.bm-identify { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.bm-hero h2 { margin: 0 0 6px; font-size: 22px; }
.bm-hero p { margin: 0; font-size: 13px; max-width: 60ch; }
.bm-drop { border: 2px dashed var(--border-strong); border-radius: 14px; padding: 26px; text-align: center; cursor: pointer; background: var(--bg-1); display: flex; flex-direction: column; align-items: center; gap: 8px; transition: border-color .15s; }
.bm-drop:hover { border-color: var(--accent); }
.bm-drop-ico { font-size: 34px; }
.bm-thumbs { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
.bm-thumb { position: relative; width: 108px; height: 108px; border-radius: 10px; overflow: hidden; border: 1px solid var(--border-strong); }
.bm-thumb img { width: 100%; height: 100%; object-fit: cover; }
.bm-thumb-x { position: absolute; top: 3px; right: 3px; background: rgba(0,0,0,.6); border: none; color: #fff; border-radius: 50%; width: 20px; height: 20px; cursor: pointer; font-size: 11px; }
.bm-thumb-add { width: 108px; height: 108px; border-radius: 10px; border: 1px dashed var(--border-strong); background: var(--bg-2); color: var(--fg-2); font-size: 26px; cursor: pointer; }
.bm-field { display: flex; flex-direction: column; gap: 5px; }
.bm-field textarea { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; color: var(--fg-0); padding: 10px 12px; font-size: 13px; font-family: var(--sans); resize: vertical; }
.bm-map { font-size: 14px; padding: 10px 18px; }
.bm-err { font-size: 12px; color: var(--danger); background: var(--danger-dim); border: 1px solid var(--danger); border-radius: 8px; padding: 8px 11px; }
.bm-safety { color: var(--warn); background: var(--warn-dim); border: 1px solid rgba(251,191,36,.35); border-radius: 8px; padding: 8px 11px; }
`;
