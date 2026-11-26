import assert from "node:assert/strict";
import { test } from "node:test";

import { checkLabel, checkLabels, findTracks, labelSummary, luckOfTracks, readsOf, stateCheck, valueAt } from "./moduleLabels.js";
import type { LabelProposal, LabelValue, SweepRefs } from "./moduleLabels.js";
import type { ModuleSweep } from "./moduleSweep.js";

const OFF: SweepRefs = { volts: [12.0, 12.04], rpm: [0, 0], coolant: [21, 21] };
const IDLE: SweepRefs = { volts: [13.96, 14.08], rpm: [669, 689] };
const sweep = (condition: string, refs: SweepRefs | undefined, hits: Record<string, [string, string?]>): ModuleSweep => ({
  at: "", condition, protocol: "kwp2000", sessions: [], ranges: [], counts: { asked: 0, answered: 0, moving: 0, gated: 0, ms: 0 }, ...(refs ? { refs } : {}),
  hits: Object.entries(hits).map(([id, [a, b]]) => ({ id, session: "92", bytes: a, moving: !!b, ...(b ? { again: b } : {}) })),
});
const val = (name: string, unit: string, o: Partial<LabelValue> = {}): LabelValue => ({ name, offset: 0, length: 2, signed: false, factor: 0.001, add: 0, unit, ...o });
const prop = (id: string, kind: LabelProposal["kind"], values: LabelValue[] = [], name = "x"): LabelProposal => ({ id, name, kind, confidence: "medium", why: "", values });
const check = (p: LabelProposal, sweeps: ModuleSweep[]) => checkLabel(p, readsOf(sweeps).get(p.id)!);

test("values: big-endian, signed, offset and length inside the data", () => {
  assert.equal(valueAt("2E90", val("a", "V")), 11.92);
  assert.equal(valueAt("00FE", val("a", "°C", { length: 1, offset: 1, signed: true, factor: 1 })), -2);
  assert.equal(valueAt("7E", val("a", "V")), null);                                     // one byte, two asked
  assert.equal(valueAt("2E90", val("a", "V", { offset: -1 })), null);
});

test("a supply voltage that follows the car in two states is confirmed (real ESP bytes)", () => {
  const s = [sweep("engine off", OFF, { "21 2E": ["2E902E90"] }), sweep("idling", IDLE, { "21 2E": ["36743674", "36883688"] })];
  const c = check(prop("21 2E", "live", [val("Supply voltage", "V")]), s);
  assert.equal(c.status, "confirmed");
  assert.deepEqual(c.readings[0].at.map((a) => a.values), [[11.92, 11.92], [13.94, 13.96]]);
});

test("a supply voltage that does not follow is contradicted; one state only is never confirmed", () => {
  const stuck = [sweep("engine off", OFF, { "21 01": ["2EF4"] }), sweep("idling", IDLE, { "21 01": ["2EF4"] })];
  assert.equal(check(prop("21 01", "live", [val("Battery voltage", "V")]), stuck).status, "contradicted");
  const one = [sweep("engine off", OFF, { "21 01": ["2EF4", "2EF5"] })];
  assert.equal(check(prop("21 01", "live", [val("Battery voltage", "V")]), one).status, "consistent");
  const noRefs = [sweep("engine off", undefined, { "21 01": ["2EF4", "2EF5"] })];
  assert.equal(check(prop("21 01", "live", [val("Battery voltage", "V")]), noRefs).status, "consistent");
});

test("a sensor voltage or a desired speed is not judged as the car's supply or engine speed", () => {
  const s = [sweep("engine off", OFF, { "22 0105": ["1388"] }), sweep("idling", IDLE, { "22 0105": ["1388", "1389"] })];
  assert.equal(check(prop("22 0105", "live", [val("Pedal sensor supply voltage", "V")]), s).status, "consistent");
  const d = [sweep("engine off", OFF, { "22 0110": ["02BC"] }), sweep("idling", IDLE, { "22 0110": ["02BC", "02BD"] })];
  assert.equal(check(prop("22 0110", "live", [val("Desired engine speed", "rpm", { factor: 1 })]), d).status, "consistent");
});

test("engine speed: zero with the engine off and idle speed at idle", () => {
  const s = [sweep("engine off", OFF, { "22 0163": ["0000"] }), sweep("idling", IDLE, { "22 0163": ["0AA0", "0A90"] })];
  assert.equal(check(prop("22 0163", "live", [val("Engine speed", "rpm", { factor: 0.25 })]), s).status, "confirmed");
  assert.equal(check(prop("22 0163", "live", [val("Engine speed", "rpm", { factor: 1 })]), s).status, "contradicted");   // 2720 rpm
});

test("the kind must fit how the bytes behave; implausible or out-of-range values contradict", () => {
  const s = [sweep("engine off", OFF, { "1A 86": ["9069014600"], "21 05": ["AA", "AB"], "21 06": ["FF"] }), sweep("idling", IDLE, { "1A 86": ["9069014600"], "21 05": ["AC"], "21 06": ["FF"] })];
  assert.equal(check(prop("1A 86", "identification"), s).status, "consistent");
  assert.equal(check(prop("21 05", "coding"), s).status, "contradicted");
  assert.equal(check(prop("21 06", "live"), s).status, "unchecked");
  assert.equal(check(prop("21 05", "live", [val("Oil temperature", "°C", { length: 1, factor: 10 })]), s).status, "contradicted");
  assert.equal(check(prop("21 05", "live", [val("x", "V", { offset: 1 })]), s).status, "contradicted");
  assert.equal(check(prop("21 05", "unknown"), s).status, "unchecked");
});

