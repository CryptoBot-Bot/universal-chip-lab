/**
 * Read catalog items from the car, live. Grouped per module and session over one socket each;
 * a session that was opened is closed again (10 01 on UDS, 10 81 on KWP). Every request passes
 * the read-only policy in readSeq; airbag / immobiliser modules are never in the catalog.
 */
import { decodeItem, protectedModule } from "@ecu/vehicle-db";
import type { CatalogItem, VehicleProfile } from "@ecu/vehicle-db";

import { readSeq } from "./vehiclePipeline";

export interface ReadValue { id: string; name: string; module: string; value: number | string | null; unit: string; trust: CatalogItem["trust"]; source: string; error?: string }

/** At most this many values per call: a mechanic asks for a few things at a time. */
export const MAX_READ = 16;

export async function readCatalogItems(o: { host?: string; iface: string; profile: VehicleProfile; items: CatalogItem[] }): Promise<ReadValue[]> {
  const items = o.items.slice(0, MAX_READ);
  const out: ReadValue[] = [];
  const groups = new Map<string, CatalogItem[]>();
  for (const it of items) {
    const m = o.profile.modules.find((x) => x.id === it.module.id);
    if (!m || protectedModule({ category: m.category, label: m.label })) { out.push({ id: it.id, name: it.name, module: it.module.short, value: null, unit: it.unit, trust: it.trust, source: it.source, error: "not readable here" }); continue; }
    const k = `${it.module.tx}|${it.module.rx}|${it.session}`;
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  for (const [k, list] of groups) {
    const [tx, rx, session] = k.split("|");
    const reqs = [...new Set(list.map((it) => it.request))];
    const close = session ? [list[0].module.protocol === "kwp2000" ? "1081" : "1001"] : [];
    try {
      const res = await readSeq(o.host, o.iface, tx, rx, [...(session ? [`10${session}`] : []), ...reqs, ...close], { timeout: 1.0 });
      const body = session ? res.slice(1) : res;
      const by = new Map(reqs.map((q, i) => [q, body[i]]));
      for (const it of list) {
        const r = by.get(it.request);
        const value = decodeItem(it, r?.response);
        out.push({ id: it.id, name: it.name, module: it.module.short, value, unit: it.unit, trust: it.trust, source: it.source, ...(value === null ? { error: r?.response ? (r.response.toUpperCase().startsWith("7F") ? `refused (${r.response})` : "no value in the answer") : (r?.error ? String(r.error) : "no answer") } : {}) });
      }
    } catch (e) {
      for (const it of list) out.push({ id: it.id, name: it.name, module: it.module.short, value: null, unit: it.unit, trust: it.trust, source: it.source, error: (e as Error).message });
    }
  }
  return out;
}
