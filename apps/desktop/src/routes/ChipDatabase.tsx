import { useEffect, useMemo, useRef, useState } from "react";

import type { ChipConfidence, ChipProfile } from "@ecu/chip-db";
import { effectiveProvenance, picoModeForChip } from "@ecu/chip-db";

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

export function ChipDatabase() {
  const [chips, setChips] = useState<ChipProfile[]>([]);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  function refresh() {
    Api.chips.list().then(setChips).catch(() => undefined);
  }
  useEffect(refresh, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chips;
    return chips.filter((c) =>
      [c.chipProfileId, c.displayName, c.manufacturer ?? "", c.family, c.protocol]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [chips, query]);

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

  async function remove(c: ChipProfile) {
    if (!window.confirm(`Delete "${c.displayName}" from your library? This cannot be undone.`)) {
      return;
    }
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
            <button onClick={exportLibrary}>Export library</button>
            <button onClick={() => importInput.current?.click()}>Import…</button>
            <input
              ref={importInput}
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importLibrary(f);
                e.target.value = "";
              }}
            />
          </div>
        }
      />
      <div className="content">
        <div className="card">
          <label htmlFor="chip-search">Search</label>
          <input
            id="chip-search"
            placeholder="e.g. 25LC, microwire, SOIC-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className="tiny dim mt-8">
            Built-in profiles are bench-verified. Profiles you resolve from a photo are
            saved as <strong>AI-suggested</strong> until you verify them on real silicon —
            only bench-verified profiles can drive a write. Export shares your custom
            profiles as a JSON file; import merges a library back in.
          </p>
          {message && <p className="tiny mt-8" style={{ color: "var(--accent)" }}>{message}</p>}
        </div>

        <table className="table mt-8">
          <thead>
            <tr>
              <th>Chip</th>
              <th>Trust</th>
              <th>PicoForge</th>
              <th>Family</th>
              <th>Size</th>
              <th>Voltage</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const prov = effectiveProvenance(c);
              const isCustom = prov.source !== "seed";
              const mode = picoModeForChip(c);
              return (
                <tr key={c.chipProfileId}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{c.displayName}</div>
                    <div className="tiny dim mono">{c.chipProfileId}</div>
                  </td>
                  <td>
                    <span className={`badge tiny ${CONFIDENCE_TONE[prov.confidence]}`}>
                      {CONFIDENCE_LABEL[prov.confidence]}
                    </span>
                  </td>
                  <td>
                    {mode ? (
                      <span className="badge tiny info">MODE {mode.mode} · {mode.label}</span>
                    ) : (
                      <span className="tiny dim">— internal MCU</span>
                    )}
                  </td>
                  <td className="tiny mono">{c.family}</td>
                  <td className="mono">{(c.sizeBytes / 1024).toFixed(0)} KB</td>
                  <td className="mono tiny">{c.voltage.min}–{c.voltage.max} V</td>
                  <td>
                    {isCustom && (
                      <button className="tiny" onClick={() => remove(c)}>Delete</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