test("identifiers the module never answered are dropped and counted, duplicates taken once", () => {
  const s = [sweep("engine off", OFF, { "21 05": ["AA"], "21 06": ["BB"] })];
  const r = checkLabels([prop("21 05", "coding"), prop("21 05", "live"), prop("21 99", "live")], s);
  assert.deepEqual(r.labels.map((l) => l.id), ["21 05"]);
  assert.deepEqual(r.invented, ["21 99"]);
  const sum = labelSummary({ at: "", model: "", sweeps: [], labels: r.labels, invented: r.invented, tokensIn: 0, tokensOut: 0 }, s);
  assert.deepEqual([sum.answered, sum.named, sum.missing], [2, 1, 1]);
});

test("code alone finds the fields that follow voltage and engine speed (real gearbox and ESP bytes)", () => {
  const s = [
    sweep("engine off", OFF, { "21 31": ["0000000000000000000000000000000000000000"], "21 2E": ["2E902E90"], "21 A0": ["AABB"] }),
    sweep("idling", IDLE, { "21 31": ["01890000028602AD000000000000000000000000", "01890000028602AC000000000000000000000000"], "21 2E": ["36743674", "36883688"], "21 A0": ["AABB"] }),
  ];
  const t = findTracks(readsOf(s));
  assert.deepEqual(t.filter((x) => x.quantity === "engine speed").map((x) => [x.id, x.offset, x.factor]), [["21 31", 6, 1]]);   // 0x2AD = 685
  assert.deepEqual(t.filter((x) => x.quantity === "supply voltage").map((x) => [x.id, x.offset, x.factor]), [["21 2E", 0, 0.001], ["21 2E", 2, 0.001]]);
  const l = luckOfTracks(readsOf(s));
  assert.ok(l.volts < 1 && l.rpm < 1, JSON.stringify(l));
});

test("no tracks from one state, without readings, or from bytes that never change", () => {
  assert.equal(findTracks(readsOf([sweep("engine off", OFF, { "21 2E": ["2E902E90", "2E912E91"] })])).length, 0);
  assert.equal(findTracks(readsOf([sweep("engine off", undefined, { "21 2E": ["2E902E90"] }), sweep("idling", undefined, { "21 2E": ["36743674"] })])).length, 0);
  assert.equal(findTracks(readsOf([sweep("engine off", OFF, { "21 2E": ["2E90"] }), sweep("idling", IDLE, { "21 2E": ["2E90"] })])).length, 0);
});

test("a turbine speed near the engine speed is not confirmed as engine speed (real gearbox 21 38)", () => {
  const s = [sweep("engine off", OFF, { "21 38": ["0000"] }), sweep("idling", IDLE, { "21 38": ["0284", "027E"] })];   // 644 / 638 at 669–689 rpm
  assert.equal(check(prop("21 38", "live", [val("Engine speed", "rpm", { factor: 1 })]), s).status, "consistent");
});

test("a wrong number is rejected by itself; what holds in the same block stays (real ECM 22 0163)", () => {
  const s = [sweep("engine off", OFF, { "22 0163": ["00000000FFFF"] }), sweep("idling", IDLE, { "22 0163": ["00000537FFFF", "0000054CFFFF"] })];
  const c = check(prop("22 0163", "live", [val("Engine speed", "rpm", { offset: 2, factor: 0.5 }), val("Charge air temperature", "°C", { offset: 4, factor: 0.05 })]), s);
  assert.equal(c.status, "confirmed");
  assert.deepEqual(c.readings.map((r) => r.status), ["confirmed", "contradicted"]);
  assert.ok(c.notes.some((n) => /rejected/.test(n)));
});

test("the car's state rejects what cannot be (real gearbox candidates, cold van at 21 °C)", () => {
  const cold = { rpm: [0, 0] as [number, number], coolant: [21, 21] as [number, number] };
  const idle = { rpm: [669, 689] as [number, number], kmh: [0, 0] as [number, number] };
  assert.equal(stateCheck("Transmission oil temperature", "°C", [{ values: [31, 31], refs: cold }])?.verdict, undefined);        // 10 off: neither
  assert.equal(stateCheck("Transmission fluid temperature, variant 3", "°C", [{ values: [0, 0], refs: cold }])?.verdict, "contradicted");
  assert.equal(stateCheck("Transmission fluid temperature, variant 1", "fahrenheit", [{ values: [69.8], refs: cold }])?.verdict, "agrees");
  assert.equal(stateCheck("Current gear", "scalar", [{ values: [221], refs: idle }])?.verdict, "contradicted");
  assert.equal(stateCheck("Current gear", "scalar", [{ values: [0], refs: idle }]), null);
  assert.equal(stateCheck("Output shaft speed", "rpm", [{ values: [646], refs: idle }])?.verdict, "contradicted");
  assert.equal(stateCheck("Turbine speed", "rpm", [{ values: [646], refs: idle }]), null);
  assert.equal(stateCheck("Turbine speed", "rpm", [{ values: [400], refs: cold }])?.verdict, "contradicted");
  assert.equal(stateCheck("Desired oil temperature", "°C", [{ values: [90], refs: cold }]), null);             // a setpoint is not the state
  assert.equal(stateCheck("Coolant temperature", "°C", [{ values: [88], refs: { rpm: [0, 0], coolant: [86, 86] } }]), null);   // warm engine: no cold-engine rule
});
