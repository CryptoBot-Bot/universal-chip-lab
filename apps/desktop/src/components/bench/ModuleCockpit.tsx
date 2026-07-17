import { useEffect, useRef, useState } from "react";

import {
  moduleCapabilities, connectorFromHookup, hookupFromConnector,
  type BenchModuleProfile, type ResolvedCapability, type ConnectorLayout, type HookupSignal,
} from "@ecu/vehicle-db";

import { Api, type SuperDeviceStatus, type ExplorerRun } from "../../lib/api";
import { useSuperDevice } from "../../lib/superdevice-connection";
import { parseUdsDtcsFromHex, parseObdDtcsFromHex, decodeObdPid, bytesFromHex, identifierAscii, type DtcRow } from "../../lib/uds";
import { ConnectorEditor } from "./ConnectorEditor";
import { ModuleExplorer } from "./ModuleExplorer";

/**
 * Module Workspace — the single place you map and talk to a real module. One page,
 * top-to-bottom in the order you actually work:
 *   1. HOOK-UP    — the visualised connector + pinout (edit it, meter it, wire it).
 *   2. SUPER DEV  — connect to the Pi that brings the module's bus up.
 *   3. RUNS       — every AI-explorer run against THIS unit; open a new one.
 *   4. LIVE       — bus, sessions, capability board, identification, DTCs, live data.
 *
 * Real hardware only — no simulator. Read-only by design: the console allows
 * diagnostic READS and session control; memory writes / coding / clears go through
 * the Cloning Ceremony, never from here.
 */

type Link = "idle" | "connecting" | "online" | "error";

const HOST_KEY = "bench.pihost";
const DEFAULT_HOST = "superdevice.local:8080";

// SIDs we permit as real diagnostic requests (reads + session/tester-present).
// Anything that modifies the module (2E write, 14 clear, 27 security, 31 routine,
// 34/36/37 transfer, 11 reset…) is refused here and belongs to the Ceremony.
const READ_SIDS = new Set(["10", "3e", "22", "19", "21", "1a", "01", "02", "03", "06", "07", "09", "0a", "23", "17"]);

interface LogLine { dir: "tx" | "rx" | "info" | "err"; text: string; sub?: string }

// The scan-tool style function menu — pick a function, the cockpit handles the session.
type FnKey = "info" | "codes" | "live" | "bus" | "caps" | "clone" | "console";
const FUNCTIONS: { key: FnKey; icon: string; label: string; blurb: string }[] = [
  { key: "info", icon: "🪪", label: "ECU Information", blurb: "part numbers, VIN, calibration & software" },
  { key: "codes", icon: "⚠️", label: "Trouble Codes", blurb: "stored, pending & permanent DTCs" },
  { key: "live", icon: "📈", label: "Live Data", blurb: "sensor values decoded to real units" },
  { key: "bus", icon: "📡", label: "Bus Monitor", blurb: "every frame the module broadcasts" },
  { key: "caps", icon: "🧩", label: "Capabilities", blurb: "full read / write capability map" },
  { key: "clone", icon: "🧬", label: "Clone", blurb: "memory read → bench clone" },
  { key: "console", icon: "⌨️", label: "Console", blurb: "raw requests & log" },
];

/**
 * Turn a stored session tag (e.g. "C0", "85", "default/OBD", "OBD") into the actual
 * session-open request to send first. OBD/legislated reads (mode 01/03/09…) need NO
 * session switch → returns null (don't prepend a bogus opener). A KWP session id like
 * "C0" becomes "10C0". This is why "Read all" only returned the OBD records before:
 * the raw tag "C0" was being sent as a request instead of "10 C0".
 */
function sessionOpener(session: string | undefined, fallback?: string): string | null {
  const s = (session || "").trim().toLowerCase();
  if (!s) return fallback ? fallback.replace(/\s+/g, "") : null;
  if (s.includes("default") || s.includes("obd")) return null;
  const hex = s.replace(/[^0-9a-f]/g, "");
  if (/^[0-9a-f]{2}$/.test(hex)) return "10" + hex.toUpperCase();
  if (/^10[0-9a-f]{2}$/.test(hex)) return hex.toUpperCase();
  return fallback ? fallback.replace(/\s+/g, "") : null;
}

export function ModuleCockpit({ profile, onBack, onBenchVerified, onUpdate }: {
  profile: BenchModuleProfile;
  onBack: () => void;
  onBenchVerified?: () => Promise<void>;
  onUpdate?: (p: BenchModuleProfile) => Promise<void>;
}) {
  const bus = profile.buses[0];
  const idSig = identitySignature(profile);

  return (
    <div className="mc">
      <style>{styles}</style>
      <div className="mc-head">
        <button className="tiny" onClick={onBack}>← Library</button>
        <div className="mc-title">
          {profile.displayName} <span className="mc-cat">{profile.category.toUpperCase()}</span>
        </div>
        {profile.provenance.confidence === "bench_verified" && <span className="badge ok">✓ bench-verified</span>}
        {idSig && <span className="badge info" title="This exact unit is fingerprinted — the app will recognise it on reconnect.">🔖 unit mapped</span>}
      </div>

      <RealCockpit
        profile={profile}
        bus={bus}
        verified={profile.provenance.confidence === "bench_verified"}
        onVerify={onBenchVerified}
        onUpdate={onUpdate}
      />
    </div>
  );
}

/**
 * A stable fingerprint of the physical unit, built from whatever verified identity
 * the runs have captured (VIN, part numbers, ECU serial). Lets the app say "I've
 * seen this exact box before" on the next connect instead of treating it as new.
 */
function identitySignature(p: BenchModuleProfile): string | null {
  const id = p.diagnostics.identification ?? [];
  const pick = (labels: string[]) => id.find((r) => labels.some((l) => (r.label || "").toLowerCase().includes(l)))?.value?.trim();
  const parts = [
    ...p.partNumbers,
    pick(["vin"]),
    pick(["serial"]),
  ].filter((s): s is string => !!s && s.length > 3);
  if (!parts.length) return null;
  return Array.from(new Set(parts)).join(" · ");
}

/**
 * The full pasteable dump — 100% of what the app holds about this unit: a readable
 * snapshot, the complete profile JSON (hookup, buses, every diagnostics field,
 * connector, clone guide, provenance), and every AI-explorer run with its transcript.
 */
function buildModuleDump(p: BenchModuleProfile, runs: ExplorerRun[]): string {
  const d = p.diagnostics;
  const bus = p.buses[0];
  const sig = identitySignature(p);
  const ops = (d.operations ?? []).map((o) => `${o.op}=${o.status}`).join(", ") || "(none mapped)";
  const L: string[] = [];
  L.push(`# Bench module — ${p.displayName}`);
  L.push(`_Complete record held by Universal Chip Lab for this exact unit. Paste for analysis._`);
  L.push("");
  L.push("## Snapshot");
  L.push(`- Brand / category: ${p.brand} · ${p.category}`);
  L.push(`- Part numbers: ${p.partNumbers.length ? p.partNumbers.join(", ") : "(none read)"}`);
  L.push(`- Applications: ${p.applications?.join(", ") || "(none)"}`);
  L.push(`- Trust: ${p.provenance.confidence} · source ${p.provenance.source}`);
  L.push(`- Unit fingerprint: ${sig || "(not yet fingerprinted)"}`);
  if (bus) L.push(`- Bus: ${bus.name} · ${bus.protocol.toUpperCase()} · ${(bus.bitrate / 1000).toFixed(0)}k${bus.fd ? " FD" : ""} · ${bus.requestId || "?"}→${bus.responseId || "?"}`);
  L.push(`- Sessions: ${d.sessions.map((s) => s.id).join(", ") || "(none)"}`);
  L.push(`- Services: ${d.sampleServices.join(", ") || "(none)"}`);
  L.push(`- Capability board: ${ops}`);
  L.push(`- Identification records: ${(d.identification ?? []).length} · live blocks: ${(d.liveData ?? []).length} · broadcast frames: ${(d.broadcastFrames ?? []).length} · DTCs: ${d.knownDtcs.length}`);
  L.push(`- Explorer runs recorded: ${runs.length}`);
  L.push("");
  L.push("## Full profile (JSON)");
  L.push("```json");
  L.push(JSON.stringify(p, null, 2));
  L.push("```");
  L.push("");
  L.push(`## Explorer runs (${runs.length})`);
  if (runs.length === 0) L.push("_No runs recorded yet._");
  runs.forEach((r, i) => {
    L.push("");
    L.push(`### Run ${runs.length - i} — ${r.startedAt} · ${r.outcome}`);
    L.push(`tokens IN ${r.tokensIn} / OUT ${r.tokensOut} · ${r.steps} steps · ${r.newFindings.length} new · seeded from ${r.priorRunCount} prior`);
    if (r.transcript) { L.push("```"); L.push(r.transcript); L.push("```"); }
  });
  return L.join("\n");
}

// ============================ REAL ===========================================

