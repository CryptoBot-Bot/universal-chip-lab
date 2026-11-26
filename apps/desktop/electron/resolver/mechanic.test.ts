/** The read-only mechanic: catalog, live reads, the tool loop — with a stand-in model and a fake device. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type Anthropic from "@anthropic-ai/sdk";
import { decodeItem, searchCatalog, vehicleCatalog } from "@ecu/vehicle-db";
import type { KnowledgeBase, ModuleSweep, SignalDef, VehicleProfile } from "@ecu/vehicle-db";

import { readCatalogItems } from "../pipeline/readCatalog";
import { askMechanic, MECHANIC_TOOLS, mechanicSystem } from "./mechanic";

const sig = (o: Partial<SignalDef>): SignalDef => ({ key: "obdb/SAEJ1979/7E0/0105/ECT", source: "obdb", trust: "standard", tx: "7E0", service: "01", pid: "05", bit: 0, bits: 8, mul: 1, div: 1, add: -40, unit: "°C", name: "Engine coolant temperature", ...o });
const kb = { signals: [
  sig({}), sig({ key: "obdb/SAEJ1979/7E0/010C/RPM", pid: "0C", bits: 16, div: 4, add: 0, unit: "rpm", name: "Engine speed" }), sig({ key: "obdb/SAEJ1979/7E0/0111/TP", pid: "11", add: 0, unit: "%", name: "Throttle position" }),
  sig({ key: "obdb/Mercedes-Benz-E-Class/7E0/220163/T", trust: "community", vehicle: { make: "Mercedes-Benz", model: "E-Class" }, service: "22", pid: "0163", bit: 48, bits: 16, div: 10, add: -273.1, unit: "°C", name: "Boost air temperature", min: -273, max: 6280 }),
] } as Pick<KnowledgeBase, "signals">;
const sweep = (condition: string, refs: ModuleSweep["refs"], hits: Record<string, [string, string, string?]>, obd?: string[]): ModuleSweep => ({
  at: "", condition, protocol: "kwp2000", sessions: [], ranges: [], counts: { asked: 0, answered: 0, moving: 0, gated: 0, ms: 0 }, refs, ...(obd ? { obd } : {}),
  hits: Object.entries(hits).map(([id, [session, a, b]]) => ({ id, session, bytes: a, moving: !!b, ...(b ? { again: b } : {}) })),
});
const label = (id: string, name: string, unit: string, factor: number, status: "confirmed" | "consistent" | "contradicted") => ({
  id, name, kind: "live", confidence: "low", why: "", values: [{ name, offset: 0, length: 2, signed: false, factor, add: 0, unit }],
  check: { status, notes: [], readings: [{ name, unit, status, at: [] }] },
});
const profile = {
  id: "t-van", year: 2015, make: "Mercedes-Benz", model: "Sprinter", bodyType: "van", buses: [], capabilities: [], knownVins: [],
  provenance: { source: "user", confidence: 1, createdAt: "", updatedAt: "" },
  modules: [
    { id: "ecm", label: "CDI Engine Control Unit (ECM)", category: "powertrain", bus: "hs-can", location: "engine", protocol: "uds", addressing: { request: "7E0", response: "7E8" },
      sweeps: [sweep("engine off", { rpm: [0, 0] }, { "22 0163": ["03", "0000000000000B7C"] }, ["05", "0C"]), sweep("idling", { rpm: [670, 688] }, { "22 0163": ["03", "0000000000000B65", "0000000000000B62"] }, ["05", "0C"])] },
    { id: "egs", label: "EGS — Transmission Control Unit", category: "transmission", bus: "hs-can", location: "engine", protocol: "kwp2000", addressing: { request: "7E1", response: "7E9" },
      sweeps: [sweep("idling", { rpm: [670, 688] }, { "21 31": ["92", "02AD", "02AC"], "21 34": ["92", "0230"], "21 99": ["92", "0001"] })],
      labels: { at: "", model: "m", sweeps: [], invented: [], tokensIn: 0, tokensOut: 0, labels: [label("21 31", "Engine speed", "rpm", 1, "confirmed"), label("21 34", "Supply voltage", "V", 0.025, "consistent"), label("21 99", "Nonsense", "°C", 1000, "contradicted")] } },
    { id: "srs", label: "SRS — Airbag Control Unit", category: "safety", bus: "hs-can", location: "cabin_front", addressing: { request: "784", response: "785" },
      sweeps: [sweep("idling", undefined, { "22 0100": ["01", "0102"] }, ["05"])] },
  ],
} as unknown as VehicleProfile;

test("the catalog: proven first, standard by support, community that fits, AI last; nothing wrong, nothing protected", () => {
  const c = vehicleCatalog(profile, kb);
  assert.deepEqual(c.map((x) => [x.module.id, x.name, x.trust]), [
    ["egs", "Engine speed", "proven"], ["ecm", "Engine coolant temperature", "standard"], ["ecm", "Engine speed", "standard"],
    ["ecm", "Boost air temperature", "fits"], ["egs", "Supply voltage", "ai"],
  ]);
  assert.ok(!c.some((x) => x.module.id === "srs"));                                   // airbag: never
  assert.equal(c.find((x) => x.module.id === "egs" && x.trust === "proven")!.session, "92");
  assert.equal(c.find((x) => x.trust === "standard")!.session, "");
  assert.deepEqual(searchCatalog(c, "engine speed").map((x) => x.trust), ["proven", "standard"]);
  assert.deepEqual(searchCatalog(c, "battery").map((x) => x.name), ["Supply voltage"]);
  assert.equal(decodeItem(c.find((x) => x.name === "Engine coolant temperature")!, "41053D"), 21);
  assert.equal(decodeItem(c.find((x) => x.name === "Engine coolant temperature")!, "7F0112"), null);
});

function fakeDevice() {
  const sent: string[][] = [];
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const b = JSON.parse(init?.body ?? "{}") as { tx: string; requests: string[] };
    sent.push([b.tx, ...b.requests]);
    const a: Record<string, string> = { "0105": "41053D", "010C": "410C0AA0", "1092": "5092", "2131": "613102AD", "1081": "5081", "220163": "6201630000000000000B65" };
    return new Response(JSON.stringify({ ok: true, results: b.requests.map((q) => ({ request: q, response: a[q] ?? "7F1111", ...(a[q] ? {} : { negative: true, nrc: 0x11 }) })) }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return sent;
}

test("live reads: one socket per module and session, a session opened is closed, values decoded", async () => {
  const sent = fakeDevice();
  const c = vehicleCatalog(profile, kb);
  const v = await readCatalogItems({ host: "fake:8080", iface: "can0", profile, items: c.filter((x) => x.trust !== "ai") });
  assert.deepEqual(v.map((x) => [x.name, x.value]), [["Engine speed", 685], ["Engine coolant temperature", 21], ["Engine speed", 680], ["Boost air temperature", 18.6]]);
  assert.deepEqual(sent, [["7E1", "1092", "2131", "1081"], ["7E0", "0105", "010C"], ["7E0", "1003", "220163", "1001"]]);
});

test("the conversation: tools run, the reply goes back unchanged, a made-up tool does nothing", async () => {
  fakeDevice();
  const c = vehicleCatalog(profile, kb);
  const history: Anthropic.MessageParam[] = [];
  const events: string[] = [];
  const replies: Anthropic.Message[] = [
    { id: "1", type: "message", role: "assistant", model: "m", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } as Anthropic.Usage,
      content: [{ type: "thinking", thinking: "", signature: "sig-1" } as unknown as Anthropic.ContentBlock, { type: "tool_use", id: "t1", name: "find_values", input: { query: "coolant" } } as Anthropic.ToolUseBlock] } as Anthropic.Message,
    { id: "2", type: "message", role: "assistant", model: "m", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 20, output_tokens: 5 } as Anthropic.Usage,
      content: [{ type: "tool_use", id: "t2", name: "read_values", input: { ids: [c.find((x) => x.name === "Engine coolant temperature")!.id] } } as Anthropic.ToolUseBlock, { type: "tool_use", id: "t3", name: "clear_codes", input: {} } as Anthropic.ToolUseBlock] } as Anthropic.Message,
    { id: "3", type: "message", role: "assistant", model: "m", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 30, output_tokens: 9 } as Anthropic.Usage,
      content: [{ type: "text", text: "Coolant is 21 °C: the engine is cold.", citations: null } as Anthropic.TextBlock] } as Anthropic.Message,
  ];
  let n = 0;
  const r = await askMechanic({
    history, question: "Is the engine warm?", context: { profile, catalog: c, faults: [], device: "test" },
    tools: { find: (q) => searchCatalog(c, q), read: (ids) => readCatalogItems({ host: "fake:8080", iface: "can0", profile, items: c.filter((x) => ids.includes(x.id)) }), explain: (code) => ({ code, makerSpecific: true }) },
    onEvent: (e) => events.push(e.type === "values" ? `values:${e.values.map((v) => v.value).join(",")}` : e.type),
    create: async (body, onText) => { const m = replies[n++]; for (const b of m.content) if (b.type === "text") onText(b.text); assert.ok(body.tools?.every((t) => ["find_values", "read_values", "explain_code"].includes((t as Anthropic.Tool).name))); return m; },
  });
  assert.equal(r.answer, "Coolant is 21 °C: the engine is cold.");
  assert.deepEqual(events, ["tool", "found", "tool", "values:21", "tool", "text", "done"]);
  assert.equal(history[1].content, replies[0].content);                                   // thinking block echoed unchanged
  const last = history[4].content as Anthropic.ToolResultBlockParam[];
  assert.match(String(last[1].content), /no tool called clear_codes/);
  assert.deepEqual([r.tokensIn, r.tokensOut], [60, 19]);
});

test("the assistant has no tool that writes, and is told so", () => {
  assert.deepEqual(MECHANIC_TOOLS.map((t) => t.name), ["find_values", "read_values", "explain_code"]);
  const s = mechanicSystem({ profile, catalog: [], faults: ["ESP B170B maker-specific"], device: "no device connected" });
  assert.match(s, /cannot clear codes, run tests, change coding/);
  assert.match(s, /Never help defeat emissions equipment/);
  assert.match(s, /B170B/);
});
