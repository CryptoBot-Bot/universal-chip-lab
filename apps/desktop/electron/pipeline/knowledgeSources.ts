/**
 * Outside sources → one knowledge base on disk (<workspace>/knowledge). Downloaded on request,
 * never committed: the data stays under its own licence, credited, next to our code.
 *
 *   OBDb   community signal sets per make / model + the SAE J1979 standard set   CC BY-SA 4.0
 *   OBDex  generic fault-code meanings                                           CC0 1.0
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DtcDef, KnowledgeBase, KnowledgeSource, KnowledgeVehicle, SignalDef } from "@ecu/vehicle-db";

const UA = { "User-Agent": "universal-auto-lab-knowledge-sync", Accept: "application/json" };
const OBDB_RAW = "https://raw.githubusercontent.com/OBDb";
const OBDEX = "https://foerbsnavi.github.io/OBDex";
/** Not vehicle data: tooling, templates, web apps. */
const NOT_VEHICLES = /^\.|\.obdb\.community$|^vscode-obdb$|template/i;

export interface SyncReport { repos: number; withSignals: number; failed: string[]; dtcs: number; ms: number }

type Fetch = typeof fetch;

async function getJson(f: Fetch, url: string): Promise<unknown | null> {
  const r = await f(url, { headers: UA });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
async function getText(f: Fetch, url: string): Promise<string | null> {
  const r = await f(url, { headers: UA });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

/** Download every source into `dir` (sources/…). Safe to run again: it replaces what is there. */
export async function syncSources(dir: string, o: { fetch?: Fetch; onProgress?: (done: number, of: number) => void; only?: string[] } = {}): Promise<SyncReport> {
  const f = o.fetch ?? fetch;
  const t0 = Date.now();
  const at = new Date().toISOString();
  // OBDb: the list of repositories (GitHub API, 100 per page)
  const repos: { name: string; license: string | null; pushed_at: string }[] = [];
  for (let page = 1; page < 30; page++) {
    const list = (await getJson(f, `https://api.github.com/orgs/OBDb/repos?per_page=100&page=${page}&type=public`)) as { name: string; license: { spdx_id: string } | null; pushed_at: string }[] | null;
    if (!list?.length) break;
    repos.push(...list.map((r) => ({ name: r.name, license: r.license?.spdx_id ?? null, pushed_at: r.pushed_at })));
  }
  const wanted = repos.filter((r) => !NOT_VEHICLES.test(r.name) && (!o.only || o.only.includes(r.name)));
  const out = path.join(dir, "sources", "obdb");
  await mkdir(out, { recursive: true });
  const failed: string[] = []; let withSignals = 0, done = 0, next = 0;
  const worker = async () => {
    for (;;) {
      const r = wanted[next++];
      if (!r) return;
      try {
        const signals = await getText(f, `${OBDB_RAW}/${r.name}/main/signalsets/v3/default.json`);
        const gens = await getText(f, `${OBDB_RAW}/${r.name}/main/generations.yaml`);
        if (signals) {
          withSignals += 1;
          await mkdir(path.join(out, r.name), { recursive: true });
          await writeFile(path.join(out, r.name, "default.json"), signals, "utf8");
          await writeFile(path.join(out, r.name, "meta.json"), JSON.stringify({ name: r.name, licence: r.license, pushed: r.pushed_at, retrievedAt: at, generations: gens ?? null }), "utf8");
        }
      } catch (e) { failed.push(`${r.name}: ${(e as Error).message}`); }
      done += 1; o.onProgress?.(done, wanted.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  // OBDex: the published JSON bundle and its credit line
  const exDir = path.join(dir, "sources", "obdex");
  await mkdir(exDir, { recursive: true });
  const meta = await getJson(f, `${OBDEX}/meta.json`);
  const codes = await getJson(f, `${OBDEX}/generic.min.json`);
  await writeFile(path.join(exDir, "meta.json"), JSON.stringify({ ...(meta as object ?? {}), retrievedAt: at }), "utf8");
  await writeFile(path.join(exDir, "generic.json"), JSON.stringify(codes ?? []), "utf8");
  return { repos: wanted.length, withSignals, failed, dtcs: Array.isArray(codes) ? codes.length : 0, ms: Date.now() - t0 };
}

// ---- building ----

const UNITS: Record<string, string> = { celsius: "°C", fahrenheit: "°F", volts: "V", kilometersPerHour: "km/h", percent: "%", rpm: "rpm", kilopascal: "kPa", kilometers: "km", seconds: "s", minutes: "min", hours: "h", amps: "A", liters: "L", degrees: "°", bars: "bar", hectopascal: "hPa" };

/** "start_year: 2006 … end_year: 2018" blocks → year ranges (open end = this year). */
export function yearsOf(yaml: string | null): [number, number][] {
  if (!yaml) return [];
  const now = new Date().getFullYear();
  const out: [number, number][] = [];
  for (const block of yaml.split(/\n\s*-\s+name:/)) {
    const a = /start_year:\s*(\d{4})/.exec(block);
    if (!a) continue;
    const b = /end_year:\s*(\d{4})/.exec(block);
    out.push([Number(a[1]), b ? Number(b[1]) : now]);
  }
  return out;
}

interface ObdbCommand { hdr?: string; rax?: string; eax?: string; cmd: Record<string, string>; signals: { id: string; name: string; path?: string; description?: string; hidden?: boolean; fmt: Record<string, unknown> }[] }

/** One OBDb signal set → our signal definitions. */
export function fromObdb(set: { commands: ObdbCommand[] }, source: string, vehicle: SignalDef["vehicle"], setName: string): SignalDef[] {
  const out: SignalDef[] = [];
  for (const c of set.commands ?? []) {
    const [service, pid] = Object.entries(c.cmd ?? {})[0] ?? [];
    if (!service || typeof pid !== "string") continue;
    for (const s of c.signals ?? []) {
      const f = s.fmt ?? {};
      const n = (k: string) => (typeof f[k] === "number" ? (f[k] as number) : undefined);
      if (!n("len")) continue;
      const map = f.map && typeof f.map === "object" ? Object.fromEntries(Object.entries(f.map as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : String((v as { value?: unknown })?.value ?? JSON.stringify(v))])) : undefined;
      out.push({
        key: `${source}/${setName}/${c.hdr ?? "7DF"}/${service}${pid}/${s.id}`, source, trust: vehicle ? "community" : "standard", ...(vehicle ? { vehicle } : {}),
        tx: (c.hdr ?? "7E0").toUpperCase(), ...(c.rax ? { rx: c.rax.toUpperCase() } : {}), ...(c.eax ? { eax: c.eax.toUpperCase() } : {}),
        service: service.toUpperCase(), pid: pid.toUpperCase(), bit: n("bix") ?? 0, bits: n("len")!, ...(f.sign === true ? { signed: true } : {}),
        mul: n("mul") ?? 1, div: n("div") ?? 1, add: n("add") ?? 0, unit: UNITS[String(f.unit)] ?? String(f.unit ?? ""),
        ...(n("min") !== undefined ? { min: n("min") } : {}), ...(n("max") !== undefined ? { max: n("max") } : {}),
        ...(n("nullmin") !== undefined ? { nullmin: n("nullmin") } : {}), ...(n("nullmax") !== undefined ? { nullmax: n("nullmax") } : {}),
        ...(map ? { map } : {}), name: s.name, ...(s.path ? { group: s.path } : {}), ...(s.description ? { description: s.description.slice(0, 400) } : {}),
      } as SignalDef);
    }
  }
  return out;
}

/** Everything downloaded → one knowledge base (<dir>/kb.json). */
export async function buildKnowledge(dir: string): Promise<KnowledgeBase> {
  const obdbDir = path.join(dir, "sources", "obdb");
  const names = (await readdir(obdbDir).catch(() => [] as string[])).sort();
  const metas = await Promise.all(names.map(async (n) => JSON.parse(await readFile(path.join(obdbDir, n, "meta.json"), "utf8")) as { name: string; licence: string | null; pushed: string; retrievedAt: string; generations: string | null }));
  // a make's own set has no generations; a model set's make is the longest make name it starts with
  const makes = metas.filter((m) => !m.generations && m.name !== "SAEJ1979").map((m) => m.name).sort((a, b) => b.length - a.length);
  const signals: SignalDef[] = []; const vehicles: KnowledgeVehicle[] = [];
  let retrieved = "";
  for (const m of metas) {
    retrieved = m.retrievedAt > retrieved ? m.retrievedAt : retrieved;
    const set = JSON.parse(await readFile(path.join(obdbDir, m.name, "default.json"), "utf8")) as { commands: ObdbCommand[] };
    if (m.name === "SAEJ1979") { signals.push(...fromObdb(set, "obdb", undefined, m.name)); continue; }
    const make = makes.find((k) => m.name === k || m.name.startsWith(`${k}-`)) ?? m.name.split("-")[0];
    const model = m.name === make ? undefined : m.name.slice(make.length + 1).replace(/-/g, " ");
    const years = yearsOf(m.generations);
    const vehicle = { make: make.replace(/-/g, " ").replace(/^Mercedes Benz$/, "Mercedes-Benz"), ...(model ? { model } : {}), ...(years.length ? { years } : {}) };
    const defs = fromObdb(set, "obdb", vehicle, m.name);
    signals.push(...defs);
    vehicles.push({ ...vehicle, source: "obdb", set: m.name, signals: defs.length });
  }
  const exDir = path.join(dir, "sources", "obdex");
  const exMeta = JSON.parse(await readFile(path.join(exDir, "meta.json"), "utf8").catch(() => "{}")) as { retrievedAt?: string; generated_at?: string };
  const codes = JSON.parse(await readFile(path.join(exDir, "generic.json"), "utf8").catch(() => "[]")) as { code: string; category?: string; title?: { en?: string }; description?: { en?: string } }[];
  const dtcs: DtcDef[] = codes.filter((c) => c?.code && c.title?.en).map((c) => ({ code: c.code.toUpperCase(), title: c.title!.en!, ...(c.description?.en ? { description: c.description.en.slice(0, 700) } : {}), ...(c.category ? { category: c.category } : {}), source: "obdex" }));
  const sources: KnowledgeSource[] = [
    { id: "obdb", name: "OBDb — community vehicle diagnostics database", url: "https://github.com/OBDb", licence: "CC-BY-SA-4.0", terms: "Credit OBDb; anything published that builds on it must carry the same licence.", retrievedAt: retrieved },
    { id: "obdex", name: "OBDex — generic OBD-II fault codes", url: "https://github.com/foerbsnavi/OBDex", licence: "CC0-1.0", terms: "None (public domain); credit is voluntary.", retrievedAt: exMeta.retrievedAt ?? "", ...(exMeta.generated_at ? { version: exMeta.generated_at } : {}) },
  ];
  const kb: KnowledgeBase = { builtAt: new Date().toISOString(), sources, vehicles, signals, dtcs };
  await writeFile(path.join(dir, "kb.json"), JSON.stringify(kb), "utf8");
  return kb;
}

let cache: { dir: string; at: number; kb: KnowledgeBase; dtcIndex: Map<string, DtcDef> } | null = null;
/** The built knowledge base (read once, kept in memory); null when it was never built. */
export async function loadKnowledge(dir: string): Promise<{ kb: KnowledgeBase; dtcIndex: Map<string, DtcDef> } | null> {
  try {
    const file = path.join(dir, "kb.json");
    const { mtimeMs } = await import("node:fs/promises").then((m) => m.stat(file));
    if (cache && cache.dir === dir && cache.at === mtimeMs) return cache;
    const kb = JSON.parse(await readFile(file, "utf8")) as KnowledgeBase;
    cache = { dir, at: mtimeMs, kb, dtcIndex: new Map(kb.dtcs.map((d) => [d.code, d])) };
    return cache;
  } catch { return null; }
}
