/**
 * vehicle — the vehicle pipeline from the command line, against a Super Device
 * at a given address. No Electron: it runs the SAME steps the app runs
 * (electron/pipeline/vehiclePipeline.ts → electron/resolver/*), so a problem
 * found here at the car is a problem in the app's pipeline, and a fix here is a
 * fix there.
 *
 *   pnpm vehicle --host <addr> run --map ecm                           (repo root; rebuilds first)
 *   node apps/desktop/dist-cli/vehicle.cjs --host <addr> <command>     (after one build)
 *
 * Everything it sends to the car is a READ: VIN, tester-present, identification
 * DIDs, OBD modes 01/03/07/09/0A, DTC reads, and whatever the read-only AI
 * explorer allows itself. There is no command here that writes to a module.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { VehicleModule, VehicleProfile } from "@ecu/vehicle-db";
import { checkRequest, coverageOf, dtcMeaning, explorationFaults, knowledgeCard, labelSummary, protectedModule, resolveVehicleIdentity, searchCatalog, vehicleCatalog } from "@ecu/vehicle-db";
import type { ProtectedKind } from "@ecu/vehicle-db";
import { resolveWorkspaceRoot } from "@ecu/workspace";

import {
  bindVin, captureDiagnostics, censusAndSave, commitDiscovery, deepMapAndSave, discoverOnBus, discoveredFromProfile, knownAddressesOf,
  loadLibrary, piGet, piPost, readVin, targetFor,
} from "../electron/pipeline/vehiclePipeline";
import type { DiscoveredModule, VehicleExplorerEvent } from "../electron/resolver/vehicleExplorer";
import { identifyAndSave } from "../electron/pipeline/identityPipeline";
import { sweepAndSave } from "../electron/pipeline/sweepPipeline";
import { benchModules, PRICES, runBench, summarise, type TruthVehicle } from "../electron/pipeline/calibration";
import { labelAndSave, labelPrompts, labelSweeps, recheckAndSave } from "../electron/pipeline/labelPipeline";
import { buildKnowledge, loadKnowledge, syncSources } from "../electron/pipeline/knowledgeSources";
import { readCatalogItems } from "../electron/pipeline/readCatalog";
import { askMechanic } from "../electron/resolver/mechanic";
import { ensureSimLibrary, isSimulatorTarget, realLibraryDir, simLibraryDir } from "../electron/pipeline/simLibrary";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { getApiKey } from "./settings";

const HELP = `vehicle — run the vehicle pipeline against a Super Device, no Electron.

  vehicle --host <address[:port]> [options] <command>

Commands
  status                      device, buses, virtual vehicle, recorder, daemon version
  up [--bitrate 500000]       bring the bus up            down   take it down
  vin                         read the VIN → NHTSA decode → bind / file the library vehicle
  discover [--deep [--ext]]   probe every diagnostic address (+ the vehicle's known ones; --deep = sweep 600-7FF first,
                              automatic on a first discovery; --ext adds 29-bit), read each module's identification, save
  census                      AI names every discovered module (1 API call), save
  identify [<module>]         read every module's identity — part numbers, software/hardware versions, SERIAL
                              NUMBER, supplier, build date, the VIN it holds — and file it under the car's VIN.
                              No AI, identification reads only; airbag / immobiliser in their current session only.
                              [--no-ext] skips the extended-session second pass
  modules                     the bound vehicle's modules and how far each is mapped
  map <module>                AI deep-map of ONE module, live and read-only, save
                              (<module> = its id, an address like 7E8, or part of its name)
  capture [--note TEXT]       diagnostic capture → <workspace>/reports/capture-*.json
  run [--map <module>] [--label TEXT] [--no-census] [--deep [--ext] | --no-deep]
                              vin → discover → census → identify → (map) → capture, recorded as one session
                              on the device and fetched here at the end
  sweep [<module>] [--condition TEXT] [--wide]
                              completeness sweep: read EVERY identifier in the standard ranges of each module
                              (UDS 22 0100-03FF, F100-F1FF, F400-F4FF on engine/gearbox; KWP 21 00-FF, 1A 80-9F),
                              twice, and save what answers. No AI. Never on airbag / immobiliser modules.
                              --condition says what the car was doing ("engine off", "idling"); --wide adds 0400-0FFF
  coverage [<module>]         what the AI map knows of what each module answers (needs a sweep): coverage %,
                              moving values the map does not list as live data, identifiers it never mentions
  sources [sync | build]      outside knowledge: "build" rebuilds offline from what was downloaded; "sync" downloads OBDb (community signal sets, CC BY-SA 4.0) and
                              OBDex (fault-code meanings, CC0) into <workspace>/knowledge and builds one base
  knowledge [--all]           what is known about the bound vehicle: modules, standard values, fault-code meanings,
                              community definitions tested on this car's own recordings, our own mapping. Offline
  dtc <code> [<code>…]        the public meaning of fault codes (OBDex). Offline
  ask "<question>" | --catalog the read-only mechanic assistant: it finds and reads values of the bound vehicle and
                              explains its fault codes; --catalog lists what it may read. Costs API tokens
  label <module> [--dry [--show]] [--recheck | --missing]
                              AI names for every swept identifier of one module, then checked by code against the
                              car's own readings (which the AI is not shown). Offline: no device, no car. Costs API
                              tokens; --dry only shows how much would be asked; --recheck checks stored labels again without AI;
                              --missing asks only about identifiers without a label
  bench [--vehicle corolla] [--modules ecm,tcm,abs] [--models M1,M2] [--runs N] [--port 8771]
                              calibration: run the AI deep map on a virtual car whose every identifier is known
                              (desk simulator, started if needed) and score it — data IDs found, labels right,
                              invented, sessions, fault codes, refused requests, cost. Nothing is saved to the
                              vehicle library; the scorecard goes to <workspace>/calibration/. Costs API tokens.
  audit <recording id|path>   prove a recorded session was read-only: every request sent is checked against the
                              read-only policy (airbag / immobiliser addresses with the stricter rule). No device
                              needed — works on fetched recordings. Exit code 1 if anything was not a read.
  rec status | start <label> | stop | list | fetch [<id>]
                              the device's ISO-TP recorder; fetch copies recordings to
                              <workspace>/recordings/<device>/ (no id: every one not yet here)
  sim start [corolla|f150] | replay <recording id> | stop | status   [--on vcan0|can1]
                              the virtual vehicle. --on vcan0 needs no wiring; can1 needs
                              the can1↔can0 jumper. Default: vcan0 when --iface is vcan0, else can1.

Options
  --host ADDR        the device (or env SD_HOST), e.g. 100.91.185.100 or 192.168.1.67:8080
  --iface NAME       bus the car is on: can0 (default), can1, or vcan0 (virtual vehicle, no jumper)
  --vin VIN          work on this VIN's library vehicle instead of the last one read
  --profile ID       work on this library vehicle id (e.g. 2020-toyota-corolla)
  --workspace DIR    runtime folder (default: ECL_WORKSPACE_ROOT or <repo>/.runtime — the dev app's)
  --json             print the command's result as one JSON object on stdout (progress goes to stderr)

AI steps (census, map) need ANTHROPIC_API_KEY in the environment or in <repo>/.env.`;

// ---- small plumbing -------------------------------------------------------------

interface Args { _: string[]; flags: Record<string, string | boolean> }
const BOOL_FLAGS = new Set(["deep", "no-deep", "ext", "no-ext", "json", "help", "no-census", "all", "wide", "dry", "show", "recheck", "missing", "catalog"]);

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "-h") { out.flags.help = true; continue; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = (eq === -1 ? a.slice(2) : a.slice(2, eq));
      if (eq !== -1) out.flags[key] = a.slice(eq + 1);
      else if (BOOL_FLAGS.has(key)) out.flags[key] = true;
      else if (i + 1 < argv.length) out.flags[key] = argv[++i];
      else throw new UsageError(`--${key} needs a value`);
    } else out._.push(a);
  }
  return out;
}

class UsageError extends Error {}

/** The repo root: walk up from the bundle until the workspace package.json. */
function findProjectRoot(): string {
  let cursor = __dirname;
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cursor, "package.json"), "utf8")) as { name?: string; workspaces?: unknown };
      if (pkg.workspaces || pkg.name === "ecu-clone-lab") return cursor;
    } catch { /* keep walking */ }
    cursor = path.dirname(cursor);
  }
  return process.cwd();
}

/** Same rule as the app's loader (electron/main.ts): <repo>/.env fills in what the shell did not set. */
function loadEnvFile(projectRoot: string): void {
  let raw: string;
  try { raw = fs.readFileSync(path.join(projectRoot, ".env"), "utf8"); } catch { return; }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    const hash = value.indexOf(" #");
    if (hash !== -1) value = value.slice(0, hash).trim();
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
  }
}

interface Ctx {
  host: string; iface: string; json: boolean;
  root: string; ws: string; vehicleLibDir: string; reportsDir: string; recordingsDir: string; stateFile: string;
  appVersion: string; args: Args;
}
interface State { host?: string; iface?: string; vin?: string; profileId?: string; at?: string }

