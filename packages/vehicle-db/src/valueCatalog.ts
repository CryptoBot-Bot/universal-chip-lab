/**
 * Everything that can be read from one vehicle as a value with a meaning — the only things the
 * mechanic assistant may read. Each item says how far it is trusted:
 *
 *   standard   an OBD-II value this module says it supports (SAE J1979: decoded by definition)
 *   proven     follows the car's own measurements in two states
 *   fits       a community definition (other model, same make) that fits this car's recordings
 *   ai         named by the AI from recorded bytes, not proven
 *
 * Reading means: the module's address, one request, maybe a harmless session, and a decode
 * rule from a source. Never airbag / immobiliser modules, never anything but a read.
 */
import { decodeSignal, signalsFor, testSignal } from "./knowledge.js";
import type { KnowledgeBase, SignalDef } from "./knowledge.js";
import { protectedModule } from "./protectedModules.js";
import type { VehicleModule, VehicleProfile } from "./vehicleProfile.schema.js";

export type CatalogTrust = "standard" | "proven" | "fits" | "ai";
export type Decode = Pick<SignalDef, "bit" | "bits" | "signed" | "mul" | "div" | "add" | "map" | "nullmin" | "nullmax">;

export interface CatalogItem {
  id: string;
  name: string;
  unit: string;
  module: { id: string; short: string; tx: string; rx: string; protocol: "uds" | "kwp2000" | "obd2" };
  /** The request as hex, e.g. "010C", "220163", "2131". */
  request: string;
  /** Session the request needs: "" = the one the module is in. */
  session: string;
  decode: Decode;
  trust: CatalogTrust;
  source: string;
}

const hex = (s?: string) => (s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");
const shortOf = (label: string) => label.split(" — ")[0].split(" (")[0].trim();
const TRUST_ORDER: Record<CatalogTrust, number> = { proven: 0, standard: 1, fits: 2, ai: 3 };

/** The session an identifier answered in during the sweeps ("" for the default). */
function sessionOf(m: VehicleModule, id: string): string {
  for (const s of m.sweeps ?? []) {
    const h = s.hits.find((x) => x.id === id && !x.gated);
    if (h) return h.session === "01" || h.session === "81" ? "" : h.session;
  }
  return "";
}

export function vehicleCatalog(profile: VehicleProfile, kb: Pick<KnowledgeBase, "signals"> | null): CatalogItem[] {
  const out: CatalogItem[] = [];
  const seen = new Set<string>();
  const add = (it: CatalogItem) => {
    const k = `${it.module.tx}|${it.request}|${it.decode.bit}|${it.decode.bits}|${it.decode.mul}|${it.decode.div}|${it.decode.add}`;
    if (seen.has(k)) return;                       // the same field from a weaker source adds nothing
    seen.add(k); out.push(it);
  };
  const mods = profile.modules.filter((m) => m.addressing?.request && m.addressing?.response && !protectedModule({ category: m.category, label: m.label }));
  const modOf = (m: VehicleModule): CatalogItem["module"] => ({ id: m.id, short: shortOf(m.label), tx: hex(m.addressing!.request), rx: hex(m.addressing!.response), protocol: m.protocol === "kwp2000" ? "kwp2000" : m.protocol === "obd2" ? "obd2" : "uds" });
  const v = kb ? signalsFor(kb, { make: profile.make, model: profile.model, year: profile.year }) : null;

  // 1. proven by our own check (labels), then 2. standard, 3. community that fits, 4. AI proposals
  const labelItems = (m: VehicleModule, proven: boolean) => {
    for (const l of m.labels?.labels ?? []) {
      if (l.kind === "unknown" || l.kind === "identification" || l.kind === "coding") continue;
      // a value with no real name tells the assistant nothing
      if (!proven && l.values.every((x) => /\bunknown\b|^value \d|\braw\b/i.test(x.name))) continue;
      l.values.forEach((val, i) => {
        const r = l.check.readings[i];
        if (!r || r.status === "contradicted" || (r.status === "confirmed") !== proven) return;
        add({
          id: `label:${m.id}:${l.id}:${val.offset}:${val.length}`, name: val.name, unit: val.unit, module: modOf(m), request: hex(l.id), session: sessionOf(m, l.id),
          decode: { bit: val.offset * 8, bits: val.length * 8, signed: val.signed, mul: val.factor, div: 1, add: val.add },
          trust: proven ? "proven" : "ai", source: proven ? "proven on this car (follows its own readings)" : "named by the AI, not proven",
        });
      });
    }
  };
  for (const m of mods) labelItems(m, true);
  if (v) {
    const std = v.standard.filter((s) => s.service === "01");
    for (const m of mods) {
      const supported = new Set((m.sweeps ?? []).flatMap((s) => s.obd ?? []));
      for (const s of std) if (supported.has(s.pid)) add({ id: `std:${hex(m.addressing!.request)}:${s.pid}:${s.bit}`, name: s.name, unit: s.unit, module: modOf(m), request: `01${s.pid}`, session: "", decode: s, trust: "standard", source: "OBD-II standard (SAE J1979), definitions from OBDb" });
    }
    for (const s of [...v.model, ...v.make, ...v.otherModels]) {
      if (s.eax || !["21", "22"].includes(s.service)) continue;
      const m = mods.find((x) => hex(x.addressing?.request) === hex(s.tx));
      if (!m) continue;
      const t = testSignal(s, m);
      if (t.verdict !== "fits" && t.verdict !== "proven") continue;
      add({ id: `obdb:${s.key}`, name: s.name, unit: s.unit, module: modOf(m), request: `${s.service}${s.pid}`, session: sessionOf(m, `${s.service} ${s.pid}`), decode: s, trust: t.verdict === "proven" ? "proven" : "fits", source: `OBDb ${s.key.split("/")[1]} (CC BY-SA), ${t.note}` });
    }
  }
  for (const m of mods) labelItems(m, false);
  return out;
}

/** Items matching every word of the query (name, unit, module), best trust first. */
export function searchCatalog(items: CatalogItem[], query: string, limit = 25): CatalogItem[] {
  const words = query.toLowerCase().split(/[^a-z0-9°%/]+/).filter((w) => w.length > 1);
  const hits = items.filter((it) => {
    const text = `${it.name} ${it.unit} ${it.module.short} ${it.module.id}`.toLowerCase();
    return words.every((w) => text.includes(w) || (w === "rpm" && /speed/.test(text)) || (w === "temp" && /temperature/.test(text)) || (w === "battery" && /volt/.test(text)));
  });
  return hits.sort((a, b) => TRUST_ORDER[a.trust] - TRUST_ORDER[b.trust] || a.name.localeCompare(b.name)).slice(0, limit);
}

/** The data bytes of an answer to `request` (after the positive-response echo), or null. */
export function answerData(request: string, response?: string | null): string | null {
  const q = hex(request), r = hex(response ?? undefined);
  if (!r || r.startsWith("7F")) return null;
  const echo = (parseInt(q.slice(0, 2), 16) + 0x40).toString(16).toUpperCase().padStart(2, "0") + q.slice(2);
  return r.startsWith(echo) ? r.slice(echo.length) : null;
}

export function decodeItem(it: CatalogItem, response?: string | null): number | string | null {
  const data = answerData(it.request, response);
  return data === null ? null : decodeSignal(it.decode, data);
}
