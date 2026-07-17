import { useEffect, useRef, useState } from "react";

import { Api } from "../../lib/api";

/**
 * Photo gallery for a saved bench module — add pictures of the actual unit (case,
 * connector, PCB, label) so the hookup and identity are grounded in the real part.
 * Backed by the benchModules asset store (same one that keeps the mapped photos).
 */

interface Thumb { id: string; fileName: string; url: string }
const SUPPORTED = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export function ModulePhotos({ moduleId }: { moduleId: string }) {
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Thumb | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const assets = await Api.benchModules.listAssets(moduleId);
      const out: Thumb[] = [];
      for (const a of assets) {
        try { const d = await Api.benchModules.readAsset({ moduleId, assetId: a.id }); out.push({ id: a.id, fileName: a.fileName, url: `data:${d.mediaType};base64,${d.base64}` }); }
        catch { /* skip unreadable */ }
      }
      setThumbs(out);
    } catch (e) { setErr((e as Error).message); }
  }
  useEffect(() => { void load(); }, [moduleId]);

  async function addFiles(files: FileList | null) {
    if (!files) return;
    setBusy(true); setErr(null);
    try {
      for (const f of Array.from(files)) {
        if (!SUPPORTED.includes(f.type)) { setErr("Use JPEG, PNG, GIF or WebP."); continue; }
        const base64 = await new Promise<string>((res, rej) => {
          const rd = new FileReader();
          rd.onload = () => { const s = String(rd.result); res(s.slice(s.indexOf(",") + 1)); };
          rd.onerror = () => rej(new Error("read failed"));
          rd.readAsDataURL(f);
        });
        await Api.benchModules.addAsset({ moduleId, fileName: f.name, base64, mediaType: f.type });
      }
      await load();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function del(id: string) {
    await Api.benchModules.deleteAsset({ moduleId, assetId: id });
    await load();
  }

  return (
    <section className="mp">
      <style>{styles}</style>
      <div className="mp-head">
        <h4>Photos <span className="badge dim">{thumbs.length}</span></h4>
        <button className="tiny primary" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Uploading…" : "＋ Add photos"}</button>
      </div>
      {err && <div className="tiny" style={{ color: "var(--danger)" }}>{err}</div>}
      {thumbs.length === 0
        ? <div className="tiny dim">No photos yet. Add pictures of the module — connector, label, board.</div>
        : (
          <div className="mp-grid">
            {thumbs.map((t) => (
              <div key={t.id} className="mp-thumb">
                <img src={t.url} alt={t.fileName} onClick={() => setZoom(t)} />
                <button className="mp-del" onClick={() => void del(t.id)} title="Delete">✕</button>
              </div>
            ))}
          </div>
        )}
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
      {zoom && (
        <div className="mp-zoom" onClick={() => setZoom(null)}>
          <img src={zoom.url} alt={zoom.fileName} />
        </div>
      )}
    </section>
  );
}

const styles = `
.mp { background: var(--bg-1); border: 1px solid var(--border); border-radius: 12px; padding: 13px 15px; }
.mp-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.mp-head h4 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: var(--fg-2); display: flex; gap: 8px; align-items: center; }
.mp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
.mp-thumb { position: relative; aspect-ratio: 1; border-radius: 10px; overflow: hidden; border: 1px solid var(--border-strong); }
.mp-thumb img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
.mp-del { position: absolute; top: 4px; right: 4px; background: rgba(0,0,0,.6); border: none; color: #fff; border-radius: 50%; width: 22px; height: 22px; cursor: pointer; font-size: 11px; }
.mp-zoom { position: fixed; inset: 0; background: rgba(4,7,12,0.88); display: grid; place-items: center; z-index: 70; padding: 24px; cursor: zoom-out; }
.mp-zoom img { max-width: 92vw; max-height: 92vh; border-radius: 10px; }
`;