let JSON_MODE = false;
/** Progress for a person. In --json mode it goes to stderr so stdout stays one JSON object. */
function say(line = ""): void { (JSON_MODE ? process.stderr : process.stdout).write(line + "\n"); }

const oneLine = (s: string, max = 220) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; };
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const norm = (s?: string) => (s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");
const ymm = (p: { year: number | null; make: string; model: string; trim?: string }) => [p.year, p.make, p.model, p.trim].filter(Boolean).join(" ");

async function readState(ctx: Ctx): Promise<State> {
  try { return JSON.parse(await readFile(ctx.stateFile, "utf8")) as State; } catch { return {}; }
}
async function writeState(ctx: Ctx, patch: State): Promise<void> {
  const next = { ...(await readState(ctx)), ...patch, host: ctx.host, iface: ctx.iface, at: new Date().toISOString() };
  await mkdir(path.dirname(ctx.stateFile), { recursive: true });
  await writeFile(ctx.stateFile, JSON.stringify(next, null, 2), "utf8");
}

/** The library vehicle a command works on: --profile, else --vin, else the last one `vin`/`run` bound. */
async function currentProfile(ctx: Ctx): Promise<VehicleProfile> {
  const lib = await loadLibrary(ctx.vehicleLibDir);
  const wantId = typeof ctx.args.flags.profile === "string" ? ctx.args.flags.profile : undefined;
  const wantVin = typeof ctx.args.flags.vin === "string" ? ctx.args.flags.vin.toUpperCase() : undefined;
  if (wantId) {
    const p = lib.find((x) => x.id === wantId);
    if (!p) throw new Error(`No library vehicle "${wantId}". Known: ${lib.map((x) => x.id).join(", ")}`);
    return p;
  }
  const st = await readState(ctx);
  const vin = wantVin ?? st.vin;
  if (vin) {
    const bound = resolveVehicleIdentity(lib, vin).bound?.profile;
    if (bound) return bound;
  }
  if (!wantVin && st.profileId) {
    const p = lib.find((x) => x.id === st.profileId);
    if (p) return p;
  }
  throw new Error(wantVin
    ? `VIN ${wantVin} is not bound to a library vehicle yet — run "vin" with the car connected.`
    : `No vehicle selected yet — run "vin" first (or pass --profile <id> / --vin <VIN>).`);
}

function findModule(profile: VehicleProfile, query: string): VehicleModule {
  const q = query.trim();
  const addressed = profile.modules.filter((m) => m.addressing?.response);
  const exact = addressed.filter((m) => m.id.toLowerCase() === q.toLowerCase() || norm(m.addressing?.response) === norm(q) && norm(q).length >= 3 || norm(m.addressing?.request) === norm(q) && norm(q).length >= 3);
  const hits = exact.length ? exact : addressed.filter((m) => m.label.toLowerCase().includes(q.toLowerCase()));
  if (hits.length === 1) return hits[0];
  const list = addressed.map((m) => `  ${pad(m.id, 14)} ${pad(`${m.addressing?.request ?? "?"}→${m.addressing?.response}`, 20)} ${m.label}`).join("\n");
  throw new Error(`${hits.length ? `"${q}" matches ${hits.length} modules` : `No module matches "${q}"`} on ${ymm(profile)}. Modules with an address:\n${list || "  (none — run discover first)"}`);
}

function needKey(step: string): void {
  if (!getApiKey()) throw new Error(`${step} needs an Anthropic API key: set ANTHROPIC_API_KEY in the environment or in <repo>/.env (the key saved in the app's Settings is encrypted for the app only).`);
}

interface DaemonVersion { daemon_sha256?: string; uptime_s?: number; features?: string[] }
interface RecStatus { recording: boolean; session: { id: string; label?: string; bytes?: number } | null; dir: string; free_mb: number; error: string | null }
async function daemonVersion(ctx: Ctx): Promise<DaemonVersion | null> {
  try { return (await piGet(ctx.host, "/api/version", 6000)) as DaemonVersion; } catch { return null; }
}

// ---- commands -------------------------------------------------------------------

async function cmdStatus(ctx: Ctx) {
  type Iface = { name: string; present: boolean; up?: boolean; bitrate?: number; canstate?: string; rx?: number; tx?: number; rxerr?: number; role?: string };
  const status = (await piGet(ctx.host, "/api/status")) as { ifaces: Iface[]; virtual?: Iface[]; sys: { temp?: number; uptime?: string } };
  const device = (await piGet(ctx.host, "/api/device")) as { hostname?: string; ip?: string; ssid?: string; model?: string; claim?: { owner: string; expires_in: number } | null; battery?: { present: boolean; percent?: number; external_power?: boolean } };
  const sim = (await piGet(ctx.host, "/api/sim/status")) as { running: boolean; vehicle?: string; iface?: string };
  const version = await daemonVersion(ctx);
  let rec: RecStatus | null = null;
  if (version?.features?.includes("recorder")) { try { rec = (await piGet(ctx.host, "/api/rec/status")) as RecStatus; } catch { rec = null; } }
  const b = device.battery;
  say(`Device    ${device.hostname ?? "?"} (${device.model ?? "?"}) at ${ctx.host} · LAN ${device.ip || "?"} · Wi-Fi ${device.ssid || "?"}${b?.present ? ` · battery ${b.percent}%${b.external_power === false ? " ON CELLS" : ""}` : ""} · ${status.sys.temp ?? "?"}°C · ${status.sys.uptime ?? ""}`);
  say(`Daemon    ${version ? `${(version.daemon_sha256 ?? "").slice(0, 12)} · running ${Math.round((version.uptime_s ?? 0) / 60)} min · ${version.features?.join(", ")}` : "an older build (no /api/version, no recorder) — deploy the current one"}`);
  for (const i of [...status.ifaces, ...(status.virtual ?? [])]) {
    say(`Bus       ${pad(i.name, 6)} ${!i.present ? "MISSING" : i.up ? `UP ${i.bitrate ? `${i.bitrate / 1000}k ` : ""}${i.canstate || ""} rx ${i.rx} tx ${i.tx}${i.rxerr ? ` errors ${i.rxerr}` : ""}` : "down"}${i.role ? `  (${i.role})` : ""}${i.name === ctx.iface ? "   ← --iface" : ""}`);
  }
  say(`Sim       ${sim.running ? `${sim.vehicle} on ${sim.iface}` : "not running"}`);
  say(`Recorder  ${rec ? (rec.error ? `NOT RECORDING — ${rec.error}` : `on → ${rec.session ? `${rec.session.id} (${rec.session.bytes} bytes)` : "the daily file (no named session)"} · ${rec.free_mb} MB free`) : "not available on this daemon"}`);
  say(`Claim     ${device.claim ? `held by ${device.claim.owner} (${device.claim.expires_in}s left)` : "none"}`);
  return { status, device, sim, version, recorder: rec };
}

async function cmdUp(ctx: Ctx, up: boolean) {
  const bitrate = Number(ctx.args.flags.bitrate ?? 500000);
  const r = (await piPost(ctx.host, up ? "/api/up" : "/api/down", up ? { iface: ctx.iface, bitrate, dbitrate: 2000000, fd: false } : { iface: ctx.iface })) as { result: string };
  say(`${ctx.iface} ${up ? `up @ ${bitrate}` : "down"}: ${r.result}`);
  return r;
}

async function cmdVin(ctx: Ctx) {
  say(`Reading the VIN on ${ctx.iface}…`);
  const r = await readVin(ctx.host, ctx.iface);
  if (!(r.ok && r.vin)) {
    say(`No VIN: ${r.error ?? "no answer"}`);
    for (const t of r.tried ?? []) say(`  tried ${t}`);
    return { ok: false, read: r };
  }
  say(`VIN ${r.vin}  (${r.via})`);
  const b = await bindVin(ctx.vehicleLibDir, r.vin);
  const o = b.online;
  say(o.ok
    ? `NHTSA: ${ymm({ year: o.year, make: o.make, model: o.model, trim: o.trim })}${o.engine ? ` · ${o.engine}` : ""}${o.bodyClass ? ` · ${o.bodyClass}` : ""}`
    : `NHTSA could not name it: ${o.errorText ?? "no model in the decode"}`);
  if (!b.saved) {
    say(`Not bound to a library vehicle — nothing certain matches and NHTSA gave no model. discover + capture still work; identity needs the app's Identify stage.`);
    await writeState(ctx, { vin: r.vin, profileId: undefined });
    return { ok: true, vin: r.vin, read: r, online: o, profile: null, kind: null };
  }
  const how = { vin: "known unit — this exact VIN was read before", pattern: "recognised by VIN pattern", ymm: "matched by NHTSA year/make/model", new: "NEW vehicle filed from the NHTSA decode" }[b.kind ?? "new"];
  const mapped = b.saved.modules.filter((m) => m.explored).length;
  say(`Library: ${b.saved.id} — ${ymm(b.saved)} · ${how} · ${b.saved.modules.length} module(s) known, ${mapped} deep-mapped · ${b.saved.knownVins?.length ?? 0} VIN(s) on file`);
  await writeState(ctx, { vin: r.vin, profileId: b.saved.id });
  return { ok: true, vin: r.vin, read: r, online: o, profile: b.saved, kind: b.kind };
}

function printDiscovered(found: DiscoveredModule[]): void {
  for (const d of found) {
    const i = d.ident ?? {};
    say(`  ${pad(`${d.requestId}→${d.responseId}`, 20)} ${pad(d.negative ? "7F" : "ok", 3)} ${pad(i.partNo ?? "—", 20)} ${pad(i.supplier ?? "", 14)} ${d.name}`);
  }
}

/** Discovery: the generic list + every address the profile already knows; with --deep
 * (automatic on a vehicle's first discovery) the device's address sweep runs first. */
async function runDiscover(ctx: Ctx, profile?: VehicleProfile | null): Promise<DiscoveredModule[]> {
  let last = 0;
  const known = knownAddressesOf(profile);
  const deep = !!ctx.args.flags.deep || (!!profile && !profile.fingerprint && !ctx.args.flags["no-deep"]);
  if (deep) say(`  address sweep 600-7FF${ctx.args.flags.ext ? " + 29-bit" : ""} first (${ctx.args.flags.deep ? "--deep" : "first discovery of this vehicle"}; tester-present only, about a minute)…`);
  if (known.length) say(`  + ${known.length} address(es) this vehicle is known to use`);
  const found = await discoverOnBus({
    host: ctx.host, iface: ctx.iface, known,
    deep: deep ? { ext: !!ctx.args.flags.ext } : false,
    onSweep: (r) => say(r.ok
      ? `  sweep: ${r.responders?.length ?? 0} responder(s) in ${r.seconds}s (${r.probed} ids asked, ${Object.keys(r.broadcast ?? {}).length} broadcast id(s) left alone)${(r.unconfirmed?.length ?? 0) ? ` · ${r.unconfirmed!.length} unconfirmed` : ""}`
      : `  sweep failed: ${r.error}`),
    onProgress: (done, total, n) => { if (done - last >= 15 || done === total) { last = done; say(`  probed ${done}/${total} addresses · ${n} answered`); } },
  });
  return found;
}

async function cmdDiscover(ctx: Ctx) {
  const profile = await currentProfile(ctx);
  say(`Discovering modules on ${ctx.iface} for ${ymm(profile)}…`);
  const found = await runDiscover(ctx, profile);
  printDiscovered(found);
  const saved = await commitDiscovery(ctx.vehicleLibDir, profile, found);
  say(`${found.length} module(s) answered — saved to ${saved.id} (${saved.modules.filter((m) => m.addressing?.response).length} with an address).`);
  return { ok: true, discovered: found, profile: saved };
}

async function runCensus(ctx: Ctx, profile: VehicleProfile, discovered: Parameters<typeof censusAndSave>[2]) {
  needKey("The census");
  say(`AI census of ${discovered.length} module(s)…`);
  const { profile: saved, census } = await censusAndSave(ctx.vehicleLibDir, profile, discovered);
  for (const c of census.modules) say(`  ${pad(c.responseId, 9)} ${pad(c.category, 13)} ${pad(c.protocol, 8)} ${pad(c.memoryRead, 12)} ${oneLine(c.label, 70)}`);
  say(`Census saved to ${saved.id} · ${census.modules.length}/${discovered.length} named · tokens in ${census.tokensIn} / out ${census.tokensOut}`);
  return { profile: saved, census };
}

/** Read every module's identity and file it under the car's VIN. Prints records as they arrive. */
async function runIdentify(ctx: Ctx, profile: VehicleProfile, moduleIds?: string[]) {
  const st = await readState(ctx);
  const vin = (typeof ctx.args.flags.vin === "string" ? ctx.args.flags.vin : st.vin ?? "").toUpperCase() || undefined;
  const known = vin && profile.knownVins?.some((o) => o.vin === vin) ? vin : undefined;
  const simStatus = (await piGet(ctx.host, "/api/sim/status").catch(() => null)) as { running?: boolean; vehicle?: string; name?: string; iface?: string } | null;
  const sim = simStatus?.running && (ctx.iface === "vcan0" || /127\.0\.0\.1:8765$/.test(ctx.host)) ? (simStatus.name || simStatus.vehicle || "simulator") : null;
  say(`Reading module identity on ${ctx.iface} for ${ymm(profile)}${known ? ` · VIN ${known}` : " · no VIN bound — the result is shown, not filed per car"}${sim ? ` · SIMULATOR (${sim})` : ""}`);
  const t0 = Date.now();
  const { profile: saved, inventory } = await identifyAndSave(ctx.vehicleLibDir, {
    host: ctx.host, iface: ctx.iface, profile, vin: known, moduleIds, sim, extended: !ctx.args.flags["no-ext"],
    onEvent: (e) => {
      if (e.type === "ident-module" && e.phase === "start") say(`\n  [${e.index + 1}/${e.total}] ${oneLine(e.label, 70)}${e.protectedKind ? `   (protected: ${e.protectedKind} — current session only)` : ""}`);
      else if (e.type === "ident-record") say(`      ${pad(e.record.label, 26)} ${pad(oneLine(e.record.value, 48), 48)} ${e.record.id}${e.record.session === "03" ? " · ext" : ""}`);
      else if (e.type === "ident-module" && e.phase === "done" && e.entry) {
        const x = e.entry;
        if (x.status !== "ok") say(`      → ${x.status}${x.refused?.length ? ` · refused: ${x.refused.slice(0, 6).join(", ")}${x.refused.length > 6 ? "…" : ""}` : ""}${x.note ? ` · ${x.note}` : ""}`);
      }
    },
  });
  const ok = inventory.modules.filter((m) => m.status === "ok").length;
  const serials = inventory.modules.filter((m) => m.summary.serial).length;
  say(`\nIdentity read in ${Math.round((Date.now() - t0) / 1000)} s — ${ok}/${inventory.modules.length} modules identified, ${serials} serial number(s).`);
  say(`  ${pad("module", 8)} ${pad("part no.", 14)} ${pad("serial", 20)} ${pad("software", 24)} supplier`);
  for (const m of inventory.modules) {
    const x = m.summary;
    say(`  ${pad(m.responseId, 8)} ${pad(x.partNo ?? "—", 14)} ${pad(oneLine(x.serial ?? "—", 20), 20)} ${pad(oneLine(x.swPartNo ?? x.swVersion ?? "—", 24), 24)} ${oneLine(x.supplier ?? (m.status === "ok" ? "" : m.status), 24)}`);
  }
  const changes = known ? saved.knownVins?.find((o) => o.vin === known)?.inventoryChanges?.filter((c) => c.at === inventory.at) ?? [] : [];
  if (changes.length) {
    say(`\nCHANGED SINCE THE LAST VISIT (${changes.length}):`);
    for (const c of changes) say(`  ${c.label}: ${c.key} ${c.from} → ${c.to}`);
  }
  say(known ? `Filed under VIN ${known} in ${saved.id}.` : `Part numbers folded into ${saved.id}; bind a VIN ("vin") to keep serial numbers per car.`);
  return { profile: saved, inventory, changes };
}

async function cmdIdentify(ctx: Ctx) {
  const profile = await currentProfile(ctx);
  const q = ctx.args._[1];
  const ids = q ? [findModule(profile, q).id] : undefined;
  const r = await runIdentify(ctx, profile, ids);
  return { ok: true, inventory: r.inventory, changes: r.changes, profile: r.profile.id };
}

/** Find a recording by id (any device folder under recordings/) or take a path. */
function findRecording(recordingsDir: string, ref: string): string {
  if (fs.existsSync(ref)) return ref;
  if (fs.existsSync(recordingsDir)) {
    for (const dev of fs.readdirSync(recordingsDir)) {
      const f = path.join(recordingsDir, dev, `${ref.replace(/\.jsonl$/, "")}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  }
  throw new UsageError(`No recording "${ref}" in ${recordingsDir} — fetch it first (rec fetch ${ref}).`);
}

/** Every request in a recording, checked against the read-only policy. */
async function cmdAudit(ctx: Ctx) {
  const ref = ctx.args._[1];
  if (!ref) throw new UsageError("audit <recording id or path>");
  const file = findRecording(ctx.recordingsDir, ref);
  // which request ids belong to protected modules: from every library vehicle, plus the known Mercedes ones
  const guarded = new Map<string, ProtectedKind>();
  for (const p of await loadLibrary(ctx.vehicleLibDir)) {
    for (const m of p.modules) {
      const k = protectedModule({ category: m.category, label: m.label })?.kind;
      const tx = (m.addressing?.request ?? "").toUpperCase();
      if (k && tx) guarded.set(tx, k);
    }
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const bySid = new Map<string, number>();
  const violations: string[] = [];
  let n = 0, prot = 0, sim: string | null = null;
  for (const line of lines) {
    let e: { type?: string; tx?: string; req?: string; sim?: string; iface?: string; kind?: string };
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "session" && e.sim) sim = e.sim;
    if (e.type !== "x" || !e.req) continue;
    n += 1;
    const tx = (e.tx ?? "").toUpperCase();
    const kind = guarded.get(tx) ?? null;
    if (kind) prot += 1;
    const sid = e.req.slice(0, 2).toLowerCase();
    bySid.set(sid, (bySid.get(sid) ?? 0) + 1);
    const v = checkRequest(e.req, { protectedKind: kind });
    if (!v.ok) violations.push(`${e.iface ?? "?"} ${tx} ${e.req}: ${v.reason}`);
  }
  say(`Audit of ${path.basename(file)}${sim ? ` (virtual vehicle: ${sim})` : ""}`);
  say(`  ${n} request(s) sent · ${prot} to airbag / immobiliser addresses (${[...new Set([...guarded.keys()])].join(", ") || "none known"})`);
  say(`  by service: ${[...bySid.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k.toUpperCase()}×${c}`).join("  ")}`);
  if (violations.length) {
    say(`\n  NOT READ-ONLY — ${violations.length} request(s) outside the policy:`);
    for (const v of violations.slice(0, 40)) say(`    ${v}`);
  } else say(`\n  READ-ONLY: every request was a read the policy allows${prot ? "; protected modules got identity / fault-memory reads only, no session change" : ""}.`);
  return { ok: violations.length === 0, file, requests: n, protectedRequests: prot, services: Object.fromEntries(bySid), violations };
}

/** Completeness sweep of one or every (non-protected) module. */
async function cmdSweep(ctx: Ctx) {
  const profile = await currentProfile(ctx);
  const q = ctx.args._[1];
  const ids = q ? [findModule(profile, q).id] : undefined;
  const condition = typeof ctx.args.flags.condition === "string" ? ctx.args.flags.condition : "ignition on";
  const simStatus = (await piGet(ctx.host, "/api/sim/status").catch(() => null)) as { running?: boolean; vehicle?: string; name?: string } | null;
  const sim = simStatus?.running && (ctx.iface === "vcan0" || /127\.0\.0\.1:8765$/.test(ctx.host)) ? (simStatus.name || simStatus.vehicle || "simulator") : null;
  say(`Completeness sweep on ${ctx.iface} for ${ymm(profile)} · condition "${condition}"${sim ? ` · SIMULATOR (${sim})` : ""}`);
  let last = "";
  const { profile: saved, sweeps, skipped } = await sweepAndSave(ctx.vehicleLibDir, {
    host: ctx.host, iface: ctx.iface, profile, moduleIds: ids, condition, wide: !!ctx.args.flags.wide, sim,
    onEvent: (e) => {
      if (e.type !== "sweep-module") return;
      if (e.phase === "start") say(`\n  [${e.index + 1}/${e.total}] ${oneLine(e.label, 70)} — ${e.of} identifiers`);
      else if (e.phase === "progress") {
        const pct = Math.floor((e.asked / e.of) * 10);
        const line = `      ${e.asked}/${e.of} asked · ${e.answered} answered`;
        if (String(pct) !== last) { last = String(pct); say(line); }
      } else if (e.sweep) {
        const c = e.sweep.counts;
        say(`      → ${c.answered} answered · ${c.moving} moving · ${c.gated} security-gated · session ${e.sweep.ranges[0]?.split("@")[1] ?? "?"} · ${Math.round(c.ms / 1000)} s`);
      }
    },
  });
  if (skipped.length) say(`\nNot swept (airbag / immobiliser — identity and fault memory only): ${skipped.map((l) => oneLine(l, 40)).join("; ")}`);
  say(`\nSaved to ${saved.id}. Coverage of the AI map against it: "coverage".`);
  return { ok: true, profile: saved.id, sweeps: Object.fromEntries(Object.entries(sweeps).map(([k, v]) => [k, v.counts])) };
}

/** What the AI map knows of what each module answers. */
async function cmdCoverage(ctx: Ctx) {
  const profile = await currentProfile(ctx);
  const q = ctx.args._[1];
  const mods = (q ? [findModule(profile, q)] : profile.modules.filter((m) => m.addressing?.response))
    .filter((m) => !protectedModule({ category: m.category, label: m.label }));
  say(`Coverage of the AI map — ${ymm(profile)}`);
  say(`  ${pad("module", 8)} ${pad("swept", 7)} ${pad("answer", 7)} ${pad("AI knows", 9)} ${pad("cover", 6)} ${pad("moving", 7)} ${pad("live in map", 12)} name`);
  const rows = [];
  for (const m of mods) {
    const c = coverageOf(m);
    const swept = m.sweeps?.length ?? 0;
    rows.push({ id: m.id, response: m.addressing?.response, ...c });
    say(`  ${pad(m.addressing?.response ?? "?", 8)} ${pad(String(swept), 7)} ${pad(swept ? String(c.answered) : "—", 7)} ${pad(swept ? String(c.known) : "—", 9)} ${pad(c.ratio === null ? "—" : `${Math.round(c.ratio * 100)}%`, 6)} ${pad(swept ? String(c.moving) : "—", 7)} ${pad(swept ? `${c.movingKnown}/${c.moving}` : "—", 12)} ${oneLine(m.label, 46)}`);
  }
  if (q && rows[0]) {
    const c = rows[0];
    if (c.missedLive.length) say(`\n  Moving, not in the map as live data: ${c.missedLive.join(", ")}`);
    if (c.missed.length) say(`  Answering, never mentioned by the map: ${c.missed.join(", ")}`);
    if (c.unseen.length) say(`  In the map, not seen answering in any sweep: ${c.unseen.join(", ")}`);
  }
  return { ok: true, profile: profile.id, modules: rows };
}

/** 5b + 5c: AI names for a module's swept identifiers, checked by code. Offline: no device, no car. */
async function cmdLabel(ctx: Ctx) {
  const profile = await currentProfile(ctx);
  const q = ctx.args._[1];
  if (!q) throw new Error("label <module>: which module?");
  const m = findModule(profile, q);
  const prompts = labelPrompts(profile, m);
  if (ctx.args.flags.dry) {
    say(`${m.label}: ${prompts.length} question(s), ${prompts.reduce((n, p) => n + p.length, 0)} characters. Nothing was sent.`);
    if (ctx.args.flags.show) say(prompts[0]);
    return { ok: true, module: m.id, prompts: prompts.length };
  }
  const recheck = !!ctx.args.flags.recheck;
  const missing = !!ctx.args.flags.missing;
  if (!recheck) needKey("Labelling");
  const t0 = Date.now();
  say(recheck ? `Checking the stored labels of ${m.label} again — no AI…` : missing ? `Asking only about the identifiers of ${m.label} without a label…` : `Labelling ${m.label} from its sweeps on file: offline, ${prompts.length} question(s) to the model…`);
  const { labels, profile: saved } = recheck ? await recheckAndSave(ctx.vehicleLibDir, { profileId: profile.id, moduleId: m.id }) : await labelAndSave(ctx.vehicleLibDir, { profileId: profile.id, moduleId: m.id, keepStored: missing, onProgress: (d, n) => say(`  ${d}/${n} answered`) });
  const s = labelSummary(labels, labelSweeps(m));
  const price = PRICES[labels.model] ?? { in: 5, out: 25 };
  say(`${m.label}: ${s.named} of ${s.answered} identifiers named (${s.specific} of them with a value or an identity), ${s.unknown} "unknown", ${s.missing} without an answer, ${labels.invented.length} invented (dropped).`);
  say(`  check: ${s.confirmed} confirmed · ${s.consistent} consistent · ${s.unchecked} unchecked · ${s.contradicted} contradicted`);
  const tr = labels.tracks ?? [];
  say(`  code alone: ${tr.filter((x) => x.quantity === "supply voltage").length} field(s) follow the supply voltage (luck would give ${labels.luck?.volts ?? 0}), ${tr.filter((x) => x.quantity === "engine speed").length} follow the engine speed (luck ${labels.luck?.rpm ?? 0})`);
  for (const x of tr.slice(0, 12)) say(`    ${x.id} byte ${x.offset} ×${Math.round(x.factor * 10000) / 10000}: ${x.quantity} ${x.at.map((a) => `${a.condition} ${a.values.map((v) => Math.round(v * 100) / 100).join("/")}`).join(" · ")}`);
  for (const st of ["confirmed", "contradicted"] as const) {
    for (const l of labels.labels.filter((x) => x.kind !== "unknown" && x.check.status === st)) {
      say(`  ${st === "confirmed" ? "+" : "!"} ${l.id}  ${oneLine(l.name, 60)} [${l.confidence}]: ${oneLine(l.check.notes.join("; "), 150)}`);
    }
  }
  say(`  ${labels.model}, ${Math.round((Date.now() - t0) / 1000)} s, tokens in ${labels.tokensIn} / out ${labels.tokensOut} (about $${((labels.tokensIn * price.in + labels.tokensOut * price.out) / 1e6).toFixed(2)}). Saved to ${saved.id}.`);
  return { ok: true, module: m.id, summary: s, invented: labels.invented };
}

/** Outside knowledge: download (sync), list, and what is known about the bound vehicle. Offline except sync. */
async function cmdSources(ctx: Ctx) {
  const dir = path.join(ctx.ws, "knowledge");
  if (ctx.args._[1] === "sync") {
    say("Downloading OBDb (community signal sets) and OBDex (fault-code meanings)…");
    let last = 0;
    const r = await syncSources(dir, { onProgress: (d, n) => { if (d - last >= 100 || d === n) { last = d; say(`  ${d}/${n} OBDb sets`); } } });
    say(`  ${r.withSignals} of ${r.repos} OBDb sets have signals · ${r.dtcs} fault codes · ${r.failed.length} failed · ${Math.round(r.ms / 1000)} s`);
    for (const f of r.failed.slice(0, 8)) say(`  ! ${f}`);
    const kb = await buildKnowledge(dir);
    say(`Built: ${kb.signals.length} signal definitions for ${kb.vehicles.length} vehicle sets + the standard, ${kb.dtcs.length} fault codes → ${path.join(dir, "kb.json")}`);
    return { ok: true, ...r, signals: kb.signals.length, vehicles: kb.vehicles.length };
  }
  if (ctx.args._[1] === "build") { const kb = await buildKnowledge(dir); say(`Rebuilt from the downloaded sources: ${kb.signals.length} signal definitions, ${kb.dtcs.length} fault codes.`); return { ok: true }; }
  const k = await loadKnowledge(dir);
  if (!k) { say(`No knowledge base yet — run "sources sync".`); return { ok: false }; }
  const makes = new Map<string, number>();
  for (const v of k.kb.vehicles) makes.set(v.make, (makes.get(v.make) ?? 0) + 1);
  say(`Knowledge base built ${k.kb.builtAt}: ${k.kb.signals.length} signal definitions, ${k.kb.vehicles.length} vehicle sets, ${makes.size} makes, ${k.kb.dtcs.length} fault codes.`);
  for (const s of k.kb.sources) say(`  ${s.name} — ${s.licence} — retrieved ${s.retrievedAt.slice(0, 10)}\n    ${s.terms}`);
  return { ok: true, signals: k.kb.signals.length, vehicles: k.kb.vehicles.length, dtcs: k.kb.dtcs.length };
}

async function cmdKnowledge(ctx: Ctx) {
  const profile = await currentProfile(ctx);
  const k = await loadKnowledge(path.join(ctx.ws, "knowledge"));
  const c = knowledgeCard(profile, k?.kb ?? null, k?.dtcIndex);
  say(`What is known about this ${c.vehicle}`);
  say(`  modules       ${c.modules.found} found · ${c.modules.identified} identified · ${c.modules.serials} serial numbers · fault memory read on ${c.modules.faultsRead} · ${c.modules.protected} protected`);
  say(`  standard      ${c.standard.definitions} standard values defined (SAE J1979)${c.standard.modules.length ? ` · supported here: ${c.standard.modules.map((m) => `${m.module} ${m.supported}`).join(", ")}` : " · supported list not read yet (next sweep asks)"}`);
  say(`  fault codes   ${c.faults.length ? c.faults.map((f) => `${f.code} (${f.module}) ${f.title ?? (f.makerSpecific ? "— maker-specific, no public meaning" : "— no public meaning found")}`).join("\n                ") : "none on file"}`);
  const vd = c.community.verdicts;
  say(`  community     sets for this model: ${c.community.modelSets.join(", ") || "none"} · make set: ${c.community.makeSet ?? "none"}`);
  say(`                ${c.community.candidates} candidate definitions (this model, the make, other models) · ${c.community.tested} on modules this car has`);
  say(`                on this car: ${vd.proven} proven · ${vd.fits} fit · ${vd["out-of-range"]} wrong · ${vd["too-short"]} longer than the answer · ${vd["no-answer"]} not answered · ${vd["not-swept"]} module not swept`);
  for (const s of c.community.signals.slice(0, Number(ctx.args.flags.all ? 999 : 20))) say(`     ${s.verdict === "proven" ? "+" : s.verdict === "fits" ? "·" : "!"} ${s.module.padEnd(6)} ${s.request.padEnd(8)} ${oneLine(s.name, 44).padEnd(44)} ${s.values} ${s.unit}  [${s.sets.slice(0, 3).join(", ")}${s.sets.length > 3 ? "…" : ""}]`);
  say(`  own mapping   ${c.own.swept} modules swept · ${c.own.answered} identifiers answer · ${c.own.changing} change · ${c.own.labelled} labelled: ${c.own.named} named, ${c.own.proven} proven`);
  for (const s of c.sources) say(`  source        ${s.name} (${s.licence}), retrieved ${new Date(s.retrievedAt).toLocaleDateString()}`);
  return { ok: true, card: c };
}

async function cmdDtc(ctx: Ctx) {
  const k = await loadKnowledge(path.join(ctx.ws, "knowledge"));
  if (!k) throw new Error(`No knowledge base yet — run "sources sync".`);
  const codes = ctx.args._.slice(1);
  const out = codes.map((c) => dtcMeaning(k.kb, c, k.dtcIndex));
  for (const m of out) say(`${m.code}: ${m.title ?? (m.makerSpecific ? "maker-specific — no public meaning" : "no meaning in the open data")}${m.description ? `\n  ${oneLine(m.description, 400)}` : ""}`);
  return { ok: true, codes: out };
}

/** The read-only mechanic assistant, one question at a time (or --catalog to list what it may read). */
async function cmdAsk(ctx: Ctx) {
  const profile = await currentProfile(ctx);
  const k = await loadKnowledge(path.join(ctx.ws, "knowledge"));
  const catalog = vehicleCatalog(profile, k?.kb ?? null);
  if (ctx.args.flags.catalog) {
    for (const it of catalog) say(`  ${it.trust.padEnd(8)} ${it.module.short.slice(0, 22).padEnd(22)} ${it.request.padEnd(8)} ${it.session ? `@${it.session}` : "   "} ${oneLine(it.name, 50)} ${it.unit}`);
    say(`${catalog.length} readable values for ${ymm(profile)}.`);
    return { ok: true, catalog: catalog.length };
  }
  const question = ctx.args._.slice(1).join(" ").trim();
  if (!question) throw new Error('ask "<question>" — or ask --catalog');
  needKey("The assistant");
  const online = ctx.host !== "offline";
  const unit = profile.knownVins?.[0];
  const last = unit?.scans?.length ? unit.scans[unit.scans.length - 1] : null;
  const faults = (last?.systems ?? []).flatMap((s) => s.dtcs.map((d) => { const m = k ? dtcMeaning(k.kb, d.code, k.dtcIndex) : null; return `${s.label.split(" (")[0]}: ${d.code} — ${m?.title ?? (m?.makerSpecific ? "maker-specific, no public meaning" : d.description ?? "no meaning found")}`; }));
  const sim = isSimulatorTarget(ctx.host, ctx.iface);
  const r = await askMechanic({
    history: [], question,
    context: { profile, catalog, faults, device: !online ? "no device connected — nothing can be read live" : sim ? "the desk simulator, replaying a recording of this van — values are replayed, not live" : `the device at ${ctx.host} on ${ctx.iface}, read-only` },
    tools: {
      find: (q) => searchCatalog(catalog, q),
      read: async (ids) => { if (!online) throw new Error("no device connected"); return readCatalogItems({ host: ctx.host, iface: ctx.iface, profile, items: ids.map((id) => catalog.find((x) => x.id === id)).filter((x): x is NonNullable<typeof x> => !!x) }); },
      explain: (code) => (k ? dtcMeaning(k.kb, code, k.dtcIndex) : { code, makerSpecific: true }),
    },
    onEvent: (e) => {
      if (e.type === "text") process.stdout.write(e.delta);
      else if (e.type === "found") say(`\n  [looked for "${e.query}": ${e.items.length}]`);
      else if (e.type === "values") for (const v of e.values) say(`  [${v.name} (${v.module}) = ${v.value === null ? `— ${v.error ?? ""}` : `${v.value} ${v.unit}`} · ${v.trust}]`);
      else if (e.type === "done") { const p = PRICES[e.model] ?? { in: 5, out: 25 }; say(`\n\n(${e.model}, ${e.tokensIn} in / ${e.tokensOut} out, about $${((e.tokensIn * p.in + e.tokensOut * p.out) / 1e6).toFixed(3)})`); }
    },
  });
  return { ok: true, answer: r.answer };
}

/** Calibration bench on a virtual car (desk simulator). */
async function cmdBench(ctx: Ctx) {
  needKey("The bench");
  const vehicle = typeof ctx.args.flags.vehicle === "string" ? ctx.args.flags.vehicle : "corolla";
  const port = typeof ctx.args.flags.port === "string" ? Number(ctx.args.flags.port) : 8771;
  const models = (typeof ctx.args.flags.models === "string" ? ctx.args.flags.models : "claude-opus-4-8").split(",").map((x) => x.trim()).filter(Boolean);
  const runs = Math.max(1, Math.min(5, typeof ctx.args.flags.runs === "string" ? Number(ctx.args.flags.runs) : 1));
  const only = typeof ctx.args.flags.modules === "string" ? ctx.args.flags.modules.split(",").map((x) => x.trim()) : undefined;
  const webui = path.join(ctx.root, "hardware", "super-device", "webui");
  const py = process.platform === "win32" ? "python" : "python3";

  const key = spawnSync(py, [path.join(webui, "virtual_vehicle.py"), "--describe-json", vehicle], { encoding: "utf8" });
  if (key.status !== 0) throw new Error(`Could not read the answer key for "${vehicle}": ${key.stderr || key.stdout}`);
  const truth = JSON.parse(key.stdout) as TruthVehicle;
  const modules = benchModules(truth, only);
  if (!modules.length) throw new UsageError(`No bench modules match ${only?.join(",")} (airbag / immobiliser are never mapped). Templates: ${truth.modules.map((m) => m.template).join(", ")}`);

  // the virtual car: a desk simulator on its own port (started here if not running)
  const host = `127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  const up = async () => { try { await piGet(host, "/api/status", 2000); return true; } catch { return false; } };
  if (!(await up())) {
    child = spawn(py, [path.join(webui, "desk_sim.py"), "--vehicle", vehicle, "--port", String(port)], { stdio: "ignore" });
    for (let i = 0; i < 30 && !(await up()); i++) await new Promise((r) => setTimeout(r, 300));
    if (!(await up())) { child.kill(); throw new Error(`The desk simulator did not start on ${host}.`); }
  }
  const sim = (await piGet(host, "/api/sim/status").catch(() => null)) as { name?: string; replay?: string[] | null } | null;
  if (sim?.replay?.length) throw new Error(`${host} is playing a recording, not the virtual ${vehicle} — use another --port.`);

  const est = modules.length * runs * models.length;
  say(`Calibration bench · ${truth.name} (virtual, ${host}) · ${modules.length} module(s) × ${runs} run(s) × ${models.length} model(s) = ${est} deep map(s)`);
  say(`Modules: ${modules.map((m) => m.template).join(", ")} · models: ${models.join(", ")} · airbag / immobiliser left out`);
  let scores: Awaited<ReturnType<typeof runBench>> = [];
  try {
    scores = await runBench({
      host, iface: "can0", truth, modules, models, runs,
      onProgress: (t) => say(`\n  ▶ ${t}`),
      onScore: (x) => say(`    ${x.outcome}${x.error ? ` (${oneLine(x.error, 60)})` : ""} · data ${x.data.found}/${x.data.total} (labels right ${x.data.labelOk}) · ident ${x.identification.found}/${x.identification.total} · sessions ${x.sessions.found}/${x.sessions.total} · codes ${x.dtcs.found}/${x.dtcs.total} · invented ${x.invented.length} · refused ${x.refused} · ${x.steps} steps · $${x.costUsd.toFixed(2)} · ${x.seconds} s`),
    });
  } finally { if (child) child.kill(); }

  const sum = summarise(scores);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  say(`\n  ${pad("model", 20)} ${pad("data found", 11)} ${pad("labels", 7)} ${pad("ident", 6)} ${pad("sessions", 9)} ${pad("codes", 6)} ${pad("invented", 9)} ${pad("refused", 8)} ${pad("steps", 6)} cost`);
  for (const m of sum) say(`  ${pad(m.model, 20)} ${pad(pct(m.dataRecall), 11)} ${pad(pct(m.labelAccuracy), 7)} ${pad(pct(m.identRecall), 6)} ${pad(pct(m.sessionRecall), 9)} ${pad(pct(m.dtcRecall), 6)} ${pad(String(m.invented), 9)} ${pad(String(m.refused), 8)} ${pad(m.avgSteps.toFixed(1), 6)} $${m.costUsd.toFixed(2)}${m.failed ? ` · ${m.failed} failed` : ""}`);
  const dir = path.join(ctx.ws, "calibration");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `bench-${vehicle}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify({ vehicle, truth: truth.name, models, runs, modules: modules.map((m) => m.template), at: new Date().toISOString(), summary: sum, scores }, null, 2), "utf8");
  say(`\nScorecard: ${file}`);
  return { ok: scores.every((x) => x.outcome !== "failed"), file, summary: sum };
}

async function cmdCensus(ctx: Ctx) {
  const profile = await currentProfile(ctx);
  const discovered = discoveredFromProfile(profile);
  if (!discovered.length) throw new Error(`${ymm(profile)} has no discovery on file — run "discover" first.`);
  const r = await runCensus(ctx, profile, discovered);
  return { ok: true, ...r };
}

async function cmdModules(ctx: Ctx) {
  const profile = await currentProfile(ctx);
  say(`${profile.id} — ${ymm(profile)} · ${profile.knownVins?.length ?? 0} VIN(s) on file${profile.fingerprint ? ` · last discovery ${profile.fingerprint.takenAt}` : " · never discovered"}`);
  const mods = profile.modules.slice().sort((a, b) => norm(a.addressing?.response).localeCompare(norm(b.addressing?.response)));
  for (const m of mods) {
    const x = m.explored;
    const ops = x?.operations ?? [];
    say(`  ${pad(m.id, 14)} ${pad(m.addressing?.response ? `${m.addressing.request ?? "?"}→${m.addressing.response}` : "no address", 20)} ${pad(m.identity?.partNo || "—", 20)} ${pad(x ? `mapped ×${x.runCount} (${ops.filter((o) => o.status === "supported").length} ok/${ops.filter((o) => o.status === "gated").length} gated)` : m.censusAt ? "census only" : "—", 26)} ${m.label}`);
  }
  return { ok: true, profile };
}

async function runMap(ctx: Ctx, profile: VehicleProfile, mod: VehicleModule) {
  needKey("The deep-map");
  const target = targetFor(profile, mod);
  if (!target.requestId || !target.responseId) throw new Error(`${mod.label} has no diagnostic address on file — run "discover" first.`);
  const events: { at: string; event: VehicleExplorerEvent }[] = [];
  let stop = false;
  const onSigint = () => {
    if (stop) process.exit(130);
    stop = true;
    say("\n  (stopping after the current step — the findings so far are saved; Ctrl+C again to quit now)");
  };
  process.on("SIGINT", onSigint);
  const startedAt = new Date().toISOString();
  let updated: VehicleProfile;
  try {
    updated = await deepMapAndSave({
      host: ctx.host, iface: ctx.iface, profile, targets: [target], vehicleLibDir: ctx.vehicleLibDir,
      shouldStop: () => stop,
      onEvent: (e) => {
        events.push({ at: new Date().toISOString(), event: e });
        if (e.type === "module-start") say(`> mapping ${e.displayName} (${target.requestId}→${target.responseId}) — read-only`);
        else if (e.type === "module-event") {
          const ev = e.event;
          if (ev.type === "thought") say(`  . ${oneLine(ev.text, 200)}`);
          else if (ev.type === "action" && ev.tool !== "record" && ev.tool !== "conclude") {
            const inp = ev.input as { purpose?: string; requests?: string[]; start?: string; end?: string; ms?: number };
            say(`  > ${ev.tool}${inp.purpose ? `: ${oneLine(inp.purpose, 120)}` : ""}${inp.requests ? `  [${inp.requests.join(" ")}]` : ""}${inp.start ? `  [${inp.start}-${inp.end}]` : ""}`);
          } else if (ev.type === "observation") { for (const l of (ev.detail ?? ev.summary).split("\n").slice(0, 14)) say(`      ${oneLine(l, 160)}`); }
          else if (ev.type === "finding") say(`  + ${ev.kind}: ${ev.title} — ${oneLine(ev.detail, 140)}`);
          else if (ev.type === "status") say(`  [${ev.text}]`);
          else if (ev.type === "error") say(`  ! ${ev.text}`);
        } else if (e.type === "error") say(`  ! ${e.text}`);
        else if (e.type === "status") say(`  [${e.text}]`);
      },
    });
  } finally { process.off("SIGINT", onSigint); }

  const done = events.map((x) => x.event).find((e): e is Extract<VehicleExplorerEvent, { type: "module-done" }> => e.type === "module-done");
  const failure = events.map((x) => x.event).find((e): e is Extract<VehicleExplorerEvent, { type: "error" }> => e.type === "error");
  await mkdir(ctx.reportsDir, { recursive: true });
  const file = path.join(ctx.reportsDir, `deepmap-${profile.id}-${mod.id}-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify({ kind: "chiplab-deepmap-run", host: ctx.host, iface: ctx.iface, profile: profile.id, module: mod.id, target, startedAt, finishedAt: new Date().toISOString(), result: done?.result ?? null, error: failure?.text ?? null, events }, null, 2), "utf8");
  if (!done) {
    say(`Deep-map of ${mod.label} did not finish: ${failure?.text ?? "no result"} (transcript: ${file})`);
    return { ok: false, error: failure?.text ?? "no result", transcript: file, profile: updated };
  }
  const r = done.result;
  say(`= ${mod.label}: ${r.outcome}, confidence ${r.confidence}, ${r.steps} step(s), tokens in ${r.tokensIn} / out ${r.tokensOut}`);
  say(`  identity: ${oneLine(r.identity, 160)}`);
  for (const o of r.operations ?? []) say(`  ${pad(o.op, 20)} ${pad(o.status, 12)} ${o.request ? `${o.request}${o.session ? ` in ${o.session}` : ""}` : ""}${o.nrc ? ` nrc ${o.nrc}` : ""}`);
  say(`  ${r.identification?.length ?? 0} identification record(s), ${r.liveData?.length ?? 0} live-data item(s), ${explorationFaults(r.dtcs).length} fault code(s), ${r.broadcastFrames?.length ?? 0} broadcast frame(s)${r.newFindings.length ? `, ${r.newFindings.length} new vs the last run` : ""}`);
  say(`Saved to ${updated.id}; transcript: ${file}`);
  return { ok: true, result: r, transcript: file, profile: updated };
}

async function cmdMap(ctx: Ctx) {
  const q = ctx.args._[1];
  if (!q) throw new UsageError(`map needs a module: its id, an address (7E8) or part of its name. See "modules".`);
  const profile = await currentProfile(ctx);
  const mod = findModule(profile, q);
  const guard = protectedModule({ category: mod.category, label: mod.label, summary: (mod as { summary?: string }).summary });
  if (guard) throw new UsageError(`${mod.label}: not mapped — ${guard.reason}.`);
  return runMap(ctx, profile, mod);
}

async function runCapture(ctx: Ctx, extra: unknown) {
  let profile: VehicleProfile | undefined;
  try { profile = await currentProfile(ctx); } catch { profile = undefined; }
  const st = await readState(ctx);
  const note = typeof ctx.args.flags.note === "string" ? ctx.args.flags.note : "";
  say(`Capturing diagnostics on ${ctx.iface} (device, buses, VIN attempts, discovery, OBD baseline)…`);
  const r = await captureDiagnostics({
    host: ctx.host, iface: ctx.iface, vin: typeof ctx.args.flags.vin === "string" ? ctx.args.flags.vin : st.vin,
    profile, note, extra, reportsDir: ctx.reportsDir, appVersion: ctx.appVersion,
  });
  say(`Capture: ${r.path} (${r.bytes} bytes) — ${r.summary}`);
  return r;
}

// ---- recorder -------------------------------------------------------------------------

interface RecSession { id: string; bytes: number; lines: number; exchanges: number; active: boolean; sha256?: string; label?: string; auto?: boolean; started?: string; sim?: string | null; error?: string }

async function recList(ctx: Ctx): Promise<RecSession[]> {
  return ((await piGet(ctx.host, "/api/rec/list", 30000)) as { sessions: RecSession[] }).sessions;
}

async function deviceName(ctx: Ctx): Promise<string> {
  try { return (((await piGet(ctx.host, "/api/device")) as { hostname?: string }).hostname || "device").replace(/[^A-Za-z0-9._-]/g, "_"); }
  catch { return "device"; }
}

/** Copy one recording here, byte for byte, and check it against the device's hash. */
async function recFetchOne(ctx: Ctx, s: RecSession, dir: string): Promise<{ id: string; file: string; bytes: number; verified: boolean }> {
  const res = await fetch(`http://${ctx.host}/api/rec/get?id=${encodeURIComponent(s.id)}`, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`recording ${s.id}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${s.id}.jsonl`);
  await writeFile(file, buf);
  // a session still being written may have grown since the listing; then only the size can be compared
  const verified = !!s.sha256 && createHash("sha256").update(buf).digest("hex") === s.sha256;
  return { id: s.id, file, bytes: buf.length, verified };
}

async function recFetch(ctx: Ctx, only?: string) {
  const dir = path.join(ctx.recordingsDir, await deviceName(ctx));
  const sessions = await recList(ctx);
  const want = only ? sessions.filter((s) => s.id === only) : sessions;
  if (only && !want.length) throw new Error(`No recording "${only}" on the device. It has: ${sessions.map((s) => s.id).join(", ") || "none"}`);
  const out: { id: string; file: string; bytes: number; verified: boolean; skipped?: boolean }[] = [];
  for (const s of want) {
    const local = path.join(dir, `${s.id}.jsonl`);
    let have = -1;
    try { have = fs.statSync(local).size; } catch { /* not here yet */ }
    if (!only && have === s.bytes) { out.push({ id: s.id, file: local, bytes: have, verified: true, skipped: true }); continue; }
    const r = await recFetchOne(ctx, s, dir);
    out.push(r);
    say(`  fetched ${pad(s.id, 44)} ${pad(String(r.bytes) + " B", 10)} ${s.exchanges} exchange(s)${s.sim ? ` [virtual vehicle: ${s.sim}]` : ""}${r.verified ? " · hash ok" : s.active ? " · still open on the device" : " · HASH MISMATCH"}`);
  }
  const fetched = out.filter((o) => !o.skipped).length;
  say(`${fetched} recording(s) copied to ${dir}${out.length - fetched ? `, ${out.length - fetched} already here` : ""}.`);
  return { dir, recordings: out };
}

async function cmdRec(ctx: Ctx) {
  const sub = ctx.args._[1] ?? "status";
  if (sub === "status") {
    const r = (await piGet(ctx.host, "/api/rec/status")) as RecStatus;
    say(r.error ? `NOT RECORDING — ${r.error}` : `Recording to ${r.dir} · ${r.session ? `session ${r.session.id}${r.session.label ? ` "${r.session.label}"` : ""} (${r.session.bytes} bytes)` : "no named session: exchanges go to the daily file"} · ${r.free_mb} MB free`);
    return r;
  }
  if (sub === "start") {
    const label = ctx.args._.slice(2).join(" ") || (typeof ctx.args.flags.label === "string" ? ctx.args.flags.label : "");
    const r = (await piPost(ctx.host, "/api/rec/start", { label, note: typeof ctx.args.flags.note === "string" ? ctx.args.flags.note : "" })) as { ok: boolean; session?: { id: string }; error?: string };
    say(r.ok ? `Recording session ${r.session?.id} started.` : `Could not start: ${r.error}`);
    return r;
  }
  if (sub === "stop") {
    const r = (await piPost(ctx.host, "/api/rec/stop", {})) as { ok: boolean; ended: string | null };
    say(r.ended ? `Session ${r.ended} closed (exchanges now go to the daily file). Fetch it: rec fetch ${r.ended}` : "No named session was open.");
    return r;
  }
  if (sub === "list") {
    const sessions = await recList(ctx);
    for (const s of sessions) say(`  ${pad(s.id, 44)} ${pad(String(s.bytes) + " B", 10)} ${pad(`${s.exchanges} x`, 8)} ${s.active ? "OPEN " : "     "}${s.sim ? `[sim ${s.sim}] ` : ""}${s.label ?? ""}${s.error ? ` ! ${s.error}` : ""}`);
    say(`${sessions.length} recording(s) on the device.`);
    return { sessions };
  }
  if (sub === "fetch") return recFetch(ctx, ctx.args._[2]);
  throw new UsageError(`rec ${sub}? Use: rec status | start <label> | stop | list | fetch [<id>]`);
}

// ---- virtual vehicle ----------------------------------------------------------------

async function cmdSim(ctx: Ctx) {
  const sub = ctx.args._[1] ?? "status";
  const on = typeof ctx.args.flags.on === "string" ? ctx.args.flags.on : (ctx.iface === "vcan0" ? "vcan0" : "can1");
  if (sub === "status") {
    const r = (await piGet(ctx.host, "/api/sim/status")) as { running: boolean; vehicle?: string; iface?: string };
    say(r.running ? `Virtual vehicle: ${r.vehicle} on ${r.iface}` : "Virtual vehicle: not running");
    return r;
  }
  if (sub === "stop") { const r = await piPost(ctx.host, "/api/sim/stop", {}); say("Virtual vehicle stopped."); return r; }
  if (sub === "start" || sub === "replay") {
    const what = ctx.args._[2];
    if (sub === "replay" && !what) throw new UsageError("sim replay needs a recording id (see: rec list)");
    const body = sub === "replay" ? { iface: on, replay: what } : { iface: on, vehicle: what ?? "corolla" };
    const r = (await piPost(ctx.host, "/api/sim/start", body, 20000)) as { ok: boolean; vehicle?: string; iface?: string; error?: string };
    say(r.ok ? `Virtual vehicle ${r.vehicle} running on ${r.iface}.${on === "can1" ? " (needs the can1↔can0 jumper; run the pipeline with --iface can0)" : ` Run the pipeline with --iface ${on}.`}` : `Could not start: ${r.error}`);
    return r;
  }
  throw new UsageError(`sim ${sub}? Use: sim start [corolla|f150] | replay <recording id> | stop | status`);
}

// ---- the whole pipeline ---------------------------------------------------------------

async function cmdRun(ctx: Ctx) {
  const steps: Record<string, unknown> = {};
  const problems: string[] = [];
  const version = await daemonVersion(ctx);
  const canRecord = !!version?.features?.includes("recorder");
  let recId: string | null = null;
  if (canRecord) {
    const label = typeof ctx.args.flags.label === "string" ? ctx.args.flags.label : "cli run";
    const r = (await piPost(ctx.host, "/api/rec/start", { label, note: `vehicle run on ${ctx.iface}` })) as { ok: boolean; session?: { id: string }; error?: string };
    recId = r.ok ? r.session?.id ?? null : null;
    say(recId ? `Recording this run on the device as ${recId}.` : `Recorder would not start a session (${r.error}) — the exchanges still go to its daily file.`);
  } else say("This daemon has no recorder (older build) — the run is not recorded on the device.");

  let profile: VehicleProfile | null = null;
  let discovered: DiscoveredModule[] = [];
  try {
    say("\n[1/6] VIN");
    const v = await cmdVin(ctx);
    steps.vin = { ok: v.ok, vin: v.vin ?? null, kind: v.kind ?? null, profile: v.profile?.id ?? null };
    profile = v.profile ?? null;
    if (!v.ok) problems.push("no VIN from the car");
    else if (!profile) problems.push("VIN read but not bound to a library vehicle");

    say("\n[2/6] Discover");
    discovered = await runDiscover(ctx, profile);
    printDiscovered(discovered);
    if (profile) {
      profile = await commitDiscovery(ctx.vehicleLibDir, profile, discovered);
      say(`${discovered.length} module(s) answered — saved to ${profile.id}.`);
    } else say(`${discovered.length} module(s) answered — not saved (no library vehicle bound); they are in the capture below.`);
    steps.discover = { found: discovered.length, responders: discovered.map((d) => d.responseId) };
    if (!discovered.length) problems.push("no module answered on the bus");

    say("\n[3/6] Census");
    if (ctx.args.flags["no-census"]) say("skipped (--no-census)");
    else if (!profile || !discovered.length) say("skipped (needs a bound vehicle and at least one module)");
    else if (!getApiKey()) { say("skipped — no ANTHROPIC_API_KEY (environment or <repo>/.env)"); problems.push("census skipped: no API key"); }
    else {
      try {
        const c = await runCensus(ctx, profile, discovered);
        profile = c.profile;
        steps.census = { named: c.census.modules.length, tokensIn: c.census.tokensIn, tokensOut: c.census.tokensOut };
      } catch (e) { say(`Census failed — ${(e as Error).message} (the modules are saved; map still works)`); problems.push(`census failed: ${(e as Error).message}`); }
    }

    say("\n[4/6] Identify every module (part numbers, versions, serial numbers)");
    if (!profile || !discovered.length) say("skipped (needs a bound vehicle and at least one module)");
    else {
      try {
        const idr = await runIdentify(ctx, profile);
        profile = idr.profile;
        steps.identify = {
          modules: idr.inventory.modules.length, identified: idr.inventory.modules.filter((m) => m.status === "ok").length,
          serials: idr.inventory.modules.filter((m) => m.summary.serial).length, changes: idr.changes.length,
        };
      } catch (e) { say(`Identity read failed — ${(e as Error).message}`); problems.push(`identify failed: ${(e as Error).message}`); }
    }

    say("\n[5/6] Deep-map one module");
    const q = typeof ctx.args.flags.map === "string" ? ctx.args.flags.map : "";
    if (!q) say("skipped (pass --map <module> to deep-map one)");
    else if (!profile) say("skipped (no library vehicle bound)");
    else {
      try {
        const m = await runMap(ctx, profile, findModule(profile, q));
        profile = m.profile;
        steps.map = { ok: m.ok, module: q, transcript: m.transcript, outcome: m.ok ? m.result?.outcome : m.error };
        if (!m.ok) problems.push(`deep-map of ${q} did not finish`);
      } catch (e) { say(`Deep-map failed — ${(e as Error).message}`); problems.push(`deep-map failed: ${(e as Error).message}`); }
    }

    say("\n[6/6] Capture");
    const cap = await runCapture(ctx, { cli: true, recording: recId, steps, problems });
    steps.capture = cap;
  } finally {
    if (recId) {
      try {
        await piPost(ctx.host, "/api/rec/stop", {});
        say("\nRecording");
        steps.recording = await recFetch(ctx, recId);
      } catch (e) { say(`Could not close/fetch the recording ${recId}: ${(e as Error).message} — it stays on the device; fetch it later with: rec fetch ${recId}`); problems.push("recording not fetched"); }
    }
  }
  say(`\n${problems.length ? `RUN FINISHED WITH ${problems.length} PROBLEM(S):\n${problems.map((p) => `  - ${p}`).join("\n")}` : "RUN COMPLETE — every step ran."}`);
  return { ok: problems.length === 0, problems, steps, profile: profile?.id ?? null };
}

// ---- main ------------------------------------------------------------------------------

/** Simulator sessions work on the sandbox copy of the library — real cars' records stay untouched. */
async function useSandbox(ctx: Ctx): Promise<void> {
  await ensureSimLibrary(realLibraryDir(ctx.ws), simLibraryDir(ctx.ws));
  ctx.vehicleLibDir = simLibraryDir(ctx.ws);
  ctx.reportsDir = path.join(ctx.ws, "reports-sim");     // a simulator capture must not look like a real car's
}

async function main(): Promise<number> {
  let args: Args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`${(e as Error).message}\n`); return 2; }
  JSON_MODE = !!args.flags.json;
  const cmd = args._[0];
  if (args.flags.help || !cmd || cmd === "help") { process.stdout.write(HELP + "\n"); return cmd || args.flags.help ? 0 : 2; }

  const root = findProjectRoot();
  loadEnvFile(root);
  if (["audit", "coverage", "bench", "label", "sources", "knowledge", "dtc", "ask"].includes(cmd)) args.flags.host = typeof args.flags.host === "string" ? args.flags.host : "offline";
  const hostRaw = (typeof args.flags.host === "string" ? args.flags.host : process.env.SD_HOST ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!hostRaw) { process.stderr.write("Which device? Pass --host <address[:port]> (or set SD_HOST). Example: --host 100.91.185.100\n"); return 2; }
  const host = /:\d+$/.test(hostRaw) ? hostRaw : `${hostRaw}:8080`;
  const ws = resolveWorkspaceRoot(root, typeof args.flags.workspace === "string" ? args.flags.workspace : undefined);
  let appVersion = "cli";
  try { appVersion = `${(JSON.parse(fs.readFileSync(path.join(root, "apps", "desktop", "package.json"), "utf8")) as { version: string }).version}-cli`; } catch { /* keep "cli" */ }
  const ctx: Ctx = {
    host, iface: typeof args.flags.iface === "string" ? args.flags.iface : "can0", json: JSON_MODE,
    root, ws, vehicleLibDir: path.join(ws, "vehicle-library"), reportsDir: path.join(ws, "reports"),
    recordingsDir: path.join(ws, "recordings"), stateFile: path.join(ws, "cli", "last.json"), appVersion, args,
  };

  // A simulator by address (desk simulator) or by bus (vcan0): sandbox library, whatever the command.
  if (isSimulatorTarget(hostRaw === "offline" ? undefined : hostRaw, ctx.iface)) await useSandbox(ctx);

  const commands: Record<string, (c: Ctx) => Promise<unknown>> = {
    status: cmdStatus, up: (c) => cmdUp(c, true), down: (c) => cmdUp(c, false), vin: cmdVin, discover: cmdDiscover,
    census: cmdCensus, identify: cmdIdentify, sweep: cmdSweep, coverage: cmdCoverage, label: cmdLabel, sources: cmdSources, knowledge: cmdKnowledge, dtc: cmdDtc, ask: cmdAsk, bench: cmdBench, audit: cmdAudit, modules: cmdModules, map: cmdMap, capture: (c) => runCapture(c, { cli: true }), run: cmdRun, rec: cmdRec, sim: cmdSim,
  };
  const fn = commands[cmd];
  if (!fn) { process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}\n`); return 2; }
  try {
    // At a real car this must never go unnoticed: with the can1↔can0 jumper still in,
    // a running virtual vehicle answers on can0 as if it were the car.
    if (["vin", "discover", "census", "identify", "sweep", "map", "capture", "run"].includes(cmd) && ctx.iface !== "vcan0") {
      const sim = (await piGet(ctx.host, "/api/sim/status").catch(() => null)) as { running?: boolean; vehicle?: string; iface?: string } | null;
      if (sim?.running) {
        await useSandbox(ctx);
        say(`NOTE: a virtual vehicle (${sim.vehicle}) is running on ${sim.iface}. If the can1↔can0 jumper is in, what answers on ${ctx.iface} is the SIMULATOR, not a car — this run works on the sandbox library. At a car: "sim stop" and pull the jumper.\n`);
      }
    }
    const result = await fn(ctx);
    if (JSON_MODE) process.stdout.write(JSON.stringify(result) + "\n");
    return result && typeof result === "object" && (result as { ok?: boolean }).ok === false ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) { process.stderr.write(`${e.message}\n`); return 2; }
    process.stderr.write(`ERROR: ${(e as Error).message}\n`);
    if (JSON_MODE) process.stdout.write(JSON.stringify({ ok: false, error: (e as Error).message }) + "\n");
    return 1;
  }
}

// Output piped into something that stops reading (| head, | Select-Object -First) must
// not turn into a crash: the work has been done, only the last lines had no reader.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => { if (e.code !== "EPIPE") throw e; });
}

main().then((code) => { process.exitCode = code; });
