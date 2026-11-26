/**
 * The mechanic assistant, stage 1: it looks, it does not act. It talks with the operator about
 * one vehicle and may (1) find values in that vehicle's catalog, (2) read them live, (3) look at
 * the fault codes on file and what they mean. It cannot write, clear, actuate, code or reset —
 * those tools do not exist here — and it never sends bytes of its own: a read is always a
 * catalog item (address, request, decode rule from a named source).
 */
import Anthropic from "@anthropic-ai/sdk";

import type { CatalogItem, VehicleProfile } from "@ecu/vehicle-db";

import { explorerModel } from "./moduleExplorer";
import { getApiKey } from "../settings";

export interface MechanicContext {
  profile: VehicleProfile;
  vin?: string;
  catalog: CatalogItem[];
  /** Last scan on file, with meanings: "ESP B170B (maker-specific) …". */
  faults: string[];
  voltage?: string;
  /** "connected: …" or "no device connected". */
  device: string;
}

export interface MechanicTools {
  find: (query: string) => CatalogItem[];
  read: (ids: string[]) => Promise<{ id: string; name: string; module: string; value: number | string | null; unit: string; trust: string; error?: string }[]>;
  explain: (code: string) => { code: string; title?: string; description?: string; makerSpecific: boolean };
}

export type MechanicEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "values"; values: Awaited<ReturnType<MechanicTools["read"]>> }
  | { type: "found"; query: string; items: { id: string; name: string; unit: string; module: string; trust: string }[] }
  | { type: "done"; tokensIn: number; tokensOut: number; model: string };

export const MECHANIC_TOOLS: Anthropic.Tool[] = [
  {
    name: "find_values",
    description: "Search this vehicle's catalog of readable values by words (e.g. 'coolant temperature', 'battery voltage', 'transmission'). Returns item ids, names, units, module and trust. Only catalog items can be read.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "a few words" } }, required: ["query"] },
  },
  {
    name: "read_values",
    description: "Read catalog items from the car right now, by id (from find_values), up to 16 at a time. Returns each value with its unit and trust: standard (OBD-II definition), proven (checked on this car), fits (community definition that fits this car), ai (named by an AI, not proven). Read-only.",
    input_schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "catalog item ids" } }, required: ["ids"] },
  },
  {
    name: "explain_code",
    description: "The public meaning of a fault code (OBDex). Maker-specific codes have none — say so instead of guessing.",
    input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
];

export function mechanicSystem(c: MechanicContext): string {
  const p = c.profile;
  const counts = c.catalog.reduce((n, it) => ({ ...n, [it.trust]: (n[it.trust] ?? 0) + 1 }), {} as Record<string, number>);
  const modules = p.modules.filter((m) => m.addressing?.response).map((m) => `${m.label.split(" (")[0]}${m.identity?.partNo ? ` [${m.identity.partNo}]` : ""}`).join("; ");
  return `You are the mechanic's assistant in a shop diagnostic tool, working on one vehicle with the technician. You can SEE the car through read-only tools; you cannot act on it.

Vehicle: ${p.year ?? "?"} ${p.make} ${p.model}${p.decoded?.engine ? `, ${p.decoded.engine}` : ""}${p.decoded?.driveType ? `, ${p.decoded.driveType}` : ""}.
Device: ${c.device}.${c.voltage ? ` Supply voltage: ${c.voltage}.` : ""}
Modules: ${modules || "none on file"}.
Fault codes on file (last scan): ${c.faults.length ? c.faults.join(" | ") : "none"}.
Readable values: ${c.catalog.length} (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}).

How to work:
- Answer like an experienced technician talking to a colleague: short, concrete, in plain words. Lead with what matters.
- Use the tools when a live value would help; read only what you need. When no device is connected, say what you would read and work from what is on file.
- Say how sure each fact is. Values marked "standard" or "proven" are solid; "fits" means a definition from a related model that fits this car's recordings but is not proven; "ai" is a guess. Never present a guess as a measurement. If a needed value is not in the catalog, say it is not mapped yet.
- Explain fault codes with their public meaning; maker-specific codes have none in the open data — say so, and say what you would check.
- You cannot clear codes, run tests, change coding, reset modules or move anything, and you must not pretend to. If the technician needs that, say which function of a scan tool or which manual step does it, and what to watch out for.
- Safety: engine running indoors needs extraction; mention it when you suggest running the engine. Airbag and immobiliser systems are left alone beyond their fault codes.
- Never help defeat emissions equipment (DPF, EGR, SCR/AdBlue), immobilisers or odometers — say plainly that you won't, and offer the legitimate repair path.`;
}

