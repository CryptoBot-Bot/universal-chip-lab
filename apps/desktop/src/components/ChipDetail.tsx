import { useEffect, useState } from "react";

import type {
  AccessTypeGuide,
  ChipAsset,
  ChipAssetKind,
  ChipConnectGuide,
  ChipProfile,
  ChipReference,
} from "@ecu/chip-db";
import { accessGuideFor } from "@ecu/chip-db";

import { Api } from "../lib/api";
import { base64ToBytes, hexDump } from "../lib/picoforge";
import { PinoutEditor } from "./PinoutEditor";

const REF_KINDS: NonNullable<ChipReference["kind"]>[] = ["video", "datasheet", "article", "forum", "other"];

const ASSET_KINDS: ChipAssetKind[] = ["instruction", "schematic", "pinout", "solder", "photo", "other"];
const SIM_MAX = 64 * 1024; // cap the simulated preview read so big flash stays snappy

/** The reusable "beautiful guide" card for an access type. */
export function AccessGuideCard({ guide }: { guide: AccessTypeGuide }) {
  const [showRig, setShowRig] = useState(false);
  return (
    <div className="card compact">
      <div className="row gap-8" style={{ alignItems: "baseline" }}>
        <span style={{ fontSize: 20 }}>{guide.icon}</span>
        <div>
          <strong>{guide.label}</strong>
          <div className="tiny dim">{guide.tagline}</div>
        </div>
      </div>
      <div className="tiny mt-8">
        {guide.buses.map((b) => (
          <span key={b} className="badge tiny info" style={{ marginRight: 4 }}>{b}</span>
        ))}
      </div>
      <p className="tiny dim mt-8">{guide.whenToUse}</p>
      <div className="tiny mt-8"><strong>Connect</strong></div>
      <ol className="tiny dim" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
        {guide.steps.map((s, i) => <li key={i} style={{ marginBottom: 2 }}>{s}</li>)}
      </ol>
      <div className="tiny mt-8" style={{ color: "var(--warn)" }}><strong>Cautions</strong></div>
      <ul className="tiny" style={{ margin: "4px 0 0", paddingLeft: 18, color: "var(--warn)" }}>
        {guide.cautions.map((c, i) => <li key={i} style={{ marginBottom: 2 }}>{c}</li>)}
      </ul>
      <button className="tiny ghost mt-8" onClick={() => setShowRig((s) => !s)}>
        🧰 {showRig ? "Hide" : "Build your own rig — what to buy & assemble"}
      </button>
      {showRig && (
        <div className="mt-8">
          <div className="tiny"><strong>Shopping list</strong></div>
          <ul className="tiny dim" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {guide.buildYourRig.bom.map((b, i) => <li key={i} style={{ marginBottom: 2 }}>{b}</li>)}
          </ul>
          <div className="tiny mt-8"><strong>Assemble</strong></div>
          <ol className="tiny dim" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {guide.buildYourRig.assembly.map((a, i) => <li key={i} style={{ marginBottom: 2 }}>{a}</li>)}
          </ol>
        </div>
      )}
    </div>
  );
}

