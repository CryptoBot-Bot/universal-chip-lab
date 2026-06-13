import { useEffect, useMemo, useRef, useState } from "react";

import type { ChipConfidence, ChipProfile, ChipTool } from "@ecu/chip-db";
import {
  TOOLS,
  effectiveProvenance,
  primaryToolForChip,
  toolsForChip,
} from "@ecu/chip-db";

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

type ToolFilter = "all" | ChipTool;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export function ChipDatabase() {
  const [chips, setChips] = useState<ChipProfile[]>([]);
  const [query, setQuery] = useState("");
  const [toolFilter, setToolFilter] = useState<ToolFilter>("all");
  const [message, setMessage] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  function refresh() {
    Api.chips.list().then(setChips).catch(() => undefined);
  }
  useEffect(refresh, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return chips.filter((c) => {
      if (toolFilter !== "all" && primaryToolForChip(c) !== toolFilter) return false;
      if (!q) return true;
      return [c.chipProfileId, c.displayName, c.manufacturer ?? "", c.family, c.protocol, c.package]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [chips, query, toolFilter]);

  // Group the filtered chips under their primary tool, in TOOLS order.
  const groups = useMemo(() => {
    return TOOLS.map((tool) => ({
      tool,
      chips: filtered.filter((c) => primaryToolForChip(c) === tool.id),
    })).filter((g) => g.chips.length > 0);
  }, [filtered]);

  const customCount = chips.filter((c) => effectiveProvenance(c).source !== "seed").length;
  const toolCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of chips) {
      const t = primaryToolForChip(c);
      m[t] = (m[t] ?? 0) + 1;
    }
    return m;
  }, [chips]);

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
            placeholder="e.g. 25LC, microwire, PLCC, 29F, TriCore"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {/* Tool filter — the database is organised by the tool that reads/writes each chip. */}
          <div className="row gap-8 mt-8" style={{ flexWrap: "wrap" }}>
            <button
              className={`tiny ${toolFilter === "all" ? "" : "ghost"}`}
              onClick={() => setToolFilter("all")}
            >
              All tools ({chips.length})
            </button>
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={`tiny ${toolFilter === t.id ? "" : "ghost"}`}
                onClick={() => setToolFilter(t.id)}
                title={t.blurb}
              >
                {t.label} ({toolCounts[t.id] ?? 0})
              </button>
            ))}
          </div>

          <p className="tiny dim mt-8">
            Chips are grouped by the <strong>tool</strong> that reads/writes them.{" "}
            <strong>PicoForge</strong> reaches serial memories (SPI/I²C/Microwire);{" "}
            <strong>the T48</strong> adds parallel NOR/EEPROM, EPROM, NAND and socketed MCUs;{" "}
            <strong>the MCU debugger</strong> is the only way into a microcontroller's internal
            memory. Built-in profiles are bench-verified; photo-resolved ones stay AI-suggested
            until you verify them on real silicon.
          </p>
          {message && <p className="tiny mt-8" style={{ color: "var(--accent)" }}>{message}</p>}
        </div>

        {groups.map(({ tool, chips: groupChips }) => (
          <div key={tool.id} className="mt-16">
            <div className="row gap-8" style={{ alignItems: "baseline" }}>
              <h3 style={{ margin: 0 }}>{tool.label}</h3>
              <span className="tiny dim">{groupChips.length} chips · {tool.blurb}</span>
            </div>
            <table className="table mt-8">
              <thead>
                <tr>
                  <th>Chip</th>
                  <th>Trust</th>
                  <th>Access</th>
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
                  const caps = toolsForChip(c);
                  const primary = caps[0];
                  const secondary = caps[1];
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
                        {primary && (
                          <span className="badge tiny info" title={primary.note ?? ""}>
                            {primary.label} · {primary.canWrite ? "R/W" : "R-only"}
                          </span>
                        )}
                        {secondary && (
                          <span className="badge tiny dim" style={{ marginLeft: 4 }}>
                            +{TOOLS.find((t) => t.id === secondary.tool)?.label ?? secondary.tool}
                          </span>
                        )}
                      </td>
                      <td className="tiny mono">{c.family}</td>
                      <td className="tiny mono">{c.package}</td>
                      <td className="mono">{humanSize(c.sizeBytes)}</td>
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
        ))}

        {groups.length === 0 && (
          <p className="tiny dim mt-16">No chips match this filter.</p>
        )}
      </div>
    </>
  );
}