/** One question → the answer, with tool use, streamed. `history` holds the whole conversation and is extended. */
export async function askMechanic(o: {
  history: Anthropic.MessageParam[];
  question: string;
  context: MechanicContext;
  tools: MechanicTools;
  onEvent: (e: MechanicEvent) => void;
  shouldStop?: () => boolean;
  /** For tests: a stand-in for the model. */
  create?: (body: Anthropic.MessageCreateParamsNonStreaming, onText: (d: string) => void) => Promise<Anthropic.Message>;
}): Promise<{ answer: string; tokensIn: number; tokensOut: number }> {
  const model = explorerModel();
  const create = o.create ?? (async (body, onText) => {
    const apiKey = getApiKey();
    if (!apiKey || !apiKey.trim()) throw new Error("No Anthropic API key set. Open Settings and paste your key to talk to the assistant.");
    const s = new Anthropic({ apiKey }).messages.stream(body);
    s.on("text", (d) => onText(d));
    return s.finalMessage();
  });
  o.history.push({ role: "user", content: o.question });
  let tokensIn = 0, tokensOut = 0, answer = "";
  for (let step = 0; step < 8; step++) {
    if (o.shouldStop?.()) break;
    const msg = await create({ model, max_tokens: 16000, thinking: { type: "adaptive" }, system: mechanicSystem(o.context), tools: MECHANIC_TOOLS, messages: o.history }, (d) => o.onEvent({ type: "text", delta: d }));
    tokensIn += msg.usage?.input_tokens ?? 0; tokensOut += msg.usage?.output_tokens ?? 0;
    // the reply goes back unchanged (thinking blocks included) — the API requires it
    o.history.push({ role: "assistant", content: msg.content });
    answer += msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || !uses.length) break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      const input = (u.input ?? {}) as Record<string, unknown>;
      o.onEvent({ type: "tool", name: u.name, input });
      let content: string;
      try {
        if (u.name === "find_values") {
          const q = String(input.query ?? "");
          const items = o.tools.find(q);
          o.onEvent({ type: "found", query: q, items: items.map((it) => ({ id: it.id, name: it.name, unit: it.unit, module: it.module.short, trust: it.trust })) });
          content = items.length ? items.map((it) => `${it.id} | ${it.name} | ${it.unit} | ${it.module.short} | ${it.trust}`).join("\n") : "Nothing in the catalog matches. The value may not be mapped on this vehicle yet.";
        } else if (u.name === "read_values") {
          const ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
          const values = await o.tools.read(ids);
          o.onEvent({ type: "values", values });
          content = values.map((v) => `${v.name} (${v.module}): ${v.value === null ? `no value — ${v.error ?? "unknown"}` : `${v.value} ${v.unit}`} [${v.trust}]`).join("\n") || "Nothing was read.";
        } else if (u.name === "explain_code") {
          const m = o.tools.explain(String(input.code ?? ""));
          content = m.title ? `${m.code}: ${m.title}. ${m.description ?? ""}` : m.makerSpecific ? `${m.code}: maker-specific, no public meaning in the open data.` : `${m.code}: no meaning found in the open data.`;
        } else content = `There is no tool called ${u.name}. This assistant can only find and read values and explain codes.`;
      } catch (e) { content = `Failed: ${(e as Error).message}`; }
      results.push({ type: "tool_result", tool_use_id: u.id, content });
    }
    o.history.push({ role: "user", content: results });
  }
  o.onEvent({ type: "done", tokensIn, tokensOut, model });
  return { answer, tokensIn, tokensOut };
}
