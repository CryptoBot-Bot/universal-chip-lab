/** 5b/5c: what goes into the prompt, what is kept of the reply. No network, no car. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ModuleSweep, VehicleModule, VehicleProfile } from "@ecu/vehicle-db";
import { loadStoredVehicleProfiles, saveStoredVehicleProfile } from "@ecu/vehicle-db/vehicleStore";

import { labelAndSave, labelModule, labelPrompts, maskVins, parseProposals, recheckAndSave } from "./labelPipeline";

const VIN = "WDB9061351N123456";
const vinHex = Buffer.from(VIN, "ascii").toString("hex").toUpperCase();
const sweep = (condition: string, refs: ModuleSweep["refs"], hits: [string, string, string?][], over: Partial<ModuleSweep> = {}): ModuleSweep => ({
  at: "2026-11-25T01:00:00Z", condition, protocol: "kwp2000", sessions: [], ranges: [], counts: { asked: 1, answered: 1, moving: 0, gated: 0, ms: 1 }, ...(refs ? { refs } : {}),
  hits: hits.map(([id, bytes, again]) => ({ id, session: "92", bytes, moving: !!again, ...(again ? { again } : {}) })), ...over,
});
const OFF = { volts: [12.0, 12.04] as [number, number], rpm: [0, 0] as [number, number], coolant: [21, 21] as [number, number] };
const IDLE = { volts: [13.96, 14.08] as [number, number], rpm: [669.5, 688.5] as [number, number] };
const esp = {
  id: "esp", label: "ESP", category: "chassis", bus: "hs-can", location: "engine", protocol: "kwp2000", addressing: { request: "726", response: "4E6" },
  identity: { partNo: "9064460046" },
  sweeps: [
    sweep("engine off", OFF, [["21 2E", "2E902E90"], ["1A 90", vinHex], ["21 11", "00".repeat(120) + "01"], ["21 30", "AA"]]),
    sweep("idling", IDLE, [["21 2E", "36743674", "36883688"], ["1A 90", vinHex], ["21 11", "00".repeat(120) + "02"], ["21 30", "AA"]]),
  ],
} as unknown as VehicleModule;
const profile = {
  id: "t-van", year: 2015, make: "Mercedes-Benz", model: "Sprinter", bodyType: "van", buses: [{ id: "hs-can", label: "HS-CAN", protocol: "CAN", bitrate: 500000 }], capabilities: [],
  knownVins: [{ vin: VIN, firstReadAt: "", lastReadAt: "", reads: 1 }],
  provenance: { source: "user", confidence: 0.5, createdAt: "2026-11-25T00:00:00Z", updatedAt: "2026-11-25T00:00:00Z" },
  modules: [esp, { id: "srs", label: "SRS — Airbag Control Unit", category: "safety", bus: "hs-can", location: "engine", addressing: { request: "784", response: "785" }, sweeps: [sweep("engine off", OFF, [["22 F100", "01"]])] }],
} as unknown as VehicleProfile;
const answer = (labels: unknown[]) => async () => ({ labels, tokensIn: 100, tokensOut: 50, model: "test-model" });
const L = (id: string, kind: string, values: unknown[] = []) => ({ id, name: `name of ${id}`, kind, confidence: "medium", why: "because", values });
const V = (name: string, unit: string, factor: number) => ({ name, offset: 0, length: 2, signed: false, factor, add: 0, unit });

test("the VIN never goes into a prompt, and offsets stay true", () => {
  const masked = maskVins(`0102${vinHex}FF`, [VIN]);
  assert.equal(masked.length, `0102${vinHex}FF`.length);
  assert.equal(masked, `0102${"58".repeat(17)}FF`);
  const text = labelPrompts(profile, esp).join("\n");
  assert.ok(!text.includes(VIN) && !text.includes(vinHex) && !text.includes(vinHex.slice(-16)));
});

test("the prompt holds no reference reading — a match must be the AI's own", () => {
  const text = labelPrompts(profile, esp).join("\n");
  for (const s of ["12.04", "13.96", "14.08", "669.5", "688.5", "rpm", "coolant", " V "]) assert.ok(!text.includes(s), `prompt leaks "${s}"`);
  assert.ok(text.includes("engine off: 2E902E90") && text.includes("idling: 36743674  then  36883688"));
  assert.ok(text.includes("beyond byte 96: 120: 01/01 → 02/02"));             // a change far into a long block is shown
});

test("proposals are checked against the car; inventions, malformed entries and duplicates go", async () => {
  const r = await labelModule({ profile, moduleId: "esp", ask: answer([
    L("21 2E", "live", [V("Supply voltage terminal 30", "V", 0.001)]), L("1a 90", "identification"), L("21 30", "unknown"),
    L("21 99", "live"), L("not an id", "live"), L("21 2E", "coding"), { id: "21 11", kind: "nonsense" },
  ]) });
  assert.deepEqual(r.labels.map((x) => [x.id, x.kind, x.check.status]), [["21 2E", "live", "confirmed"], ["1A 90", "identification", "consistent"], ["21 30", "unknown", "unchecked"], ["21 11", "unknown", "unchecked"]]);
  assert.deepEqual(r.invented, ["21 99"]);
  assert.equal(r.model, "test-model");
});

test("a wrong scale is found out", async () => {
  const r = await labelModule({ profile, moduleId: "esp", ask: answer([L("21 2E", "live", [V("Supply voltage", "V", 0.0012)])]) });
  assert.equal(r.labels[0].check.status, "contradicted");
});

test("numbers that are not numbers do not get through", () => {
  const [p] = parseProposals([{ id: "21 2E", name: "x", kind: "live", confidence: "certain", why: "", values: [{ name: "v", offset: "0", length: 2, factor: null, unit: "V" }] }]);
  assert.equal(p.confidence, "low");
  assert.deepEqual([p.values[0].offset, p.values[0].factor], [-1, 1]);          // offset -1 → outside the data → contradicted, never a value
});

test("airbag / immobiliser modules and unswept modules are refused before anything is asked", async () => {
  let asked = 0;
  const ask = async () => { asked += 1; return { labels: [], tokensIn: 0, tokensOut: 0, model: "m" }; };
  await assert.rejects(labelModule({ profile, moduleId: "srs", ask }), /never swept/);
  await assert.rejects(labelModule({ profile: { ...profile, modules: [{ ...esp, sweeps: [] }] } as VehicleProfile, moduleId: "esp", ask }), /no sweep/);
  assert.equal(asked, 0);
});

test("labels are filed on the module and survive a later save from an older copy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ual-label-"));
  await saveStoredVehicleProfile(dir, profile, "2026-11-25T01:00:00Z");
  const old = (await loadStoredVehicleProfiles(dir)).records[0];
  await labelAndSave(dir, { profileId: "t-van", moduleId: "esp", ask: answer([L("21 2E", "live", [V("Supply voltage", "V", 0.001)])]) });
  await saveStoredVehicleProfile(dir, old, "2026-11-25T03:00:00Z");
  assert.equal((await loadStoredVehicleProfiles(dir)).records[0].modules[0].labels?.labels[0].check.status, "confirmed");
});

test("a re-check asks no AI, keeps every proposal and its cost, and applies the rules again", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ual-recheck-"));
  await saveStoredVehicleProfile(dir, profile, "2026-11-25T01:00:00Z");
  const a = (await labelAndSave(dir, { profileId: "t-van", moduleId: "esp", ask: answer([L("21 2E", "live", [V("Supply voltage", "V", 0.001)]), L("21 30", "unknown"), L("21 99", "live")]) })).labels;
  const b = (await recheckAndSave(dir, { profileId: "t-van", moduleId: "esp" })).labels;
  assert.deepEqual(b.labels, a.labels);
  assert.deepEqual([b.invented, b.tokensIn, b.tokensOut, b.model], [a.invented, a.tokensIn, a.tokensOut, a.model]);
});

test("identifiers a reply leaves out are asked about once more — only those", async () => {
  const asked: string[] = [];
  const ask = async (content: string) => {
    asked.push(content);
    const ids = [...content.matchAll(/^((?:21|1A|22) [0-9A-F]{2,4}) \|/gm)].map((x) => x[1]);
    return { labels: (asked.length === 1 ? ids.slice(0, 1) : ids).map((id) => L(id, "unknown")), tokensIn: 10, tokensOut: 5, model: "m" };
  };
  const r = await labelModule({ profile, moduleId: "esp", ask });
  assert.equal(asked.length, 2);
  assert.equal(r.labels.length, 4);
  assert.ok(!asked[1].includes(`${r.labels[0].id} |`));
  assert.equal(r.tokensIn, 20);
});

test("with labels on file, only the rest is asked and the stored ones stay", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ual-missing-"));
  await saveStoredVehicleProfile(dir, profile, "2026-11-25T01:00:00Z");
  const stop = { n: 0 };
  await labelAndSave(dir, { profileId: "t-van", moduleId: "esp", shouldStop: () => stop.n++ > 1, ask: answer([L("21 2E", "live", [V("Supply voltage", "V", 0.001)])]) });
  const asked: string[] = [];
  const r = (await labelAndSave(dir, { profileId: "t-van", moduleId: "esp", keepStored: true, ask: async (c) => { asked.push(c); return { labels: [L("21 30", "unknown"), L("1A 90", "identification"), L("21 11", "unknown")], tokensIn: 1, tokensOut: 1, model: "m" }; } })).labels;
  assert.equal(asked.length, 1);
  assert.ok(!asked[0].includes("21 2E |"));
  assert.deepEqual(r.labels.map((x) => x.id).sort(), ["1A 90", "21 11", "21 2E", "21 30"]);
});
