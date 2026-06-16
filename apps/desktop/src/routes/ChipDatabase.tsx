import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import type { AccessType, ChipConfidence, ChipProfile } from "@ecu/chip-db";
import {
  ACCESS_TYPES,
  accessTypeForChip,
  effectiveProvenance,
  primaryToolForChip,
  TOOLS,
} from "@ecu/chip-db";

import { AccessGuideCard, ChipDetail } from "../components/ChipDetail";
import { Topbar } from "../components/Topbar";
import { Api } from "../lib/api";

const CONFIDENCE_TONE: Record<ChipConfidence, string> = {
  unverified: "",
  ai_suggested: "warn",
  bench_verified: "ok",
  clone_proven: "ok",
};
const CONFIDENCE_LABEL: Record<ChipConfidence, string> = {
  unverified: "unverified",
  ai_suggested: "AI-suggested",
  bench_verified: "bench-verified",
  clone_proven: "clone-proven",
};

type AccessFilter = "all" | AccessType;
const TOOL_LABEL: Record<string, string> = Object.fromEntries(TOOLS.map((t) => [t.id, t.label]));

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export function ChipDatabase() {
  const [chips, setChips] = useState<ChipProfile[]>([]);
  const [query, setQuery] = useState("");
  const [accessFilter, setAccessFilter] = useState<AccessFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  // AI scaffolder ("type a part number → get a chip")
  const [addName, setAddName] = useState("");
  const [addNotes, setAddNotes] = useState("");
  const [scaffolding, setScaffolding] = useState(false);
  const [draft, setDraft] = useState<ChipProfile | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);

  function refresh() {
    Api.chips.list().then(setChips).catch(() => undefined);
  }
  useEffect(refresh, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return chips.filter((c) => {
      if (accessFilter !== "all" && accessTypeForChip(c) !== accessFilter) return false;
      if (!q) return true;
      return [c.chipProfileId, c.displayName, c.manufacturer ?? "", c.family, c.protocol, c.package]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [chips, query, accessFilter]);

  const groups = useMemo(
    () =>
      ACCESS_TYPES.map((access) => ({
        access,
        chips: filtered.filter((c) => accessTypeForChip(c) === access.id),
      })).filter((g) => g.chips.length > 0),
    [filtered],
  );

  const accessCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of chips) {
      const a = accessTypeForChip(c);
      m[a] = (m[a] ?? 0) + 1;
    }
    return m;
  }, [chips]);

  const customCount = chips.filter((c) => effectiveProvenance(c).source !== "seed").length;

  async function exportLibrary() {
    try {
      const profiles = await Api.chips.exportLibrary();
      if (profiles.length === 0) {
        setMessage("No custom (resolved/operator) profiles to export yet.");
        return;
      }
      const blob = new Blob([JSON.stringify(profiles, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "chip-library.json";
      a.click();
      URL.revokeObjectURL(url);
      setMessage(`Exported ${profiles.length} profile(s) to chip-library.json.`);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  async function bakeCatalog() {
    if (!window.confirm("Bake your custom & AI chips into the app's bundled catalog?\n\nThey'll ship with the next release and appear on every fresh install. (Commit + publish a release afterwards.)")) {
      return;
    }
    try {
      const res = await Api.chips.bakeCatalog();
      setMessage(`Baked ${res.count} chip(s) into the bundled catalog. Commit the change and publish a release so every install gets them.`);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  async function importLibrary(file: File) {
    try {
      const parsed = JSON.parse(await file.text());
      const profiles = (Array.isArray(parsed) ? parsed : [parsed]) as ChipProfile[];
      const res = await Api.chips.importLibrary(profiles);
      refresh();
      const errs = res.errors.length ? ` ${res.errors.length} rejected.` : "";
      setMessage(`Imported ${res.imported} profile(s).${errs}`);
    } catch (err) {
      setMessage(`Import failed: ${(err as Error).message}`);
    }
  }

  async function scaffold() {
    if (!addName.trim() || scaffolding) return;
    setScaffolding(true);
    setAddErr(null);
    setDraft(null);
    try {
      setDraft(await Api.chips.scaffold({ name: addName.trim(), ...(addNotes.trim() ? { notes: addNotes.trim() } : {}) }));
    } catch (err) {
      setAddErr((err as Error).message);
    } finally {
      setScaffolding(false);
    }
  }

  async function saveDraft() {
    if (!draft) return;
    try {
      const saved = await Api.chips.saveProfile(draft);
      setDraft(null);
      setAddName("");
      setAddNotes("");
      setChips(await Api.chips.list());
      setAccessFilter("all");
      setQuery("");
      setExpandedId(saved.chipProfileId);
      setMessage(`Added ${saved.displayName} — AI-scaffolded (unverified). Expand it below to simulate.`);
    } catch (err) {
      setAddErr((err as Error).message);
    }
  }

  async function remove(c: ChipProfile) {
    if (!window.confirm(`Delete "${c.displayName}" from your library? This cannot be undone.`)) return;
    try {
      await Api.chips.deleteProfile(c.chipProfileId);
      refresh();
      setMessage(`Deleted "${c.displayName}".`);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  return (
    <>
      <Topbar
        title="Chip Database"
        crumb={`${chips.length} profiles · ${customCount} custom`}
        actions={
          <div className="row gap-8">
            <button onClick={() => setShowGuide((s) => !s)}>{showGuide ? "Hide" : "📖 Access types"}</button>
            <button onClick={bakeCatalog} title="Ship your custom chips with the app's releases">💾 Bake into app catalog</button>
            <button onClick={exportLibrary}>Export library</button>
            <button onClick={() => importInput.current?.click()}>Import…</button>
            <input
              ref={importInput}
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importLibrary(f); e.target.value = ""; }}
            />
          </div>
        }
      />
      <div className="content">
        {showGuide && (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Access types — how you reach each chip</h3>
            <div className="grid cols-2 mt-8" style={{ gap: 12, alignItems: "start" }}>
              {ACCESS_TYPES.map((a) => <AccessGuideCard key={a.id} guide={a} />)}
            </div>
          </div>
        )}

        {/* AI scaffolder — type a part number, AI builds the full profile. */}
        <div className="card" style={{ borderColor: "var(--accent)" }}>
          <h3 style={{ marginTop: 0 }}>✨ Add a chip with AI <span className="tiny dim">— type a part number, get a full profile</span></h3>
          <p className="tiny dim mt-8">
            Enter any processor or memory part number. A strong AI pipeline scaffolds the family, package,
            capacity, voltage and a real <strong>pinout</strong> from datasheet knowledge — then you can save it
            and <strong>simulate it instantly</strong>, no hardware needed. Saved as <em>AI-suggested</em> until
            you verify it on real silicon.
          </p>
          <div className="row gap-8 mt-8" style={{ flexWrap: "wrap" }}>
            <input
              type="text"
              placeholder="e.g. M95128-W, SPC560B, MX25L6406E, TC1767, 24LC512"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") scaffold(); }}
              style={{ flex: 2, minWidth: 220 }}
            />
            <input
              type="text"
              placeholder="notes / context (optional)"
              value={addNotes}
              onChange={(e) => setAddNotes(e.target.value)}
              style={{ flex: 1, minWidth: 160 }}
            />
            <button className="primary" onClick={scaffold} disabled={scaffolding || !addName.trim()}>
              {scaffolding ? "Scaffolding…" : "Scaffold with AI"}
            </button>
          </div>
          {addErr && <p className="tiny mt-8" style={{ color: "var(--danger)" }}>{addErr}</p>}

          {draft && (
            <div className="card compact mt-12" style={{ borderColor: "var(--warn)" }}>
              <div className="row spread" style={{ alignItems: "baseline" }}>
                <div>
                  <strong>{draft.displayName}</strong>{" "}
                  <span className="badge tiny warn">AI-suggested</span>
                </div>
                <div className="row gap-8">
                  <button className="tiny primary" onClick={saveDraft}>Save to database</button>
                  <button className="tiny ghost" onClick={() => setDraft(null)}>Discard</button>
                </div>
              </div>
              <div className="tiny dim mt-8">
                {draft.manufacturer ? `${draft.manufacturer} · ` : ""}{draft.family} · {draft.protocol.toUpperCase()} · {draft.package} ·{" "}
                {humanSize(draft.sizeBytes)} · {draft.voltage.min}–{draft.voltage.max} V · {draft.pinout.length} pins
              </div>
              {draft.provenance?.notes && <p className="tiny dim mt-8">{draft.provenance.notes}</p>}
              <p className="tiny mt-8" style={{ color: "var(--warn)" }}>
                Review before trusting — AI can get pinouts wrong. Save, then verify against the datasheet / a real read.
              </p>
            </div>
          )}
        </div>

        <div className="card">
          <label htmlFor="chip-search">Search</label>
          <input
            id="chip-search"
            placeholder="e.g. 25LC, microwire, PLCC, 29F, TriCore"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {/* Access-type filter — the database is organised by HOW you reach a chip. */}
          <div className="row gap-8 mt-8" style={{ flexWrap: "wrap" }}>
            <button className={`tiny ${accessFilter === "all" ? "" : "ghost"}`} onClick={() => setAccessFilter("all")}>
              All ({chips.length})
            </button>
            {ACCESS_TYPES.map((a) => (
              <button
                key={a.id}
                className={`tiny ${accessFilter === a.id ? "" : "ghost"}`}
                onClick={() => setAccessFilter(a.id)}
                title={a.tagline}
              >
                {a.icon} {a.label} ({accessCounts[a.id] ?? 0})
              </button>
            ))}
          </div>

          <p className="tiny dim mt-8">
            Chips are grouped by <strong>access type</strong> — the physical way you read/write them. Click any
            chip to expand its panel: <strong>simulate a real read</strong>, see the connection guide, generate an
            AI wiring &amp; soldering guide, and attach your own instruction images. Built-in profiles are
            bench-verified; photo-resolved ones stay AI-suggested until you verify them on real silicon.
          </p>
          {message && <p className="tiny mt-8" style={{ color: "var(--accent)" }}>{message}</p>}
        </div>

        {groups.map(({ access, chips: groupChips }) => (
          <div key={access.id} className="mt-16">
            <div className="row gap-8" style={{ alignItems: "baseline" }}>
              <h3 style={{ margin: 0 }}>{access.icon} {access.label}</h3>
              <span className="tiny dim">{groupChips.length} chips · primary: {TOOL_LABEL[access.primaryTool] ?? access.primaryTool} · {access.tagline}</span>
            </div>
            <table className="table mt-8">
              <thead>
                <tr>
                  <th style={{ width: 24 }} />
                  <th>Chip</th>
                  <th>Trust</th>
                  <th>Tool</th>
                  <th>Family</th>
                  <th>Package</th>
                  <th>Size</th>
                  <th>Voltage</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {groupChips.map((c) => {
                  const prov = effectiveProvenance(c);
                  const isCustom = prov.source !== "seed";
                  const open = expandedId === c.chipProfileId;
                  return (
                    <Fragment key={c.chipProfileId}>
                      <tr
                        style={{ cursor: "pointer", background: open ? "var(--border)" : undefined }}
                        onClick={() => setExpandedId(open ? null : c.chipProfileId)}
                      >
                        <td className="mono dim">{open ? "▾" : "▸"}</td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{c.displayName}</div>
                          <div className="tiny dim mono">{c.chipProfileId}</div>
                        </td>
                        <td>
                          <span className={`badge tiny ${CONFIDENCE_TONE[prov.confidence]}`}>
                            {CONFIDENCE_LABEL[prov.confidence]}
                          </span>
                        </td>
                        <td className="tiny">{TOOL_LABEL[primaryToolForChip(c)] ?? primaryToolForChip(c)}</td>
                        <td className="tiny mono">{c.family}</td>
                        <td className="tiny mono">{c.package}</td>
                        <td className="mono">{humanSize(c.sizeBytes)}</td>
                        <td className="mono tiny">{c.voltage.min}–{c.voltage.max} V</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {isCustom && <button className="tiny" onClick={() => remove(c)}>Delete</button>}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={9} style={{ background: "var(--bg)" }}>
                            <ChipDetail chip={c} onChanged={refresh} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

        {groups.length === 0 && <p className="tiny dim mt-16">No chips match this filter.</p>}
      </div>
    </>
  );
}
