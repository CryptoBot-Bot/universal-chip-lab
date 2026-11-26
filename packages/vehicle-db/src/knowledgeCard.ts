/**
 * How much is known about one vehicle — the ladder, each step with its count and where the
 * knowledge came from. There is no "% of everything": only the maker knows the whole. The card
 * says what is found, identified, decoded by a standard, offered by the community and tested on
 * this car, and what our own mapping has named and proven.
 */
import { dtcMeaning, signalsFor, testSignal } from "./knowledge.js";
import type { DtcDef, KnowledgeBase, KnowledgeSource, SignalDef, SignalVerdict } from "./knowledge.js";
import { labelSummary, readsOf, varies } from "./moduleLabels.js";
import { protectedModule } from "./protectedModules.js";
import type { VehicleProfile } from "./vehicleProfile.schema.js";

export interface CardSignal { name: string; module: string; request: string; unit: string; verdict: SignalVerdict; note: string; values: string; sets: string[] }
export interface KnowledgeCard {
  vehicle: string;
  modules: { found: number; identified: number; serials: number; faultsRead: number; protected: number };
  standard: { definitions: number; modules: { module: string; supported: number; decoded: number }[] };
  faults: { code: string; module: string; title?: string; makerSpecific: boolean }[];
  community: {
    modelSets: string[]; makeSet: string | null;
    candidates: number; tested: number;
    verdicts: Record<SignalVerdict, number>;
    signals: CardSignal[];
  };
  own: { answered: number; changing: number; named: number; proven: number; labelled: number; swept: number };
  sources: KnowledgeSource[];
  builtAt: string | null;
}

const hex = (s?: string) => (s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");
const fmt = (v: number | string | null) => (v === null ? "—" : typeof v === "number" ? String(Math.round(v * 100) / 100) : v);

/** Supported standard values of a module, from the `01 00/20/40…` answers its sweeps kept. */
export function obdSupported(m: VehicleProfile["modules"][number]): string[] {
  const set = new Set<string>();
  for (const s of m.sweeps ?? []) for (const p of s.obd ?? []) set.add(p);
  return [...set].sort();
}

export function knowledgeCard(profile: VehicleProfile, kb: KnowledgeBase | null, dtcIndex?: Map<string, DtcDef>): KnowledgeCard {
  const unit = profile.knownVins?.[0];
  const inv = unit?.inventory;
  const mods = profile.modules.filter((m) => m.addressing?.response);
  const lastScan = unit?.scans?.length ? unit.scans[unit.scans.length - 1] : null;
  const card: KnowledgeCard = {
    vehicle: `${profile.year ?? ""} ${profile.make} ${profile.model}`.trim(),
    modules: {
      found: mods.length,
      identified: inv?.modules.filter((x) => x.status === "ok").length ?? 0,
      serials: inv?.modules.filter((x) => x.summary.serial).length ?? 0,
      faultsRead: lastScan?.systems.filter((x) => x.status === "ok" || x.status === "fault").length ?? 0,
      protected: mods.filter((m) => protectedModule({ category: m.category, label: m.label })).length,
    },
    standard: { definitions: 0, modules: [] },
    faults: [],
    community: { modelSets: [], makeSet: null, candidates: 0, tested: 0, verdicts: { proven: 0, fits: 0, "no-answer": 0, "too-short": 0, "out-of-range": 0, "not-swept": 0 }, signals: [] },
    own: { answered: 0, changing: 0, named: 0, proven: 0, labelled: 0, swept: 0 },
    sources: kb?.sources ?? [],
    builtAt: kb?.builtAt ?? null,
  };

  // our own mapping
  for (const m of mods) {
    const sweeps = (m.sweeps ?? []).filter((s) => !s.sim);
    if (!sweeps.length) continue;
    card.own.swept += 1;
    const reads = readsOf(sweeps);
    card.own.answered += reads.size;
    card.own.changing += [...reads.values()].filter(varies).length;
    if (m.labels) { const s = labelSummary(m.labels, sweeps); card.own.labelled += 1; card.own.named += s.named; card.own.proven += s.confirmed; }
  }

  // fault codes on file, with their public meaning
  for (const s of lastScan?.systems ?? []) for (const d of s.dtcs) {
    const mean = kb ? dtcMeaning(kb, d.code, dtcIndex) : { makerSpecific: false };
    card.faults.push({ code: d.code, module: s.label.split(" — ")[0].split(" (")[0], ...("title" in mean && mean.title ? { title: mean.title } : {}), makerSpecific: mean.makerSpecific });
  }
  if (!kb) return card;

  // the standard: every supported value is decoded by definition
  const v = signalsFor(kb, { make: profile.make, model: profile.model, year: profile.year });
  const stdPids = new Set(v.standard.filter((s) => s.service === "01").map((s) => s.pid));
  card.standard.definitions = new Set(v.standard.map((s) => `${s.service}${s.pid}`)).size;
  for (const m of mods) {
    const sup = obdSupported(m);
    if (sup.length) card.standard.modules.push({ module: m.label.split(" — ")[0].split(" (")[0], supported: sup.length, decoded: sup.filter((p) => stdPids.has(p)).length });
  }

  // the community: this model's sets, the make's, and other models' — each tested on this car
  card.community.modelSets = [...new Set(v.model.map((s) => s.key.split("/")[1]))];
  card.community.makeSet = v.make[0]?.key.split("/")[1] ?? null;
  const groups = new Map<string, { def: SignalDef; sets: Set<string> }>();
  for (const s of [...v.model, ...v.make, ...v.otherModels]) {
    if (s.eax) continue;
    const g = `${s.tx}|${s.service}|${s.pid}|${s.bit}|${s.bits}|${s.mul}|${s.div}|${s.add}|${s.name.toLowerCase()}`;
    const cur = groups.get(g);
    if (cur) cur.sets.add(s.key.split("/")[1]); else groups.set(g, { def: s, sets: new Set([s.key.split("/")[1]]) });
  }
  card.community.candidates = groups.size;
  for (const { def, sets } of groups.values()) {
    const m = mods.find((x) => hex(x.addressing?.request) === hex(def.tx));
    if (!m) continue;
    const t = testSignal(def, m);
    card.community.tested += 1;
    card.community.verdicts[t.verdict] += 1;
    if (t.verdict === "proven" || t.verdict === "fits" || t.verdict === "out-of-range") {
      card.community.signals.push({
        name: def.name, module: m.label.split(" — ")[0].split(" (")[0], request: `${def.service} ${def.pid}`, unit: def.unit, verdict: t.verdict, note: t.note,
        values: t.at.map((a) => `${a.condition} ${[...new Set(a.values.map(fmt))].join(" / ")}`).join(" · "), sets: [...sets],
      });
    }
  }
  const order: Record<string, number> = { proven: 0, fits: 1, "out-of-range": 2 };
  card.community.signals.sort((a, b) => order[a.verdict] - order[b.verdict] || a.module.localeCompare(b.module));
  return card;
}
