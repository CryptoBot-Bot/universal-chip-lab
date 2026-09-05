import { useEffect, useMemo, useState } from "react";

import {
  resolveVehicleIdentity, learnVin, fingerprintSimilarity, profileResponders, ymmProfileId, PIDS,
  BIND_THRESHOLD,
  type VehicleProfile, type BodyType, type IdentityMatch, type VehicleSystemCategory, type OnlineVinDecode,
} from "@ecu/vehicle-db";

import { Api, type DiscoveredModule, type IdentifyResult, type IdentifyCandidate } from "../lib/api";

/**
 * Vehicle Identify — the stage between "we read a VIN" and "a profile is bound".
 *
 * The library binds a profile by itself only when it is CERTAIN (exact VIN,
 * learned VIN pattern, confirmed Year/Make/Model). Anything weaker lands here:
 * the operator sees the decode, the ranked hints, and can
 *   • pick a hint ("this IS that vehicle") — the profile learns the VIN pattern,
 *   • scan the bus + ask the AI — it reads every module's part numbers and
 *     decodes VIN structure + bus evidence into a proposed identity,
 *   • or type the Year/Make/Model by hand.
 * Confirming creates or binds the YMM profile, files the VIN, saves the bus
 * fingerprint + discovered modules — so the next unit of this car resolves
 * instantly with no AI.
 */

const BODY_TYPES: BodyType[] = ["sedan", "suv", "truck", "van", "minivan", "hatchback", "coupe", "wagon"];
const LOCATION_FOR: Record<string, VehicleProfile["modules"][number]["location"]> = {
  powertrain: "engine", transmission: "engine", chassis: "underbody", body: "dash", infotainment: "dash",
  safety: "cabin_front", network: "dash", hvac: "dash", other: "cabin_front",
};

type Stage = "idle" | "scanning" | "thinking" | "proposed" | "saving";