function AssetThumb({ chipId, asset, onDelete }: { chipId: string; asset: ChipAsset; onDelete: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Api.chips
      .readAsset({ chipProfileId: chipId, assetId: asset.id })
      .then((r) => { if (alive) setUrl(`data:${r.mediaType};base64,${r.base64}`); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [chipId, asset.id]);
  return (
    <div className="card compact" style={{ padding: 6, width: 150 }}>
      <div style={{ height: 96, background: "var(--border)", borderRadius: 4, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", cursor: url ? "zoom-in" : "default" }}
           onClick={() => url && window.open(url, "_blank")}>
        {url ? <img src={url} alt={asset.fileName} style={{ maxWidth: "100%", maxHeight: "100%" }} /> : <span className="tiny dim">loading…</span>}
      </div>
      <div className="tiny mt-8"><span className="badge tiny">{asset.kind}</span></div>
      {asset.caption && <div className="tiny dim" style={{ marginTop: 2 }}>{asset.caption}</div>}
      <button className="tiny ghost" style={{ marginTop: 4, width: "100%" }} onClick={onDelete}>Delete</button>
    </div>
  );
}

export function ChipDetail({ chip: initialChip, onChanged }: { chip: ChipProfile; onChanged?: () => void }) {
  // Live profile state so in-panel edits (pinout, references) reflect instantly.
  const [chip, setChip] = useState<ChipProfile>(initialChip);
  useEffect(() => setChip(initialChip), [initialChip]);
  const access = accessGuideFor(chip);

  // --- simulate
  const [simBusy, setSimBusy] = useState(false);
  const [simErr, setSimErr] = useState<string | null>(null);
  const [sim, setSim] = useState<{ preview: string; read: number; total: number; ms: number } | null>(null);

  async function simulate() {
    setSimBusy(true);
    setSimErr(null);
    try {
      const len = Math.min(chip.sizeBytes, SIM_MAX);
      const { base64, durationMs } = await Api.adapters.read({ id: "mock_adapter", chipProfile: chip, length: len, tag: "db-simulate" });
      const bytes = base64ToBytes(base64);
      setSim({ preview: hexDump(bytes, 12), read: bytes.length, total: chip.sizeBytes, ms: durationMs });
    } catch (e) {
      setSimErr((e as Error).message);
    } finally {
      setSimBusy(false);
    }
  }

  // --- AI guide (cached load on open; generate on demand)
  const [guide, setGuide] = useState<ChipConnectGuide | null>(null);
  const [guideBusy, setGuideBusy] = useState(false);
  const [guideErr, setGuideErr] = useState<string | null>(null);
  useEffect(() => {
    setGuide(null);
    Api.chips.guide({ chipProfileId: chip.chipProfileId }).then(setGuide).catch(() => undefined);
  }, [chip.chipProfileId]);

  async function genGuide() {
    setGuideBusy(true);
    setGuideErr(null);
    try {
      setGuide(await Api.chips.guide({ chipProfileId: chip.chipProfileId, generate: true }));
    } catch (e) {
      setGuideErr((e as Error).message);
    } finally {
      setGuideBusy(false);
    }
  }

  // --- instruction images
  const [assets, setAssets] = useState<ChipAsset[]>([]);
  const [kind, setKind] = useState<ChipAssetKind>("instruction");
  const [caption, setCaption] = useState("");
  const [upErr, setUpErr] = useState<string | null>(null);
  function refreshAssets() {
    Api.chips.listAssets(chip.chipProfileId).then(setAssets).catch(() => undefined);
  }
  useEffect(refreshAssets, [chip.chipProfileId]);

  async function upload(file: File) {
    setUpErr(null);
    try {
      const dataUrl = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = () => rej(new Error("Could not read file."));
        r.readAsDataURL(file);
      });
      const mediaType = dataUrl.substring(5, dataUrl.indexOf(";"));
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      await Api.chips.addAsset({ chipProfileId: chip.chipProfileId, fileName: file.name, base64, mediaType, kind, ...(caption ? { caption } : {}) });
      setCaption("");
      refreshAssets();
    } catch (e) {
      setUpErr((e as Error).message);
    }
  }

  async function removeAsset(id: string) {
    await Api.chips.deleteAsset({ chipProfileId: chip.chipProfileId, assetId: id }).catch(() => undefined);
    refreshAssets();
  }

  // --- reference / video links (stored on the profile, so they travel with it)
  const [refLabel, setRefLabel] = useState("");
  const [refUrl, setRefUrl] = useState("");
  const [refKind, setRefKind] = useState<NonNullable<ChipReference["kind"]>>("video");
  const [refErr, setRefErr] = useState<string | null>(null);

  async function saveReferences(next: ChipReference[]) {
    setRefErr(null);
    try {
      const saved = await Api.chips.saveProfile({ ...chip, references: next });
      setChip(saved);
      onChanged?.();
    } catch (e) {
      setRefErr((e as Error).message);
    }
  }
  function addReference() {
    const url = refUrl.trim();
    if (!url) return;
    const label = refLabel.trim() || url.replace(/^https?:\/\//, "").slice(0, 60);
    void saveReferences([...(chip.references ?? []), { label, url, kind: refKind }]);
    setRefLabel("");
    setRefUrl("");
  }
  function removeReference(idx: number) {
    void saveReferences((chip.references ?? []).filter((_, i) => i !== idx));
  }
  function findVideos() {
    const q = encodeURIComponent(`${chip.displayName} ${chip.package} read eeprom`);
    window.open(`https://www.youtube.com/results?search_query=${q}`, "_blank");
  }

  return (
    <div className="grid" style={{ gap: 12, padding: "8px 2px" }}>
      {/* Access + Simulate side by side */}
      <div className="grid cols-2" style={{ gap: 12, alignItems: "start" }}>
        <AccessGuideCard guide={access} />

        <div className="card compact">
          <div className="row spread" style={{ alignItems: "center" }}>
            <strong>▶ Simulate operation</strong>
            <button className="tiny primary" onClick={simulate} disabled={simBusy}>
              {simBusy ? "Reading…" : "Simulate read"}
            </button>
          </div>
          <p className="tiny dim mt-8">
            Runs a real read against the software Simulator (no hardware) so you can see exactly what this
            operation looks like — deterministic, repeatable bytes for {chip.displayName}.
          </p>
          {simErr && <p className="tiny mt-8" style={{ color: "var(--danger)" }}>{simErr}</p>}
          {sim && (
            <>
              <p className="tiny dim mt-8 mono">
                read {sim.read.toLocaleString()} / {sim.total.toLocaleString()} B · {sim.ms} ms · simulated
              </p>
              <pre className="mono tiny" style={{ margin: 0, marginTop: 6, maxHeight: "26vh", overflow: "auto" }}>{sim.preview}</pre>
              {sim.total > sim.read && <p className="tiny dim mt-8">Preview capped at {SIM_MAX.toLocaleString()} B — full size {sim.total.toLocaleString()} B.</p>}
            </>
          )}
        </div>
      </div>

      {/* Pinout — visual editable engine */}
      <PinoutEditor chip={chip} onSaved={(p) => { setChip(p); onChanged?.(); }} />

      {/* AI connect/solder guide */}
      <div className="card compact">
        <div className="row spread" style={{ alignItems: "center" }}>
          <strong>🤖 AI connection & soldering guide</strong>
          <button className="tiny" onClick={genGuide} disabled={guideBusy}>
            {guideBusy ? "Generating…" : guide ? "Regenerate" : "Generate guide"}
          </button>
        </div>
        {guideErr && <p className="tiny mt-8" style={{ color: "var(--danger)" }}>{guideErr}</p>}
        {!guide && !guideBusy && !guideErr && (
          <p className="tiny dim mt-8">No guide yet. Generate a part-specific wiring + soldering guide (uses your Anthropic key from Settings).</p>
        )}
        {guide && (
          <div className="mt-8">
            <p className="tiny">{guide.summary}</p>
            <p className="tiny mt-8"><strong>Find pin 1:</strong> <span className="dim">{guide.pin1}</span></p>
            {guide.asciiPinout && (
              <pre className="mono tiny" style={{ margin: "8px 0", padding: 8, background: "var(--border)", borderRadius: 4, overflow: "auto" }}>{guide.asciiPinout}</pre>
            )}
            {guide.wiring.length > 0 && (
              <table className="table tiny mt-8">
                <thead><tr><th>Pin</th><th>Signal</th><th>Connect to</th><th>Note</th></tr></thead>
                <tbody>
                  {guide.wiring.map((w, i) => (
                    <tr key={i}>
                      <td className="mono">{w.pin}</td>
                      <td>{w.signal}</td>
                      <td className="mono">{w.connectTo}</td>
                      <td className="tiny dim">{w.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {guide.soldering.length > 0 && (
              <>
                <div className="tiny mt-8"><strong>Soldering</strong></div>
                <ul className="tiny dim" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {guide.soldering.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </>
            )}
            {guide.cautions.length > 0 && (
              <>
                <div className="tiny mt-8" style={{ color: "var(--warn)" }}><strong>Cautions</strong></div>
                <ul className="tiny" style={{ margin: "4px 0 0", paddingLeft: 18, color: "var(--warn)" }}>
                  {guide.cautions.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </>
            )}
            {guide.toolNotes && <p className="tiny dim mt-8">{guide.toolNotes}</p>}
            <p className="tiny dim mt-8" style={{ opacity: 0.6 }}>
              AI-generated {guide.generatedAt?.slice(0, 10)} · {guide.model} · verify against the datasheet before trusting.
            </p>
          </div>
        )}
      </div>

      {/* Instruction images */}
      <div className="card compact">
        <strong>📷 Instruction images</strong>
        <p className="tiny dim mt-8">
          Upload your own reference shots — pinout diagrams, schematics, solder photos, clip placement.
          They're stored in your workspace and grow with you.
        </p>
        <div className="row gap-8 mt-8" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <select value={kind} onChange={(e) => setKind(e.target.value as ChipAssetKind)}>
            {ASSET_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <input type="text" placeholder="caption (optional)" value={caption} onChange={(e) => setCaption(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
          <label className="tiny primary" style={{ padding: "6px 10px", borderRadius: 4, cursor: "pointer" }}>
            Upload image
            <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
          </label>
        </div>
        {upErr && <p className="tiny mt-8" style={{ color: "var(--danger)" }}>{upErr}</p>}
        {assets.length === 0 ? (
          <p className="tiny dim mt-8">No images yet.</p>
        ) : (
          <div className="row gap-8 mt-12" style={{ flexWrap: "wrap" }}>
            {assets.map((a) => <AssetThumb key={a.id} chipId={chip.chipProfileId} asset={a} onDelete={() => removeAsset(a.id)} />)}
          </div>
        )}
      </div>

      {/* Reference / video links */}
      <div className="card compact">
        <div className="row spread" style={{ alignItems: "center" }}>
          <strong>🔗 Reference & video links</strong>
          <button className="tiny" onClick={findVideos} title="Open a YouTube search for this part">▶ Find videos</button>
        </div>
        <p className="tiny dim mt-8">
          Save tutorials, datasheets and write-ups for this chip. Links live on the profile, so they travel with
          it (and ship if you bake it into the catalog). <strong>Find videos</strong> opens a YouTube search you
          can pick from — we don't guess URLs.
        </p>
        <div className="row gap-8 mt-8" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <select value={refKind} onChange={(e) => setRefKind(e.target.value as NonNullable<ChipReference["kind"]>)}>
            {REF_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <input type="text" placeholder="label (optional)" value={refLabel} onChange={(e) => setRefLabel(e.target.value)} style={{ width: 160 }} />
          <input type="text" placeholder="https://…" value={refUrl} onChange={(e) => setRefUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addReference(); }} style={{ flex: 1, minWidth: 180 }} />
          <button className="tiny primary" onClick={addReference} disabled={!refUrl.trim()}>Add link</button>
        </div>
        {refErr && <p className="tiny mt-8" style={{ color: "var(--danger)" }}>{refErr}</p>}
        {(chip.references ?? []).length === 0 ? (
          <p className="tiny dim mt-8">No links yet.</p>
        ) : (
          <ul className="tiny" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {(chip.references ?? []).map((r, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                <span className="badge tiny" style={{ marginRight: 6 }}>{r.kind ?? "other"}</span>
                <a href={r.url} target="_blank" rel="noreferrer">{r.label}</a>
                <button className="tiny ghost" style={{ marginLeft: 8 }} onClick={() => removeReference(i)}>remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