interface IsotpResp { ok: boolean; response?: string; error?: string; negative?: boolean; nrc?: number; request?: string }
interface SeqItem { request: string; response?: string; ok?: boolean; negative?: boolean; nrc?: number; error?: string }
type IdRec = { id: string; label: string; value?: string; session?: string };
interface BusFrame { id: string; dlc: number; bytes: string; count: number; hz: number }

function RealCockpit({ profile, bus, verified, onVerify, onUpdate }: {
  profile: BenchModuleProfile;
  bus: BenchModuleProfile["buses"][number] | undefined;
  verified: boolean;
  onVerify?: () => Promise<void>;
  onUpdate?: (p: BenchModuleProfile) => Promise<void>;
}) {
  const sd = useSuperDevice();
  const [host, setHost] = useState(() => localStorage.getItem(HOST_KEY) || DEFAULT_HOST);
  const [link, setLink] = useState<Link>("idle");
  const [pi, setPi] = useState<SuperDeviceStatus | null>(null);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [iface, setIface] = useState("can0");
  const [busUp, setBusUp] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [reqData, setReqData] = useState("");
  const [txId, setTxId] = useState(bus?.requestId || "7E0");
  const [rxId, setRxId] = useState(bus?.responseId || "7E8");
  const [busy, setBusy] = useState("");
  const [gotPositive, setGotPositive] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState(false);
  const [sessionState, setSessionState] = useState<string | null>(null);
  const [ident, setIdent] = useState<Record<string, { value: string; ascii: string }>>({});
  const [dtcs, setDtcs] = useState<DtcRow[] | null>(null);
  const [dtcRaw, setDtcRaw] = useState("");
  const [liveReq, setLiveReq] = useState("21 01");
  const [liveResp, setLiveResp] = useState<SeqItem | null>(null);
  const [blockResp, setBlockResp] = useState<Record<string, SeqItem>>({});
  const [blockChanged, setBlockChanged] = useState<Record<string, Set<number>>>({});
  const [watchId, setWatchId] = useState<string | null>(null);
  const blockPrevRef = useRef<Record<string, string>>({});
  const [opResp, setOpResp] = useState<Record<string, SeqItem>>({});
  const [busFrames, setBusFrames] = useState<BusFrame[]>([]);
  const [busChanged, setBusChanged] = useState<Set<string>>(new Set());
  const [monitoring, setMonitoring] = useState(false);
  const [showExplorer, setShowExplorer] = useState(false);
  const [runs, setRuns] = useState<ExplorerRun[]>([]);
  const [editingConn, setEditingConn] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [fn, setFn] = useState<FnKey>("info");
  const prevBytes = useRef<Record<string, string>>({});

  // Copy EVERYTHING we hold about this unit — the full profile + every run — as one
  // pasteable block for outside analysis.
  async function copyAll() {
    try {
      await navigator.clipboard.writeText(buildModuleDump(profile, runs));
      setCopiedAll(true); setTimeout(() => setCopiedAll(false), 1600);
    } catch { /* clipboard blocked */ }
  }

  // Every AI-explorer run ever recorded against THIS unit — the run history lives
  // right in the workspace so nothing is orphaned.
  async function refreshRuns() {
    try { setRuns(await Api.moduleExplorer.listRuns(profile.id)); }
    catch { /* no runs yet */ }
  }
  useEffect(() => { void refreshRuns(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);

  const proto = bus?.protocol ?? "uds";
  const sessionReq = proto === "kwp2000" ? "1081" : "1003";
  // The module's "home" session opener. KWP ECUs suppress legislated OBD reads while
  // sitting in a rich session (e.g. Nissan 0xC0), so OBD reads must first return the
  // ECU to default — that's why VIN went missing after reading the C0 records.
  const defaultSession = proto === "kwp2000" ? "1081" : "";
  const diag = profile.diagnostics;

  // Resolve a stored session tag to the opener to send first, ALWAYS asserting a
  // session so a read never inherits whatever session a previous read left behind:
  //  "C0" → "10C0";  "default"/"OBD" → the module's home session (10 81 on KWP).
  function openerFor(session?: string): string | null {
    return sessionOpener(session, sessionReq) ?? (defaultSession || null);
  }
  // The identification records we KNOW this module exposes (grows with Explorer
  // runs). Falls back to the standard KWP/UDS ID reads when nothing is stored yet.
  const idRecords: IdRec[] = (diag.identification && diag.identification.length)
    ? diag.identification
    : proto === "kwp2000"
      ? [{ id: "21 F0", label: "ID / part block" }, { id: "21 FA", label: "ECU part no" }, { id: "21 FB", label: "Software" }]
      : [{ id: "22 F190", label: "VIN" }, { id: "22 F187", label: "Spare part no" }, { id: "22 F191", label: "Hardware no" }, { id: "22 F195", label: "Software no" }, { id: "22 F18C", label: "ECU serial" }, { id: "22 F18A", label: "Supplier" }];

  // Poll the live per-id bus view while monitoring is on (no overlap: sequential loop).
  useEffect(() => {
    if (!monitoring || link !== "online") return;
    let alive = true;
    (async () => {
      while (alive) {
        try {
          const r = await Api.superDevice.get<{ ok: boolean; frames?: BusFrame[] }>(host, `/api/bus/monitor?iface=${iface}&ms=600`);
          if (alive && r.frames) {
            const changed = new Set<string>();
            for (const f of r.frames) {
              if (prevBytes.current[f.id] !== undefined && prevBytes.current[f.id] !== f.bytes) changed.add(f.id);
              prevBytes.current[f.id] = f.bytes;
            }
            setBusFrames(r.frames); setBusChanged(changed);
          }
        } catch { /* transient */ }
        await new Promise((res) => setTimeout(res, 300));
      }
    })();
    return () => { alive = false; };
  }, [monitoring, link, host, iface]);

  function addLog(line: LogLine) { setLog((l) => [...l.slice(-80), line]); }
  const clean = (s: string) => s.replace(/\s+/g, "");
  const nrm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  async function postOne(data: string): Promise<IsotpResp> {
    return Api.superDevice.post<IsotpResp>(host, "/api/isotp", {
      iface, tx: clean(txId), rx: clean(rxId), data: clean(data), timeout: 2.0,
    });
  }
  async function postSeq(requests: string[]): Promise<SeqItem[]> {
    const r = await Api.superDevice.post<{ ok: boolean; results?: SeqItem[]; error?: string }>(
      host, "/api/isotp/seq", { iface, tx: clean(txId), rx: clean(rxId), requests: requests.map(clean), timeout: 2.0 },
    );
    return r.results ?? [];
  }

  // adopt the app-wide connection: if the app is already linked to a Pi,
  // this cockpit starts ONLINE instead of idle.
  useEffect(() => {
    if (sd.link === "online" && link === "idle") {
      setHost(sd.host);
      setPi(sd.status);
      setLink("online");
      setBusUp(!!sd.status?.ifaces.find((f) => f.name === iface)?.up);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sd.link, sd.host]);

  async function connect() {
    setLink("connecting"); setLinkErr(null);
    const r = await sd.connect(host);
    if (!r.ok) { setLink("error"); setLinkErr(r.error ?? "connect failed"); return; }
    try {
      const s = await Api.superDevice.status(host);
      setPi(s); setLink("online");
      localStorage.setItem(HOST_KEY, host);
      setBusUp(!!s.ifaces.find((f) => f.name === iface)?.up);
    } catch (e) { setLink("error"); setLinkErr((e as Error).message); }
  }

  async function bringUp() {
    if (!bus) return;
    setBusy("bus");
    try {
      const r = await Api.superDevice.setUp(host, iface, bus.bitrate, !!bus.fd);
      addLog({ dir: "info", text: `${iface} up @ ${(bus.bitrate / 1000).toFixed(0)}k${bus.fd ? " FD" : ""}`, sub: r.result });
      setBusUp(true);
    } catch (e) { addLog({ dir: "err", text: "bring-up failed", sub: (e as Error).message }); }
    finally { setBusy(""); }
  }

  async function startSession() {
    setBusy("session");
    addLog({ dir: "tx", text: `session ${fmtHex(sessionReq)}` });
    try {
      const r = await postOne(sessionReq);
      if (r.response && !r.negative) { setSessionState(proto === "kwp2000" ? "comms open" : "extended"); setGotPositive(true); addLog({ dir: "rx", text: fmtHex(r.response) }); }
      else { setSessionState(null); addLog({ dir: "err", text: r.negative ? `negative ${fmtHex(r.response || "")}` : (r.error || "no response") }); }
    } catch (e) { addLog({ dir: "err", text: (e as Error).message }); }
    finally { setBusy(""); }
  }

  async function readIdentification() {
    setBusy("ident");
    try {
      // Build one sequence over a single socket, opening each record's session as
      // needed so session-gated records (e.g. Nissan 10 C0 → 21 FE) actually answer.
      // Group records by their required session. Read each group on its OWN fresh
      // socket, opening that session from default — many KWP ECUs only switch
      // sessions from the default state, so ping-ponging 85↔C0 on one socket makes
      // the later reads fall out with 0x7F. This mirrors the single-block reader.
      // Group records by the session-open request they need ("" = none, e.g. OBD
      // mode 09 which answers in any state). This is the fix for "Read all" only
      // returning VIN/CALID: the KWP records needed 10 C0 opened, not the bare "C0".
      const groups = new Map<string, IdRec[]>();
      for (const rec of idRecords) {
        const opener = openerFor(rec.session) ?? "";
        (groups.get(opener) ?? groups.set(opener, []).get(opener)!).push(rec);
      }
      const map: Record<string, { value: string; ascii: string }> = {};
      // Read the home/default group first, rich sessions last — each group asserts its
      // own session, so order no longer strands the OBD reads in the C0 session.
      const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [opener, recs] of ordered) {
        const seq = opener ? [opener, ...recs.map((r) => clean(r.id))] : recs.map((r) => clean(r.id));
        const results = await postSeq(seq);
        const off = opener ? 1 : 0; // skip the session opener's own result
        recs.forEach((r, i) => {
          const item = results[i + off];
          if (item?.response && !item.negative) map[nrm(r.id)] = { value: item.response.toUpperCase(), ascii: identifierAscii(item.response) };
        });
      }
      setIdent(map);
      if (Object.keys(map).length) { setGotPositive(true); addLog({ dir: "rx", text: `identification: ${Object.keys(map).length}/${idRecords.length} records read` }); }
      else addLog({ dir: "err", text: "no identification records answered", sub: "module may use non-standard IDs / a different session — try the raw console" });
    } catch (e) { addLog({ dir: "err", text: (e as Error).message }); }
    finally { setBusy(""); }
  }

  // Read one known live-data block in its required session (one socket). When
  // `silent` (the watch loop), skip the busy flag + log spam and just diff bytes.
  async function readKnownBlock(b: { id: string; session?: string }, silent = false) {
    const key = nrm(b.id);
    if (!silent) setBusy("blk:" + key);
    try {
      const opener = openerFor(b.session);
      const results = await postSeq(opener ? [opener, clean(b.id)] : [clean(b.id)]);
      const item = results[results.length - 1];
      if (item?.response && !item.negative) {
        const newHex = clean(item.response);
        const prev = blockPrevRef.current[key];
        const changed = new Set<number>();
        if (prev) {
          const a = prev.match(/../g) ?? [], bb = newHex.match(/../g) ?? [];
          for (let i = 0; i < Math.max(a.length, bb.length); i++) if (a[i] !== bb[i]) changed.add(i);
        }
        blockPrevRef.current[key] = newHex;
        setBlockResp((r) => ({ ...r, [key]: item }));
        setBlockChanged((c) => ({ ...c, [key]: changed }));
        setGotPositive(true);
        if (!silent) addLog({ dir: "rx", text: `${fmtHex(b.id)}${opener ? ` (${fmtHex(opener)})` : ""}: ${fmtHex(item.response)}` });
      } else {
        if (item) setBlockResp((r) => ({ ...r, [key]: item }));
        if (!silent) addLog({ dir: "err", text: `${fmtHex(b.id)}: ${item?.negative ? `negative ${fmtHex(item.response || "")}` : "no data"}` });
      }
    } catch (e) { if (!silent) addLog({ dir: "err", text: (e as Error).message }); }
    finally { if (!silent) setBusy(""); }
  }

  // Read every known live block once (sequential — one socket per block, each in its
  // own session), so "Read all" fills the whole live-data view in one press.
  async function readAllBlocks() {
    setBusy("blkall");
    try {
      for (const b of knownBlocks) {
        // eslint-disable-next-line no-await-in-loop
        await readKnownBlock(b, true);
      }
      addLog({ dir: "rx", text: `live data: read ${knownBlocks.length} block(s)` });
    } finally { setBusy(""); }
  }

  // Generic reader for any supported capability from the canonical board — opens
  // the op's session (if any) and sends its request over one socket. One function
  // serves every module; no per-module code.
  async function readOp(cap: ResolvedCapability) {
    // The canonical read ops have purpose-built handlers that deal with sessions,
    // OBD-vs-UDS, multi-request and decoding — route to them instead of firing the
    // explorer's descriptive request text (e.g. "03 / 07 / 0A") as raw hex.
    if (cap.id === "read_dtcs") return void readDtcs();
    if (cap.id === "read_identification" && idRecords.length) return void readIdentification();
    if (cap.id === "read_live_data" && knownBlocks.length) return void readAllBlocks();
    if (!cap.request) return;
    setBusy("op:" + cap.id);
    try {
      // Take the first real hex token as the request, and translate the session tag.
      const req = (cap.request.match(/[0-9A-Fa-f]{2,}/g) ?? [])[0] ?? clean(cap.request);
      const opener = openerFor(cap.session);
      const reqs = opener ? [opener, clean(req)] : [clean(req)];
      const results = await postSeq(reqs);
      const item = results[results.length - 1];
      if (item) setOpResp((r) => ({ ...r, [cap.id]: item }));
      if (item?.response && !item.negative) { setGotPositive(true); addLog({ dir: "rx", text: `${cap.label}: ${fmtHex(item.response)}`, sub: asciiOf(item.response) || undefined }); }
      else addLog({ dir: "err", text: `${cap.label}: ${item?.negative ? `negative 7F NRC 0x${(item.nrc ?? 0).toString(16).toUpperCase().padStart(2, "0")}` : "no response"}` });
    } catch (e) { addLog({ dir: "err", text: (e as Error).message }); }
    finally { setBusy(""); }
  }

  async function readDtcs() {
    setBusy("dtc");
    try {
      // Try UDS ReadDTCInformation (19 02 FF) first — UDS-native modules answer here.
      addLog({ dir: "tx", text: "read DTCs 19 02 FF" });
      const uds = await postOne("1902FF");
      if (uds.response && !uds.negative && bytesFromHex(uds.response)[0] === 0x59) {
        setDtcRaw(uds.response.toUpperCase());
        const rows = parseUdsDtcsFromHex(uds.response);
        setDtcs(rows); if (rows.length) setGotPositive(true);
        addLog({ dir: "rx", text: `${rows.length} DTC(s) read (UDS 19)` });
        return;
      }
      // KWP/OBD modules (Nissan etc.) don't implement UDS 19 — DTCs come via the
      // legislated OBD-II stack: mode 03 stored, 07 pending, 0A permanent. Merge them.
      addLog({ dir: "tx", text: `19 unsupported (${uds.negative ? `NRC 0x${(uds.nrc ?? 0).toString(16).toUpperCase()}` : "no answer"}) — reading OBD 03/07/0A` });
      // Assert the home session first so OBD modes answer even if a rich session is open.
      const seq = defaultSession ? [defaultSession, "03", "07", "0A"] : ["03", "07", "0A"];
      const results = (await postSeq(seq)).slice(defaultSession ? 1 : 0);
      const merged = new Map<string, { code: string; description: string; kinds: string[] }>();
      const raws: string[] = [];
      for (const it of results) {
        if (!it?.response || it.negative) continue;
        raws.push(it.response.toUpperCase());
        for (const d of parseObdDtcsFromHex(it.response)) {
          const e = merged.get(d.code) ?? { code: d.code, description: d.description, kinds: [] };
          if (!e.kinds.includes(d.status)) e.kinds.push(d.status);
          merged.set(d.code, e);
        }
      }
      const rows: DtcRow[] = [...merged.values()].map((e) => ({ code: e.code, description: e.description, statusByte: "", status: e.kinds.join(" · ") }));
      setDtcRaw(raws.join("   "));
      setDtcs(rows); if (rows.length) setGotPositive(true);
      addLog({ dir: rows.length ? "rx" : "info", text: `${rows.length} DTC(s) read (OBD 03/07/0A)` });
    } catch (e) { addLog({ dir: "err", text: (e as Error).message }); }
    finally { setBusy(""); }
  }

  async function readLive() {
    setBusy("live");
    try {
      const results = await postSeq([sessionReq, liveReq]);
      setLiveResp(results[1] ?? null);
      const item = results[1];
      if (item?.response && !item.negative) { setGotPositive(true); addLog({ dir: "rx", text: `live ${fmtHex(liveReq)}: ${fmtHex(item.response)}` }); }
      else addLog({ dir: "err", text: `live ${fmtHex(liveReq)}: ${item?.negative ? `negative (${fmtHex(item.response || "")})` : "no data"}`, sub: "this module may expose live data only via a maker-specific protocol" });
    } catch (e) { addLog({ dir: "err", text: (e as Error).message }); }
    finally { setBusy(""); }
  }

  async function send(dataHex: string) {
    const c = clean(dataHex);
    if (!c) return;
    const sid = c.slice(0, 2).toLowerCase();
    if (!READ_SIDS.has(sid)) {
      addLog({ dir: "err", text: `Refused: service 0x${sid.toUpperCase()} modifies the module`, sub: "Only diagnostic reads & session control here. Writes/coding/clears go through the Cloning Ceremony." });
      return;
    }
    setBusy("raw");
    addLog({ dir: "tx", text: fmtHex(dataHex) });
    try {
      const r = await postOne(c);
      if (!r.response) addLog({ dir: "err", text: r.error || "no response", sub: "Powered? Ignition/KL15 on? Right IDs & speed? Bus terminated?" });
      else if (r.negative) addLog({ dir: "rx", text: `NEGATIVE 7F, NRC 0x${(r.nrc ?? 0).toString(16).toUpperCase().padStart(2, "0")} — ${nrcText(r.nrc)}`, sub: r.response.toUpperCase() });
      else { addLog({ dir: "rx", text: fmtHex(r.response), sub: asciiOf(r.response) }); setGotPositive(true); }
    } catch (e) { addLog({ dir: "err", text: (e as Error).message }); }
    finally { setBusy(""); }
  }

  const ifaceStatus = pi?.ifaces.find((f) => f.name === iface);
  const anyBusy = busy !== "";
  const knownBlocks = diag.liveData ?? [];
  const knownFrames = diag.broadcastFrames ?? [];
  const frameByCanId = new Map(knownFrames.map((f) => [nrm(f.canId), f]));
  const dtcDesc = new Map(diag.knownDtcs.map((d) => [d.code.toUpperCase(), d.desc]));
  const caps = moduleCapabilities(diag);
  const readCaps = caps.filter((c) => c.group === "read");
  const actionCaps = caps.filter((c) => c.group === "action");

  // Watch a live block: re-read it on a loop and diff the bytes so the ones that
  // move (live sensors/counters) light up — the practical way to decode a packed block.
  useEffect(() => {
    if (!watchId || link !== "online") return;
    const b = knownBlocks.find((x) => nrm(x.id) === watchId);
    if (!b) return;
    let alive = true;
    (async () => {
      while (alive) {
        await readKnownBlock(b, true);
        await new Promise((r) => setTimeout(r, 1200));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchId, link]);

  return (
    <div className="mc-body">
      {/* 0 ─ full dump: everything we know about this unit, one paste */}
      <div className="mc-toolbar">
        <button className="tiny" onClick={() => void copyAll()}>{copiedAll ? "✓ Copied everything" : "📋 Copy full module"}</button>
        <span className="tiny dim">the complete profile + all {runs.length} run{runs.length === 1 ? "" : "s"} — paste for analysis</span>
      </div>

      {/* 1 ─ HOOK-UP: the visualised connector is the first thing you see */}
      <HookupSection profile={profile} onUpdate={onUpdate} editing={editingConn} setEditing={setEditingConn} />

      {/* 2 ─ SUPER DEVICE: the Pi that brings this unit's bus up */}
      <section className="mc-card mc-connect-card">
        <h4>Super Device
          {link === "online"
            ? <span className="badge ok" style={{ marginLeft: "auto" }}>● online</span>
            : <span className="badge dim" style={{ marginLeft: "auto" }}>offline</span>}
        </h4>
        {link === "online" ? (
          <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="mc-orb sm" data-state="online" />
            <span className="tiny dim mono">{host}</span>
            <span className="tiny dim">{pi?.sys.temp != null ? `${pi.sys.temp.toFixed(0)}°C · ` : ""}up {pi?.sys.uptime}</span>
            {sessionState && <span className="badge info">session: {sessionState}</span>}
            {busUp && <span className="badge ok">bus armed</span>}
            <button className="tiny" style={{ marginLeft: "auto" }} onClick={() => { void sd.disconnect(); setLink("idle"); setPi(null); setMonitoring(false); setBusUp(false); }}>Disconnect</button>
          </div>
        ) : (
          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="mc-orb sm" data-state={link} />
            <span className="tiny dim">Brings the module's bus up and runs the real diagnostic requests. Same WiFi network.</span>
            <input className="mono mc-host" value={host} onChange={(e) => setHost(e.target.value)} style={{ marginLeft: "auto" }} />
            <button className="primary" disabled={link === "connecting"} onClick={() => void connect()}>{link === "connecting" ? "Connecting…" : "Connect"}</button>
          </div>
        )}
        {linkErr && <div className="mc-err" style={{ marginTop: 10 }}>{linkErr}</div>}
      </section>

      {/* 3 ─ RUNS: every AI-explorer run recorded against THIS unit */}
      <RunsSection
        runs={runs}
        online={link === "online"}
        canRun={busUp}
        onRun={() => setShowExplorer(true)}
      />

      {/* 4 ─ LIVE: only meaningful once the Pi is online with the bus up */}
      {link === "online" && (<>

      {/* Bus + session */}
      <section className="mc-card">
        <h4>Bus &amp; session</h4>
        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label className="tiny dim">Interface
            <select value={iface} onChange={(e) => setIface(e.target.value)} className="mc-sel">
              {(pi?.ifaces ?? []).filter((f) => f.present).map((f) => <option key={f.name} value={f.name}>{f.name} {f.role ? `(${f.role})` : ""}</option>)}
            </select>
          </label>
          <span className="tiny">Target <b>{bus ? `${bus.name} · ${(bus.bitrate / 1000).toFixed(0)}k · ${bus.protocol.toUpperCase()}` : "unknown"}</b></span>
          <label className="tiny dim">Req <input className="mono mc-id" value={txId} onChange={(e) => setTxId(e.target.value)} /></label>
          <label className="tiny dim">Resp <input className="mono mc-id" value={rxId} onChange={(e) => setRxId(e.target.value)} /></label>
          {ifaceStatus?.up ? <span className="badge ok">up · rx {ifaceStatus.rx ?? 0}</span> : <span className="badge dim">down</span>}
          <button className="tiny primary" disabled={anyBusy || !bus} onClick={() => void bringUp()}>{ifaceStatus?.up ? "Re-arm bus" : "Bring bus up"}</button>
          <button className="tiny" disabled={anyBusy || !busUp} onClick={() => void startSession()}>{busy === "session" ? "…" : `Start session (${fmtHex(sessionReq)})`}</button>
        </div>
        {bus?.termination && <div className="tiny warn" style={{ marginTop: 6 }}>⚠ Enable the HAT's 120Ω terminator, and give the module 12V + ignition/KL15.</div>}
        {diag.sessions.length > 0 && (
          <div className="mc-sessions">
            <span className="tiny dim">Sessions this module exposes — each function below opens the one it needs automatically:</span>
            <div className="mc-chips">
              {diag.sessions.map((s) => <span key={s.id} className="mc-chip"><b className="mono">{s.id}</b> {s.label}</span>)}
            </div>
          </div>
        )}
      </section>

      {/* Verify banner */}
      {gotPositive && onVerify && !verified && !promoted && (
        <div className="mc-verify">
          <div><b>✓ The module answered on the real bus.</b><div className="tiny dim">Hookup &amp; IDs confirmed. Promote this AI draft to <b>bench-verified</b>.</div></div>
          <button className="primary" disabled={promoting} onClick={async () => { setPromoting(true); try { await onVerify(); setPromoted(true); } finally { setPromoting(false); } }}>{promoting ? "Saving…" : "Mark bench-verified"}</button>
        </div>
      )}
      {(verified || promoted) && <div className="mc-verify ok"><b>✓ Bench-verified</b><span className="tiny dim">Confirmed on real hardware.</span></div>}

      {/* Function menu — pick a function; the cockpit opens the right session for it */}
      <div className="mc-fnmenu">
        {FUNCTIONS.filter((f) => f.key !== "clone" || profile.cloneGuide).map((f) => (
          <button key={f.key} className={`mc-fn ${fn === f.key ? "on" : ""}`} onClick={() => setFn(f.key)}>
            <span className="mc-fn-ico">{f.icon}</span>
            <span className="mc-fn-txt"><b>{f.label}</b><span className="mc-fn-blurb">{f.blurb}</span></span>
          </button>
        ))}
      </div>

      {/* ── Bus Monitor ── */}
      {fn === "bus" && (
      <section className="mc-card">
        <h4>Live bus <span className="tiny dim">every id the module broadcasts</span>
          <button className={`tiny ${monitoring ? "" : "primary"}`} style={{ marginLeft: "auto" }} disabled={!busUp} onClick={() => setMonitoring((m) => !m)}>
            {monitoring ? "■ Stop" : "▶ Monitor"}
          </button>
        </h4>
        {!busUp ? <div className="tiny dim">Bring the bus up first.</div>
          : busFrames.length === 0
            ? <div className="tiny dim">{monitoring ? "Listening…" : "Press Monitor to watch the live bus."}</div>
            : (
              <table className="mc-bus">
                <thead><tr><th>ID</th><th>Hz</th><th>DLC</th><th>Data (live)</th><th>Known decode</th></tr></thead>
                <tbody>
                  {busFrames.map((f) => {
                    const known = frameByCanId.get(nrm(f.id));
                    return (
                      <tr key={f.id}>
                        <td className="mono mc-canid">{f.id}{known?.label ? <span className="tiny dim"> {known.label}</span> : null}</td>
                        <td className="tiny dim">{f.hz}</td>
                        <td className="tiny dim">{f.dlc}</td>
                        <td className={`mono mc-busbytes ${busChanged.has(f.id) ? "chg" : ""}`}>{f.bytes}</td>
                        <td className="tiny dim">{known?.decode ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
      </section>
      )}

      {/* ── Capabilities ── */}
      {fn === "caps" && (
      <section className="mc-card">
        <h4>What this module can do <span className="tiny dim">the standard capability model — same for every module, grows with each AI explorer run</span></h4>
        <div className="mc-cap-row"><span className="mc-cap-lbl">Access</span>
          <div className="mc-chips">
            <span className="mc-chip mono">{bus ? `${bus.protocol.toUpperCase()} · ${txId}→${rxId} · ${(bus.bitrate / 1000).toFixed(0)}k` : "—"}</span>
            {diag.sessions.map((s) => <span key={s.id} className="mc-chip"><b className="mono">{s.id}</b> {s.label}</span>)}
          </div>
        </div>
        <div className="mc-board">
          <div className="mc-board-col">
            <div className="mc-board-h">READ <span className="tiny dim">pull data out — safe on real hardware</span></div>
            {readCaps.map((c) => (
              <CapabilityRow key={c.id} cap={c} busUp={busUp} busy={busy === "op:" + c.id} anyBusy={anyBusy}
                resp={opResp[c.id]} onRead={() => void readOp(c)} />
            ))}
          </div>
          <div className="mc-board-col">
            <div className="mc-board-h">WRITE / ACTION <span className="tiny dim">changes the module — via Ceremony / simulator</span></div>
            {actionCaps.map((c) => <CapabilityRow key={c.id} cap={c} busUp={busUp} busy={false} anyBusy={anyBusy} />)}
          </div>
        </div>
      </section>
      )}

      {/* ── ECU Information ── */}
      {fn === "info" && (
        <section className="mc-card">
          <h4>Identification <button className="tiny" disabled={anyBusy || !busUp} onClick={() => void readIdentification()}>{busy === "ident" ? "Reading…" : "Read all"}</button>
            {profile.partNumbers.length > 0 && <span className="tiny dim">expected {profile.partNumbers.join(" / ")}</span>}
          </h4>
          {idRecords.length === 0
            ? <div className="tiny dim">Read the ECU's part numbers &amp; IDs from the module.</div>
            : (
              <table className="mc-kv">
                <tbody>{idRecords.map((r) => {
                  const live = ident[nrm(r.id)];
                  return (
                    <tr key={r.id}>
                      <td className="dim">{r.label}<div className="tiny dim mono">{r.id}{r.session ? ` · ${r.session}` : ""}</div></td>
                      <td className="mono">
                        {live ? <span>{live.ascii || live.value} <span className="badge ok tiny">live ✓</span></span>
                          : r.value ? <span className="dim">{prettyIdValue(r.value)}</span>
                          : <span className="dim">—</span>}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}
        </section>
      )}

      {/* ── Trouble Codes ── */}
      {fn === "codes" && (
        <section className="mc-card">
          <h4>Fault codes <button className="tiny" disabled={anyBusy || !busUp} onClick={() => void readDtcs()}>{busy === "dtc" ? "Reading…" : "Read DTCs"}</button></h4>
          {dtcs === null
            ? <div className="tiny dim">Read stored trouble codes — tries UDS 0x19, falls back to OBD modes 03/07/0A.</div>
            : dtcs.length === 0
              ? <div className="tiny dim">No DTCs returned — module reports clean (UDS 19 and OBD 03/07/0A all empty).</div>
              : (
                <ul className="mc-dtcs">
                  {dtcs.map((d, i) => {
                    const desc = dtcDesc.get(d.code.toUpperCase()) ?? d.description;
                    return <li key={i}><b className="mono">{d.code}</b> {d.statusByte && <span className="badge danger tiny">0x{d.statusByte}</span>} <span className="tiny">{d.status}</span>{desc ? <div className="tiny dim">{desc}</div> : null}</li>;
                  })}
                </ul>
              )}
          {dtcRaw && <div className="tiny dim mono" style={{ marginTop: 6, wordBreak: "break-all" }}>{fmtHex(dtcRaw)}</div>}
        </section>
      )}

      {/* ── Live Data ── */}
      {fn === "live" && (
      <section className="mc-card">
        <h4>Live data <span className="tiny dim">OBD PIDs decoded to real units; session-gated blocks read in their session</span>
          {knownBlocks.length > 0 && <button className="tiny primary" style={{ marginLeft: "auto" }} disabled={anyBusy || !busUp} onClick={() => void readAllBlocks()}>{busy === "blkall" ? "Reading…" : "Read all"}</button>}
        </h4>
        {knownBlocks.length > 0 && (
          <div className="mc-blocks">
            {knownBlocks.map((b) => {
              const key = nrm(b.id);
              const resp = blockResp[key];
              const busyThis = busy === "blk:" + key;
              const watching = watchId === key;
              const decoded = resp?.response && !resp.negative ? decodeObdPid(b.id, resp.response) : null;
              return (
                <div key={b.id} className="mc-block">
                  <div className="mc-block-top">
                    <div>
                      <b>{b.label}</b>
                      <div className="tiny dim mono">{b.session ? `${b.session} → ` : ""}{b.id}</div>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="tiny primary" disabled={anyBusy || !busUp} onClick={() => void readKnownBlock(b)}>{busyThis ? "…" : "Read"}</button>
                      <button className={`tiny ${watching ? "" : ""}`} disabled={!busUp} onClick={() => setWatchId(watching ? null : key)}>{watching ? "■ Watching" : "👁 Watch"}</button>
                    </div>
                  </div>
                  {decoded && <div className="mc-block-val">{decoded}{watching && <span className="mc-live-dot" />}</div>}
                  {b.note && !decoded && <div className="tiny dim">{b.note}</div>}
                  {resp && (resp.response && !resp.negative
                    ? <>
                        <HexGrid hex={resp.response} changed={blockChanged[key]} />
                        {asciiOf(resp.response) && <div className="tiny dim">{asciiOf(resp.response)}</div>}
                        {watching && <div className="tiny dim">👁 watching @ ~0.8Hz — <span style={{ color: "var(--accent)" }}>green</span> bytes changed since the last read (live signals).</div>}
                      </>
                    : <div className="tiny mono mc-block-resp"><span className="dim">{resp.negative ? `negative ${fmtHex(resp.response || "")}` : "no data"}</span></div>)}
                </div>
              );
            })}
          </div>
        )}
        <div className="row" style={{ gap: 8, marginTop: knownBlocks.length ? 10 : 0 }}>
          <input className="mono mc-req" value={liveReq} onChange={(e) => setLiveReq(e.target.value)} placeholder="custom block e.g. 21 02" />
          <button className="tiny" disabled={anyBusy || !busUp} onClick={() => void readLive()}>{busy === "live" ? "Reading…" : "Read custom"}</button>
        </div>
        {liveResp && (
          <div className="tiny" style={{ marginTop: 8 }}>
            {liveResp.response && !liveResp.negative
              ? <span className="mono">{fmtHex(liveResp.response)}{asciiOf(liveResp.response) ? ` · ${asciiOf(liveResp.response)}` : ""}</span>
              : <span className="dim">No live block at {fmtHex(liveReq)}{liveResp.negative ? ` (negative ${fmtHex(liveResp.response || "")})` : ""}. If it's 0x7F, try the block's session first (many makers gate live data to a specific session).</span>}
          </div>
        )}
      </section>
      )}

      {/* ── Console ── */}
      {fn === "console" && (<>
      <section className="mc-card">
        <h4>Raw console <span className="tiny dim">reads only — writes go through the Ceremony</span></h4>
        <div className="row" style={{ gap: 8 }}>
          <input className="mono mc-req" placeholder="raw hex e.g. 21 F0" value={reqData}
            onChange={(e) => setReqData(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void send(reqData); }} />
          <button className="primary" disabled={anyBusy || !busUp} onClick={() => void send(reqData)}>Send</button>
        </div>
        {!busUp && <div className="tiny dim" style={{ marginTop: 6 }}>Bring the bus up first.</div>}
      </section>

      {/* Log — the Console function shows the raw console plus this response log */}
      <section className="mc-card">
        <h4>Response log</h4>
        <div className="mc-log">
          {log.length === 0 && <div className="tiny dim">Requests and responses appear here.</div>}
          {log.map((l, i) => (
            <div key={i} className={`mc-log-line ${l.dir}`}>
              <span className="mc-log-tag">{l.dir === "tx" ? "→" : l.dir === "rx" ? "←" : l.dir === "err" ? "✕" : "•"}</span>
              <div><div className="mono">{l.text}</div>{l.sub && <div className="tiny dim">{l.sub}</div>}</div>
            </div>
          ))}
        </div>
      </section>
      </>)}

      {/* ── Clone ── */}
      {fn === "clone" && profile.cloneGuide && <CloneGuidePanel g={profile.cloneGuide} />}
      </>)}

      {showExplorer && (
        <ModuleExplorer
          module={profile} host={host} iface={iface} tx={txId} rx={rxId}
          onClose={() => { setShowExplorer(false); void refreshRuns(); }}
          onApply={onUpdate}
        />
      )}
    </div>
  );
}

const SIGNAL_META: Record<HookupSignal, { label: string; glyph: string; tone: string }> = {
  power:    { label: "12V power (B+)", glyph: "⏻", tone: "danger" },
  ignition: { label: "Ignition / KL15", glyph: "🔑", tone: "warn" },
  ground:   { label: "Ground", glyph: "⏚", tone: "dim" },
  can_h:    { label: "CAN-H", glyph: "▲", tone: "info" },
  can_l:    { label: "CAN-L", glyph: "▼", tone: "info" },
  kline:    { label: "K-line", glyph: "—", tone: "info" },
  lin:      { label: "LIN", glyph: "~", tone: "info" },
  wake:     { label: "Wake / enable", glyph: "☼", tone: "warn" },
  flexray:  { label: "FlexRay", glyph: "≡", tone: "dim" },
  other:    { label: "Other", glyph: "•", tone: "dim" },
};

/**
 * The visualised hook-up — the first section of the workspace. Shows the pinout with
 * signal badges, the ASCII connector, and an inline editor so the map you meter on the
 * bench is corrected in place. Bench-critical wires (power/ignition/ground) lead.
 */
function HookupSection({ profile, onUpdate, editing, setEditing }: {
  profile: BenchModuleProfile;
  onUpdate?: (p: BenchModuleProfile) => Promise<void>;
  editing: boolean;
  setEditing: (v: boolean) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const bus = profile.buses[0];
  // Power/ignition/ground first (you wire those before anything else), then the bus.
  const order: HookupSignal[] = ["power", "ignition", "ground", "can_h", "can_l", "kline", "lin", "wake", "flexray", "other"];
  const rows = [...profile.hookup].sort((a, b) => order.indexOf(a.signal) - order.indexOf(b.signal));

  async function saveConnector(layout: ConnectorLayout) {
    if (!onUpdate) { setEditing(false); return; }
    const next: BenchModuleProfile = { ...profile, connector: layout, hookup: hookupFromConnector(layout) };
    try { await onUpdate(next); setEditing(false); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  }

  return (
    <section className="mc-card mc-hookup">
      <h4>Hook-up
        <span className="tiny dim">wire this before you power the module</span>
        {onUpdate && <button className="tiny" style={{ marginLeft: "auto" }} onClick={() => setEditing(!editing)}>{editing ? "Close editor" : "✎ Edit connector"}</button>}
      </h4>

      {profile.powerNote && <div className="mc-power"><span>⚡</span><span>{profile.powerNote}</span></div>}

      <div className="mc-hookup-grid">
        <table className="mc-pins">
          <thead><tr><th>Pin</th><th>Signal</th><th>Connect to</th><th></th></tr></thead>
          <tbody>
            {rows.map((h, i) => {
              const m = SIGNAL_META[h.signal];
              return (
                <tr key={i} className={h.required ? "req" : ""}>
                  <td className="mono">{h.pin}</td>
                  <td><span className={`badge ${m.tone}`}>{m.glyph} {m.label}</span></td>
                  <td>{h.connectTo}{h.note && <div className="tiny dim">{h.note}</div>}</td>
                  <td className="tiny dim">{h.required ? "req" : "opt"}</td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={4} className="tiny dim">No pinout mapped — open the editor to add pins.</td></tr>}
          </tbody>
        </table>
        <div className="mc-hookup-side">
          {profile.asciiConnector
            ? <pre className="mc-ascii">{profile.asciiConnector}</pre>
            : <div className="tiny dim">No connector diagram.</div>}
          {bus && (
            <div className="mc-bus-facts">
              <div><span className="dim">Bus</span> <b>{bus.name} · {bus.protocol.toUpperCase()}</b></div>
              <div><span className="dim">Speed</span> <b className="mono">{(bus.bitrate / 1000).toFixed(0)}k{bus.fd ? " FD" : ""}</b></div>
              {(bus.requestId || bus.responseId) && <div><span className="dim">Diag</span> <b className="mono">{bus.requestId || "?"} → {bus.responseId || "?"}</b></div>}
              <div><span className="dim">Terminate</span> <b>{bus.termination ? "120Ω" : "not required"}</b></div>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <ConnectorEditor
          initial={profile.connector ?? connectorFromHookup(profile.hookup)}
          onSave={saveConnector}
          onCancel={() => setEditing(false)}
        />
      )}
      {profile.cautions.length > 0 && (
        <details className="mc-cautions"><summary>⚠ Before you power it ({profile.cautions.length})</summary>
          <ul>{profile.cautions.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </details>
      )}
      {err && <div className="mc-err" style={{ marginTop: 8 }}>{err}</div>}
    </section>
  );
}

/**
 * The run ledger — how many AI-explorer runs have hit THIS unit, what the latest one
 * newly discovered, and the button to run another. The workspace's memory of itself.
 */
function RunsSection({ runs, online, canRun, onRun }: {
  runs: ExplorerRun[];
  online: boolean;
  canRun: boolean;
  onRun: () => void;
}) {
  const [open, setOpen] = useState(false);
  const latest = runs[0];
  const shown = open ? runs : runs.slice(0, 3);
  const fmtWhen = (iso: string) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d.getTime()) ? d.toLocaleString() : iso; };
  const runLabel = canRun ? "🧠 Run AI explorer" : online ? "Bring the bus up to run" : "Connect the Pi to run";

  return (
    <section className="mc-card mc-runs">
      <h4>AI explorer runs
        <span className="mc-runs-count">{runs.length}</span>
        <button className="tiny primary" style={{ marginLeft: "auto" }} disabled={!canRun} onClick={onRun}>{runLabel}</button>
      </h4>

      {runs.length === 0 ? (
        <div className="tiny dim">No runs yet. Each run drives the module autonomously (read-only), records what it found, and feeds everything known so far into the next run — so the map of this exact unit keeps sharpening.</div>
      ) : (<>
        {latest && latest.newFindings.length > 0 && (
          <div className="mc-runs-new">
            <b>Latest run added {latest.newFindings.length} new {latest.newFindings.length === 1 ? "finding" : "findings"}:</b>
            <ul>{latest.newFindings.slice(0, 6).map((f, i) => <li key={i}>{f}</li>)}</ul>
          </div>
        )}
        <ul className="mc-runs-list">
          {shown.map((r) => (
            <li key={r.id}>
              <span className={`badge ${r.outcome === "concluded" ? "ok" : r.outcome === "error" ? "danger" : "warn"} tiny`}>{r.outcome}</span>
              <span className="tiny">{fmtWhen(r.startedAt)}</span>
              <span className="tiny dim">· {r.newFindings.length} new · {r.steps} steps · {(r.tokensIn + r.tokensOut).toLocaleString()} tok</span>
              {r.result?.confidence && <span className="tiny dim">· {r.result.confidence} conf</span>}
            </li>
          ))}
        </ul>
        {runs.length > 3 && <button className="tiny" onClick={() => setOpen(!open)}>{open ? "Show less" : `Show all ${runs.length}`}</button>}
      </>)}
    </section>
  );
}

/** Show a stored identification value readably: decode ASCII if it's raw hex bytes. */
function prettyIdValue(v: string): string {
  const s = (v || "").trim();
  if (!s) return "—";
  if (/^[0-9A-Fa-f\s]+$/.test(s) && s.replace(/\s/g, "").length >= 4) {
    const a = identifierAscii(s);
    if (a && a.replace(/[^A-Za-z0-9]/g, "").length >= 3) return a;
  }
  return s;
}

function fmtHex(h: string): string { return (h || "").toUpperCase().replace(/\s+/g, "").replace(/(..)/g, "$1 ").trim(); }
function asciiOf(h: string): string {
  const bytes = (h || "").replace(/\s+/g, "").match(/../g) ?? [];
  const printable = bytes.map((b) => { const n = parseInt(b, 16); return n >= 32 && n < 127 ? String.fromCharCode(n) : "·"; }).join("");
  return /[A-Za-z0-9]{3,}/.test(printable) ? `ascii: ${printable}` : "";
}
function nrcText(nrc?: number): string {
  const map: Record<number, string> = {
    0x11: "service not supported", 0x12: "sub-function not supported", 0x13: "wrong length/format",
    0x22: "conditions not correct", 0x31: "request out of range", 0x33: "security access denied",
    0x35: "invalid key", 0x78: "response pending", 0x7f: "service not in active session",
  };
  return nrc != null ? (map[nrc] ?? "see ISO 14229") : "";
}

const CAP_STATUS: Record<string, { cls: string; label: string; icon: string }> = {
  supported: { cls: "ok", label: "supported", icon: "✓" },
  gated: { cls: "warn", label: "gated", icon: "⚠" },
  unsupported: { cls: "dim", label: "not supported", icon: "✗" },
  unknown: { cls: "dim", label: "unknown", icon: "?" },
};

/** One canonical operation row on the capability board — identical for every module. */
function CapabilityRow({ cap, busUp, busy, anyBusy, resp, onRead }: {
  cap: ResolvedCapability; busUp: boolean; busy: boolean; anyBusy: boolean;
  resp?: SeqItem; onRead?: () => void;
}) {
  const s = CAP_STATUS[cap.status] ?? CAP_STATUS.unknown;
  const canRead = !cap.write && (cap.status === "supported" || cap.status === "gated") && !!cap.request && !!onRead;
  return (
    <div className={`mc-op st-${cap.status}`}>
      <span className="mc-op-icon">{s.icon}</span>
      <div className="mc-op-txt">
        <div className="mc-op-label">{cap.label}{cap.request ? <span className="tiny dim mono"> {cap.session ? `${cap.session} → ` : ""}{cap.request}</span> : null}</div>
        <div className="tiny dim">{cap.detail || cap.blurb}{cap.nrc ? ` · ${cap.nrc}` : ""}</div>
        {resp && (resp.response && !resp.negative
          ? <HexGrid hex={resp.response} />
          : <div className="tiny dim mono mc-op-resp">{resp.negative ? `negative 7F · NRC 0x${(resp.nrc ?? 0).toString(16).toUpperCase().padStart(2, "0")}` : "no response"}</div>)}
      </div>
      <div className="mc-op-right">
        <span className={`badge ${s.cls} tiny`}>{s.label}</span>
        {canRead && <button className="tiny" disabled={anyBusy || !busUp} onClick={onRead}>{busy ? "…" : "Read"}</button>}
        {cap.write && (cap.status === "supported" || cap.status === "gated") && <span className="tiny dim">🔒 Ceremony</span>}
      </div>
    </div>
  );
}

/** Render a hex payload as an indexed byte grid; bytes that changed since the last
 * read are highlighted — so live signals in a packed block are easy to spot. */
function HexGrid({ hex, changed }: { hex: string; changed?: Set<number> }) {
  const bytes = (hex || "").replace(/\s+/g, "").match(/../g) ?? [];
  return (
    <div className="mc-hexgrid">
      {bytes.map((byte, i) => (
        <span key={i} className={`mc-hb${changed?.has(i) ? " chg" : ""}${i % 8 === 0 ? " mark" : ""}`} title={`byte ${i}`}>{byte.toUpperCase()}</span>
      ))}
    </div>
  );
}

const CLONE_TIER_LABEL: Record<string, string> = { reliable: "RELIABLE", supplemental: "SUPPLEMENTAL", partial: "PARTIAL", "last-resort": "LAST RESORT" };
const CLONE_VERDICT_LABEL: Record<string, string> = {
  "cloneable-bench": "Cloneable · bench", "cloneable-advanced": "Cloneable · advanced",
  partial: "Partial clone", "not-cloneable": "Not cloneable here",
};

function CloneGuidePanel({ g }: { g: NonNullable<BenchModuleProfile["cloneGuide"]> }) {
  const vClass = g.verdict === "cloneable-bench" ? "ok" : g.verdict === "cloneable-advanced" ? "info" : g.verdict === "partial" ? "warn" : "danger";
  return (
    <section className="mc-card mc-clone">
      <h4>Clone — memory read <span className="tiny dim">the source dump for a bench clone</span></h4>
      <div className="mc-clone-verdict">
        <span className={`badge ${vClass}`}>✓ {CLONE_VERDICT_LABEL[g.verdict] ?? g.verdict}</span>
        <b>{g.headline}</b>
      </div>
      <p className="tiny mc-clone-summary">{g.summary}</p>
      <div className="mc-clone-methods">
        {g.methods.map((m, i) => (
          <div key={i} className={`mc-method t-${m.tier}`}>
            <div className="mc-method-h"><b>{m.name}</b><span className="mc-method-tier">{CLONE_TIER_LABEL[m.tier] ?? m.tier}</span></div>
            <div className="tiny">{m.how}</div>
            {m.tools && <div className="tiny dim">Tools: {m.tools}</div>}
          </div>
        ))}
      </div>
      {g.memoryMap && g.memoryMap.length > 0 && (
        <>
          <div className="tiny dim" style={{ margin: "10px 0 4px" }}>What's inside — and how each part is read</div>
          <table className="mc-clone-map">
            <thead><tr><th>Region</th><th>Size</th><th>Holds</th><th>Read via</th></tr></thead>
            <tbody>{g.memoryMap.map((r, i) => (
              <tr key={i}><td>{r.region}</td><td className="mono tiny">{r.size}</td><td className="tiny">{r.holds}</td><td className="tiny dim">{r.readVia}</td></tr>
            ))}</tbody>
          </table>
        </>
      )}
      {g.donorNote && <div className="mc-clone-donor tiny">🔑 <b>Donor matching:</b> {g.donorNote}</div>}
      {g.safeOrder && g.safeOrder.length > 0 && (
        <div className="mc-clone-order">
          <div className="mc-clone-order-h">Proceed with the clone — the safe order</div>
          <ol>{g.safeOrder.map((s, i) => <li key={i} className="tiny">{s}</li>)}</ol>
        </div>
      )}
    </section>
  );
}

const styles = `
.mc { display: flex; flex-direction: column; gap: 12px; max-width: 960px; }
.mc-head { display: flex; align-items: center; gap: 12px; }
.mc-title { font-size: 17px; font-weight: 700; }
.mc-cat { font-size: 11px; color: var(--fg-2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; margin-left: 6px; }
.mc-body { display: flex; flex-direction: column; gap: 12px; }
.mc-toolbar { display: flex; align-items: center; gap: 10px; margin: -2px 0 -4px; }
.mc-empty { background: var(--bg-1); border: 1px solid var(--border); border-radius: 12px; padding: 20px; font-size: 13px; color: var(--fg-1); line-height: 1.6; }
.mc-realbar { display: flex; align-items: center; gap: 10px; }

/* Hook-up section */
.mc-hookup-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 14px; align-items: start; }
.mc-power { display: flex; gap: 8px; align-items: center; background: rgba(251,191,36,.08); border: 1px solid rgba(251,191,36,.25); border-radius: 8px; padding: 7px 10px; font-size: 12.5px; margin-bottom: 10px; }
.mc-pins { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.mc-pins th { text-align: left; font-weight: 500; color: var(--fg-2); font-size: 11px; padding: 0 6px 6px 0; }
.mc-pins td { padding: 5px 6px 5px 0; border-top: 1px solid var(--border); vertical-align: top; }
.mc-pins tr.req td { }
.mc-hookup-side { display: flex; flex-direction: column; gap: 10px; }
.mc-ascii { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 11px; line-height: 1.35; overflow-x: auto; margin: 0; }
.mc-bus-facts { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.mc-bus-facts .dim { display: inline-block; min-width: 66px; }
.mc-cautions { margin-top: 10px; font-size: 12.5px; }
.mc-cautions summary { cursor: pointer; color: var(--fg-2); }
.mc-cautions ul { margin: 6px 0 0; padding-left: 18px; line-height: 1.7; }

/* Connect strip */
.mc-orb { width: 22px; height: 22px; border-radius: 50%; background: radial-gradient(circle at 40% 35%, var(--accent), transparent 70%); opacity: .4; flex: none; }
.mc-orb[data-state="online"] { background: radial-gradient(circle at 40% 35%, var(--ok, #34d399), transparent 70%); opacity: .8; }
.mc-orb[data-state="connecting"] { animation: mcpulse 1s ease-in-out infinite; opacity: .8; }
.mc-orb[data-state="error"] { background: radial-gradient(circle at 40% 35%, var(--danger), transparent 70%); opacity: .7; }

/* Runs section */
.mc-runs-count { background: var(--bg-2); border: 1px solid var(--border); border-radius: 20px; padding: 0 8px; font-size: 11px; color: var(--fg-1); }
.mc-runs-new { background: rgba(52,211,153,.07); border: 1px solid rgba(52,211,153,.22); border-radius: 8px; padding: 8px 11px; font-size: 12.5px; margin-bottom: 8px; }
.mc-runs-new ul { margin: 5px 0 0; padding-left: 18px; line-height: 1.65; }
.mc-runs-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.mc-runs-list li { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 4px 0; border-top: 1px solid var(--border); }

/* Session strip + Autel-style function menu */
.mc-sessions { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
.mc-fnmenu { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 8px; }
.mc-fn { display: flex; align-items: center; gap: 9px; text-align: left; background: var(--bg-1); border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; cursor: pointer; transition: border-color .12s, background .12s; }
.mc-fn:hover { border-color: var(--border-strong); }
.mc-fn.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 9%, var(--bg-1)); }
.mc-fn-ico { font-size: 18px; flex: none; }
.mc-fn-txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.mc-fn-txt b { font-size: 12.5px; }
.mc-fn-blurb { font-size: 10.5px; color: var(--fg-2); line-height: 1.25; }

/* Live-data decoded value */
.mc-block-val { font-size: 19px; font-weight: 600; color: var(--accent); margin: 4px 0 2px; display: flex; align-items: center; gap: 7px; font-variant-numeric: tabular-nums; }
.mc-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok, #34d399); animation: mcpulse 1.1s ease-in-out infinite; }
.mc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.mc-card { background: var(--bg-1); border: 1px solid var(--border); border-radius: 12px; padding: 13px 15px; }
.mc-card h4 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: var(--fg-2); display: flex; align-items: center; gap: 8px; }
.mc-live { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.mc-live-cell { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.mc-live-v { font-size: 18px; font-weight: 600; color: var(--accent); }
.mc-live-u { font-size: 11px; color: var(--fg-2); margin-left: 3px; }
.mc-live-l { font-size: 11px; color: var(--fg-2); margin-top: 2px; }
.mc-kv { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.mc-kv td { padding: 4px 8px 4px 0; border-top: 1px solid var(--border); }
.mc-dtcs { margin: 0; padding-left: 16px; font-size: 12.5px; line-height: 1.9; }
.mc-caps { display: flex; flex-direction: column; gap: 5px; }
.mc-cap { display: flex; align-items: center; gap: 8px; font-size: 12.5px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; padding: 5px 9px; }
.mc-cap.risk { border-color: rgba(251,191,36,.3); }
.mc-cap .mono { color: var(--fg-2); min-width: 64px; }
.mc-connect { text-align: center; padding: 40px 20px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.mc-connect h3 { margin: 6px 0 0; }
.mc-connect-orb { width: 54px; height: 54px; border-radius: 50%; background: radial-gradient(circle at 40% 35%, var(--accent), transparent 70%); opacity: .35; }
.mc-connect-orb[data-state="connecting"] { animation: mcpulse 1s ease-in-out infinite; opacity: .7; }
.mc-connect-orb[data-state="error"] { background: radial-gradient(circle at 40% 35%, var(--danger), transparent 70%); opacity: .6; }
@keyframes mcpulse { 0%,100% { transform: scale(1); opacity: .5; } 50% { transform: scale(1.15); opacity: .9; } }
.mc-host { width: 240px; }
.mc-host, .mc-id, .mc-req, .mc-sel { background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; color: var(--fg-0); padding: 6px 9px; font-size: 12.5px; }
.mc-sel { margin-left: 6px; }
.mc-id { width: 72px; margin-left: 5px; }
.mc-req { flex: 1; }
.mc-presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; margin-top: 10px; }
.mc-preset { display: flex; flex-direction: column; gap: 2px; text-align: left; background: var(--bg-2); border: 1px solid var(--border); border-radius: 7px; padding: 7px 10px; cursor: pointer; font-size: 12.5px; }
.mc-preset:hover:not(:disabled) { border-color: var(--accent); }
.mc-preset:disabled { opacity: .5; cursor: not-allowed; }
.mc-log { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow-y: auto; font-size: 12.5px; }
.mc-log-line { display: flex; gap: 8px; padding: 4px 6px; border-radius: 6px; }
.mc-log-line.tx { background: rgba(96,165,250,.06); }
.mc-log-line.rx { background: rgba(74,222,128,.06); }
.mc-log-line.err { background: var(--danger-dim); }
.mc-log-tag { color: var(--fg-2); }
.mc-bus { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.mc-bus th { text-align: left; font-weight: 500; color: var(--fg-2); font-size: 11px; padding: 0 8px 5px 0; }
.mc-bus td { padding: 4px 8px 4px 0; border-top: 1px solid var(--border); }
.mc-canid { color: var(--info); font-weight: 700; }
.mc-busbytes { color: var(--fg-1); letter-spacing: .04em; transition: color .1s, background .1s; }
.mc-busbytes.chg { color: var(--accent); background: rgba(74,222,128,.10); border-radius: 4px; }
.mc-verify { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-2); border: 1px solid var(--accent); border-radius: 10px; padding: 11px 14px; }
.mc-verify.ok { border-color: var(--border-strong); }
.mc-verify b { color: var(--accent); }
.mc-err { font-size: 12px; color: var(--danger); background: var(--danger-dim); border: 1px solid var(--danger); border-radius: 8px; padding: 8px 11px; }
/* capability surface */
.mc-cap-row { display: flex; gap: 10px; align-items: flex-start; margin: 8px 0; }
.mc-cap-lbl { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--fg-2); width: 66px; flex-shrink: 0; padding-top: 3px; }
.mc-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.mc-chip { font-size: 11.5px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; }
.mc-caps { margin: 8px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.6; color: var(--fg-1); }
/* capability board */
.mc-board { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 10px; }
.mc-board-col { display: flex; flex-direction: column; gap: 6px; }
.mc-board-h { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-1); font-weight: 600; margin-bottom: 2px; }
.mc-op { display: flex; gap: 9px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--border); border-left-width: 3px; border-radius: 8px; background: var(--bg-2); }
.mc-op.st-supported { border-left-color: var(--accent); }
.mc-op.st-gated { border-left-color: var(--warn); }
.mc-op.st-unsupported { border-left-color: var(--border-strong); opacity: .62; }
.mc-op.st-unknown { border-left-color: var(--border-strong); opacity: .8; }
.mc-op-icon { flex-shrink: 0; width: 16px; text-align: center; font-size: 12px; color: var(--fg-2); padding-top: 1px; }
.mc-op.st-supported .mc-op-icon { color: var(--accent); }
.mc-op.st-gated .mc-op-icon { color: var(--warn); }
.mc-op-txt { flex: 1; min-width: 0; }
.mc-op-label { font-size: 12.5px; font-weight: 500; }
.mc-op-resp { margin-top: 5px; word-break: break-all; }
.mc-op-right { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; flex-shrink: 0; }
/* live blocks */
.mc-blocks { display: flex; flex-direction: column; gap: 8px; }
.mc-block { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--bg-2); }
.mc-block-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.mc-block-resp { margin-top: 6px; word-break: break-all; color: var(--fg-1); }
.mc-hexgrid { display: flex; flex-wrap: wrap; gap: 2px; margin-top: 6px; }
.mc-hb { font-family: var(--mono); font-size: 11px; padding: 2px 4px; border-radius: 3px; background: var(--bg-0); color: var(--fg-1); min-width: 22px; text-align: center; border: 1px solid transparent; transition: background .12s, color .12s, border-color .12s; }
.mc-hb.mark { box-shadow: inset 2px 0 0 var(--border-strong); }
.mc-hb.chg { background: rgba(74,222,128,.18); color: var(--accent); border-color: var(--accent); }
/* clone guide */
.mc-clone-verdict { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 4px 0 6px; }
.mc-clone-summary { line-height: 1.6; color: var(--fg-1); }
.mc-clone-methods { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.mc-method { border: 1px solid var(--border); border-left-width: 3px; border-radius: 8px; padding: 9px 11px; background: var(--bg-2); }
.mc-method.t-reliable { border-left-color: var(--accent); }
.mc-method.t-supplemental { border-left-color: var(--info); }
.mc-method.t-partial { border-left-color: var(--warn); }
.mc-method.t-last-resort { border-left-color: var(--danger); }
.mc-method-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.mc-method-tier { font-size: 9px; letter-spacing: .05em; color: var(--fg-2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
.mc-clone-map { width: 100%; border-collapse: collapse; font-size: 12px; }
.mc-clone-map th { text-align: left; font-weight: 500; color: var(--fg-2); font-size: 10.5px; padding: 0 8px 4px 0; }
.mc-clone-map td { padding: 4px 8px 4px 0; border-top: 1px solid var(--border); vertical-align: top; }
.mc-clone-donor { background: rgba(180,140,40,.10); border: 1px solid var(--warn); border-radius: 8px; padding: 9px 11px; margin-top: 10px; line-height: 1.55; }
.mc-clone-order { margin-top: 10px; border: 1px solid var(--accent); border-radius: 8px; padding: 9px 12px; background: var(--bg-2); }
.mc-clone-order-h { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--accent); margin-bottom: 5px; }
.mc-clone-order ol { margin: 0; padding-left: 18px; line-height: 1.7; }
@media (max-width: 720px) { .mc-grid { grid-template-columns: 1fr; } .mc-clone-methods { grid-template-columns: 1fr; } .mc-board { grid-template-columns: 1fr; } }
`;