export function VehicleIdentify({ host, iface, vin, profiles, online, onBound, onProfiles }: {
  host: string;
  iface: string;
  vin: string;
  profiles: VehicleProfile[];
  online?: OnlineVinDecode | null;
  onBound: (p: VehicleProfile, note: string) => void;
  onProfiles: (list: VehicleProfile[]) => void;
}) {
  const res = useMemo(() => resolveVehicleIdentity(profiles, vin), [profiles, vin]);
  const [stage, setStage] = useState<Stage>("idle");
  const [prog, setProg] = useState<{ done: number; total: number; found: number } | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredModule[] | null>(null);
  const [ai, setAi] = useState<IdentifyResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  // editable identity (prefilled by the AI or the operator)
  const [year, setYear] = useState<string>(online?.year ? String(online.year) : res.decode.year ? String(res.decode.year) : "");
  const [make, setMake] = useState<string>(online?.make || res.decode.make || "");
  const [model, setModel] = useState<string>(online?.model || "");
  const [trim, setTrim] = useState<string>("");
  const [body, setBody] = useState<BodyType>(res.decode.bodyTypeHint !== "unknown" ? (res.decode.bodyTypeHint as BodyType) : "sedan");
  const [manual, setManual] = useState(false);

  useEffect(() => {
    if (ai) {
      setYear(ai.year != null ? String(ai.year) : "");
      setMake(ai.make || "");
      setModel(ai.model === "unknown" ? "" : ai.model);
      setTrim(ai.trim ?? "");
      setBody(ai.bodyType);
    }
  }, [ai]);

  const hints = res.candidates.filter((c) => c.confidence < BIND_THRESHOLD);
  const d = res.decode;

  async function scanAndIdentify() {
    setErr(null); setAi(null);
    setStage("scanning"); setProg({ done: 0, total: 0, found: 0 });
    const off = Api.vehicleExplorer.onEvent((e) => { if (e.type === "discover") setProg({ done: e.done, total: e.total, found: e.found }); });
    let found: DiscoveredModule[] = [];
    try {
      found = await Api.vehicleExplorer.discover({ host, iface, ident: true });
      setDiscovered(found);
    } catch (e) { setErr(`Bus scan failed — ${(e as Error).message}`); setStage("idle"); off(); return; }
    off(); setProg(null);

    setStage("thinking");
    try {
      const here = { takenAt: new Date().toISOString(), responders: found.map((f) => f.responseId.toUpperCase()), ecus: [] };
      const candidates: IdentifyCandidate[] = profiles
        .filter((p) => !d.make || p.make.toLowerCase() === d.make.toLowerCase() || res.candidates.some((c) => c.profile.id === p.id))
        .map((p) => ({
          id: p.id, year: p.year, make: p.make, model: p.model, trim: p.trim, bodyType: p.bodyType, wmi: p.wmi,
          responders: p.fingerprint?.responders ?? profileResponders(p),
          similarity: fingerprintSimilarity(here, p.fingerprint ?? { takenAt: "", responders: profileResponders(p), ecus: [] }),
          explored: p.modules.filter((m) => m.explored).length,
          hintKind: res.candidates.find((c) => c.profile.id === p.id)?.kind,
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 8);
      const r = await Api.vehicleExplorer.identify({
        vin,
        decode: { valid: d.valid, wmi: d.wmi, vds: d.vds, make: d.make, year: d.year, country: d.country, region: d.region, bodyTypeHint: d.bodyTypeHint, checkDigitValid: d.checkDigitValid },
        bus: {
          iface,
          responders: found.map((f) => f.responseId.toUpperCase()),
          ecus: found.map((f) => ({ responseId: f.responseId.toUpperCase(), requestId: f.requestId, label: f.name, ...(f.ident ?? {}) })),
        },
        candidates,
        operatorNote: [
          online ? `NHTSA vPIC decode: ${online.ok ? `${online.year ?? "?"} ${online.make} ${online.model}${online.trim ? ` ${online.trim}` : ""}${online.bodyClass ? `, ${online.bodyClass}` : ""}${online.engine ? `, ${online.engine}` : ""}` : `no result (${online.errorText ?? "unknown error"})`}` : "NHTSA vPIC: not consulted (offline).",
          note.trim(),
        ].filter(Boolean).join(" | ") || undefined,
      });
      setAi(r);
      setStage("proposed");
    } catch (e) { setErr(`AI identification failed — ${(e as Error).message}`); setStage("idle"); }
  }

  /** Bind an EXISTING profile as this car: learn the VIN, save discovery, done. */
  async function bindExisting(p: VehicleProfile, how: string) {
    setStage("saving"); setErr(null);
    try {
      const now = new Date().toISOString();
      let { profile } = learnVin(p, vin, now);
      if (discovered?.length) profile = await Api.vehicleExplorer.commitDiscovery({ profile, discovered });
      const list = await Api.vehicleLib.save(profile);
      onProfiles(list);
      onBound(list.find((x) => x.id === profile.id) ?? profile, how);
    } catch (e) { setErr((e as Error).message); setStage(ai ? "proposed" : "idle"); }
  }

  /** Create a NEW Year/Make/Model profile from the confirmed identity. */
  async function createAndBind() {
    const y = year.trim() ? Number(year) : null;
    const mk = make.trim(); const md = model.trim();
    if (!mk || !md) { setErr("Make and model are required to file this vehicle."); return; }
    setStage("saving"); setErr(null);
    try {
      const now = new Date().toISOString();
      const id = ymmProfileId(Number.isFinite(y) ? y : null, mk, md);
      const existing = profiles.find((p) => p.id === id);
      if (existing) { await bindExisting(existing, `filed under existing ${existing.year ?? ""} ${existing.make} ${existing.model}`); return; }
      const aiMods = new Map((ai?.modules ?? []).map((m) => [m.responseId.toUpperCase(), m]));
      const modules: VehicleProfile["modules"] = (discovered ?? []).map((f) => {
        const m = aiMods.get(f.responseId.toUpperCase());
        const cat = (m?.category ?? "other") as VehicleSystemCategory;
        return {
          id: `resp-${f.responseId.toLowerCase()}`, label: m?.label ?? f.name, category: cat, bus: "hs-can",
          location: LOCATION_FOR[cat] ?? "cabin_front",
          addressing: { request: f.requestId, response: f.responseId },
        };
      });
      if (!modules.some((m) => (m.addressing?.response ?? "").toUpperCase() === "7E8")) {
        modules.unshift({ id: "ecm", label: "Engine Control Module", category: "powertrain", bus: "hs-can", location: "engine", addressing: { request: "7E0", response: "7E8" } });
      }
      const stub: VehicleProfile = {
        id, year: Number.isFinite(y) ? y : null, make: mk, model: md, trim: trim.trim() || undefined, bodyType: body,
        market: ai?.market || undefined,
        wmi: d.valid ? [d.wmi] : [],
        buses: [{ id: "hs-can", label: "HS-CAN", protocol: "CAN", bitrate: 500000, obdPins: "6/14" }],
        modules,
        supportedPids: PIDS.map((p) => p.pid),
        capabilities: [
          { id: "live-data", label: "Live engine data", category: "diagnostic", risk: "read", bus: "hs-can", module: "ecm", sequence: ["01 0C", "01 0D", "01 05"] },
          { id: "read-dtcs", label: "Read stored DTCs", category: "diagnostic", risk: "read", bus: "hs-can", module: "ecm", sequence: ["03"] },
          { id: "read-vin", label: "Read VIN", category: "diagnostic", risk: "read", bus: "hs-can", module: "ecm", sequence: ["09 02"] },
        ],
        notes: ai
          ? `Identified with AI (${ai.confidence} confidence)${ai.platform ? ` · platform ${ai.platform}` : ""}${ai.engine ? ` · ${ai.engine}` : ""}. ${ai.rationale}`
          : "Identified by the operator from a VIN read.",
        provenance: { source: ai ? "ai_suggested" : "user", confidence: ai ? (ai.confidence === "high" ? 0.8 : ai.confidence === "medium" ? 0.6 : 0.4) : 0.7, createdAt: now, observedOn: vin },
      };
      let { profile } = learnVin(stub, vin, now);
      if (discovered?.length) {
        // persist first so commitDiscovery can fold + fingerprint into the saved record
        await Api.vehicleLib.save(profile);
        profile = await Api.vehicleExplorer.commitDiscovery({ profile, discovered });
      }
      const list = await Api.vehicleLib.save(profile);
      onProfiles(list);
      onBound(list.find((x) => x.id === profile.id) ?? profile, `new vehicle "${[profile.year, profile.make, profile.model].filter(Boolean).join(" ")}" added to the library`);
    } catch (e) { setErr((e as Error).message); setStage(ai ? "proposed" : "idle"); }
  }

  const busy = stage === "scanning" || stage === "thinking" || stage === "saving";
  const aiMatched = ai?.matchedProfileId ? profiles.find((p) => p.id === ai.matchedProfileId) : null;

  return (
    <div className="card vid">
      <style>{styles}</style>
      <div className="row spread">
        <div>
          <h3 style={{ margin: 0 }}>🪪 Identify this vehicle</h3>
          <p className="tiny dim" style={{ margin: "4px 0 0" }}>
            VIN <b className="mono">{vin}</b> is not certain in your library yet. Nothing is bound until you confirm — that is what keeps the library from learning the wrong car.
          </p>
        </div>
      </div>

      <div className="vid-decode tiny">
        <span><span className="dim">Maker code</span> <b className="mono">{d.wmi}</b> → {d.make ?? <span className="warn">not in local table</span>}</span>
        <span><span className="dim">Model codes</span> <b className="mono">{d.vds}</b></span>
        <span><span className="dim">Year</span> <b>{d.year ?? "?"}</b></span>
        <span><span className="dim">Built in</span> {d.country}</span>
        <span><span className="dim">Check digit</span> {d.checkDigitValid ? <span className="ok">OK</span> : <span className="warn">fails (non-NA VIN or typo)</span>}</span>
      </div>

      {hints.length > 0 && (
        <div className="vid-hints">
          <div className="tiny dim">Library hints — same maker, <b>not</b> a match by themselves. Pick one only if you know this is that vehicle:</div>
          {hints.slice(0, 5).map((h: IdentityMatch) => (
            <div key={h.profile.id} className="vid-hint row spread">
              <span className="tiny">
                <b>{h.profile.year ?? ""} {h.profile.make} {h.profile.model}</b>{h.profile.trim ? <span className="dim"> · {h.profile.trim}</span> : null}
                <span className="dim"> — {h.reason}</span>
              </span>
              <button className="tiny" disabled={busy} onClick={() => void bindExisting(h.profile, `confirmed by operator as ${h.profile.year ?? ""} ${h.profile.make} ${h.profile.model}`)}>This is it →</button>
            </div>
          ))}
        </div>
      )}

      <div className="vid-actions row">
        <button className="primary" disabled={busy} onClick={() => void scanAndIdentify()}>
          {stage === "scanning" ? `Scanning bus… ${prog ? `${prog.done}/${prog.total} · ${prog.found} found` : ""}` : stage === "thinking" ? "AI is decoding…" : "🧠 Scan bus & identify with AI"}
        </button>
        <input className="vid-note" placeholder="optional hint for the AI (e.g. 'badge says Camry XSE')" value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
        <button className="tiny" disabled={busy} onClick={() => setManual((m) => !m)}>{manual ? "Hide manual entry" : "Type it manually"}</button>
      </div>
      <p className="tiny dim" style={{ margin: "6px 0 0" }}>
        The scan probes every standard diagnostic address, reads each module's part number / supplier / software id (read-only), and the AI decodes VIN structure + those part numbers into a proposed identity with its evidence.
      </p>

      {err && <div className="vid-err tiny">{err}</div>}

      {discovered && stage !== "scanning" && (
        <div className="vid-bus tiny">
          <b>{discovered.length}</b> module(s) answered on <span className="mono">{iface}</span>:
          {" "}{discovered.map((f) => <span key={f.responseId} className="vid-chip mono" title={f.ident?.partNo ? `${f.ident.partNo}${f.ident.supplier ? ` · ${f.ident.supplier}` : ""}` : "no identification strings"}>{f.responseId}{f.ident?.partNo ? "•" : ""}</span>)}
        </div>
      )}

      {ai && (
        <div className={`vid-ai conf-${ai.confidence}`}>
          <div className="row spread">
            <div>
              <span className={`badge ${ai.confidence === "high" ? "ok" : ai.confidence === "medium" ? "warn" : ""}`}>AI · {ai.confidence} confidence</span>
              <b style={{ marginLeft: 8 }}>{ai.year ?? "?"} {ai.make} {ai.model === "unknown" ? <span className="warn">model unknown</span> : ai.model}</b>
              {ai.trim && <span className="dim"> · {ai.trim}</span>}
              {ai.platform && <span className="tiny dim"> · {ai.platform}</span>}
              {ai.engine && <span className="tiny dim"> · {ai.engine}</span>}
            </div>
            <span className="tiny dim mono">{ai.tokensIn + ai.tokensOut} tok</span>
          </div>
          <p className="tiny" style={{ margin: "6px 0" }}>{ai.rationale}</p>
          {ai.evidence.length > 0 && (
            <ul className="tiny vid-list">{ai.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
          )}
          {ai.warnings.length > 0 && (
            <ul className="tiny vid-list warn">{ai.warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}</ul>
          )}
          {aiMatched && (
            <div className="vid-matched tiny">
              The AI says this <b>is</b> your library's <b>{aiMatched.year ?? ""} {aiMatched.make} {aiMatched.model}</b>{aiMatched.modules.some((m) => m.explored) ? " — its deep-mapped modules will load." : "."}
              <button className="tiny primary" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void bindExisting(aiMatched, `identified by AI as ${aiMatched.year ?? ""} ${aiMatched.make} ${aiMatched.model}`)}>✓ Confirm &amp; load it</button>
            </div>
          )}
        </div>
      )}

      {(ai || manual) && (
        <div className="vid-form">
          <div className="tiny dim">{ai ? "Confirm or correct the identity, then file it:" : "Enter the identity, then file it:"}</div>
          <div className="row vid-fields">
            <input className="mono" style={{ width: 70 }} placeholder="Year" value={year} onChange={(e) => setYear(e.target.value)} />
            <input style={{ width: 130 }} placeholder="Make" value={make} onChange={(e) => setMake(e.target.value)} />
            <input style={{ width: 150 }} placeholder="Model" value={model} onChange={(e) => setModel(e.target.value)} />
            <input style={{ width: 150 }} placeholder="Trim (optional)" value={trim} onChange={(e) => setTrim(e.target.value)} />
            <select value={body} onChange={(e) => setBody(e.target.value as BodyType)}>
              {BODY_TYPES.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <button className="primary" disabled={busy || !make.trim() || !model.trim()} onClick={() => void createAndBind()}>
              {stage === "saving" ? "Filing…" : `✓ File as ${year || "?"} ${make || "?"} ${model || "?"}`}
            </button>
          </div>
          <p className="tiny dim" style={{ margin: "4px 0 0" }}>Filing records this VIN, learns its VIN pattern (so the next one resolves instantly), and saves the bus fingerprint + every discovered module with its real part number.</p>
        </div>
      )}
    </div>
  );
}

const styles = `
.vid { margin-top: 12px; border-color: var(--warn); }
.vid-decode { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; padding: 8px 10px; background: var(--bg-2); border-radius: 8px; }
.vid-hints { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.vid-hint { padding: 6px 10px; border: 1px dashed var(--border); border-radius: 8px; align-items: center; }
.vid-actions { margin-top: 12px; gap: 8px; align-items: center; flex-wrap: wrap; }
.vid-note { flex: 1; min-width: 220px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; color: var(--fg-0); padding: 6px 9px; font-size: 12.5px; }
.vid-err { margin-top: 8px; color: var(--danger); background: var(--danger-dim); border: 1px solid var(--danger); border-radius: 8px; padding: 6px 10px; }
.vid-bus { margin-top: 10px; }
.vid-chip { display: inline-block; margin: 2px 3px; padding: 1px 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); }
.vid-ai { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-2); }
.vid-ai.conf-high { border-color: var(--accent); }
.vid-list { margin: 4px 0 0; padding-left: 18px; }
.vid-list.warn { color: var(--warn); }
.vid-matched { margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: var(--bg-0); border: 1px solid var(--accent); }
.vid-form { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
.vid-fields { gap: 6px; flex-wrap: wrap; margin-top: 6px; align-items: center; }
.vid-fields input, .vid-fields select { background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; color: var(--fg-0); padding: 6px 9px; font-size: 12.5px; }
.vid .ok { color: var(--accent); } .vid .warn { color: var(--warn); }
`;
