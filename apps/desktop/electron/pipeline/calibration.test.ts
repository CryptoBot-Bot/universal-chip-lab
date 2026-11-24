import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExplorerResult } from "../resolver/moduleExplorer";
import { benchModules, labelsMatch, scoreModule, summarise, type TruthModule, type TruthVehicle } from "./calibration";

test("label matching: same quantity in other words, not a different one", () => {
  assert.ok(labelsMatch("Engine speed", "Engine RPM"));
  assert.ok(labelsMatch("Coolant temperature", "Engine coolant temp (°C)"));
  assert.ok(labelsMatch("Battery voltage", "Supply voltage (battery)"));
  assert.ok(!labelsMatch("Coolant temperature", "Throttle position"));
  assert.ok(!labelsMatch("Vehicle speed", ""));
});

const truth: TruthModule = {
  req: "7E0", resp: "7E8", name: "Engine Control Module (ECM)", category: "powertrain", template: "ecm",
  part: "1", supplier: "x", sw: "", hw: "", serial: "", system: "", sessions: ["01", "02", "03"], security: true, obd: true,
  identification: ["F190", "F18C"],
  data: [{ did: "0100", label: "Engine speed", decode: "" }, { did: "0101", label: "Coolant temperature", decode: "" }, { did: "0102", label: "Intake air temperature", decode: "" }],
  coding: [], io: [], routines: [], obd_pids: [], dtcs: ["P0300", "P0171"],
};

const result = (over: Partial<ExplorerResult>): ExplorerResult => ({
  summary: "", identity: "", services: [], capabilities: [], dtcs: [], confidence: "high", verification: "", outcome: "concluded",
  tokensIn: 100000, tokensOut: 10000, steps: 12, newFindings: [], ...over,
});

test("scoring: found, labelled, invented, sessions, codes, cost", () => {
  const s = scoreModule(truth, result({
    identification: [{ id: "22 F190", label: "VIN", value: "x" }],
    liveData: [{ id: "22 0100", label: "Engine RPM" }, { id: "0x0101", label: "Throttle position" }, { id: "22 0777", label: "made up" }],
    sessions: [{ id: "01", label: "default" }, { id: "0x03", label: "extended" }],
    dtcs: [{ code: "P0300-00", desc: "" }],
  }), { model: "claude-opus-5-5", run: 1, refused: 0, seconds: 60 });
  assert.deepEqual(s.data, { total: 3, found: 2, labelOk: 1 });
  assert.deepEqual(s.identification, { total: 2, found: 1 });
  assert.deepEqual(s.sessions, { total: 2, found: 2 });   // programming (02) is not expected
  assert.deepEqual(s.dtcs, { total: 2, found: 1 });
  assert.deepEqual(s.invented, ["22 0777"]);
  assert.equal(s.costUsd, (100000 * 4 + 10000 * 20) / 1e6);
});

test("sessions in any spelling; readable coding values are not inventions", async () => {
  const { sessionOf } = await import("./calibration");
  assert.equal(sessionOf("01"), "01");
  assert.equal(sessionOf("0x03"), "03");
  assert.equal(sessionOf("10 03"), "03");
  assert.equal(sessionOf("1003"), "03");
  assert.equal(sessionOf("Extended (03)"), "03");
  const t = { ...truth, coding: [{ did: "0200", label: "Rev limiter" }] };
  const s = scoreModule(t, result({ liveData: [{ id: "22 0200", label: "Rev limiter (coding)" }], sessions: [{ id: "10 03", label: "extended" }] }),
    { model: "m", run: 1, refused: 1, refusedRequests: ["2702"], seconds: 1 });
  assert.deepEqual(s.coding, { total: 1, found: 1 });
  assert.deepEqual(s.invented, []);
  assert.equal(s.sessions.found, 1);
  assert.deepEqual(s.refusedRequests, ["2702"]);
});

test("a failed run scores zero, and the summary averages per model", () => {
  const failed = scoreModule(truth, null, { model: "m", run: 1, refused: 0, seconds: 1, error: "boom" });
  assert.equal(failed.outcome, "failed");
  const [sum] = summarise([failed, scoreModule(truth, result({ liveData: [{ id: "22 0100", label: "Engine speed" }] }), { model: "m", run: 2, refused: 2, seconds: 3 })]);
  assert.equal(sum.runs, 2);
  assert.equal(sum.failed, 1);
  assert.equal(sum.dataRecall, 1 / 6);
  assert.equal(sum.refused, 2);
});

test("the bench never maps airbag or immobiliser modules", () => {
  const v: TruthVehicle = { vehicle: "x", name: "2020 Toyota Corolla", vin: "", modules: [
    truth, { ...truth, name: "Airbag Sensor Assembly (SRS)", category: "safety", template: "srs" },
    { ...truth, name: "Certification ECU (Smart Key)", category: "body", template: "immo" },
  ] };
  assert.deepEqual(benchModules(v).map((m) => m.template), ["ecm"]);
});
