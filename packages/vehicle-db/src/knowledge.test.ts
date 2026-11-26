import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeSignal, dtcMeaning, isMakerSpecificDtc, signalsFor, testSignal } from "./knowledge.js";
import type { SignalDef } from "./knowledge.js";
import type { ModuleSweep } from "./moduleSweep.js";

const def = (o: Partial<SignalDef>): SignalDef => ({ key: "k", source: "s", trust: "community", tx: "7E0", service: "22", pid: "0163", bit: 0, bits: 16, mul: 1, div: 1, add: 0, unit: "unknown", name: "x", ...o });

test("decoding follows OBDb's rules, checked on the van's own answers", () => {
  assert.equal(decodeSignal(def({ bits: 16, div: 4 }), "0AA0"), 680);                     // 01 0C engine speed
  assert.equal(decodeSignal(def({ bits: 16, div: 1000 }), "2ECC"), 11.98);                 // 01 42 module voltage
  assert.equal(decodeSignal(def({ bits: 8, add: -40 }), "3D"), 21);                        // 01 05 coolant
  assert.equal(decodeSignal(def({ bit: 48, bits: 16, div: 10, add: -273.1 }), "0000000000000B7C"), 20.9);   // E-Class boost air temperature: 2940 / 10 − 273.1
  assert.equal(decodeSignal(def({ bit: 1, bits: 7 }), "83"), 3);                           // bits inside a byte
  assert.equal(decodeSignal(def({ bit: 0, bits: 1, map: { "1": "on", "0": "off" } }), "80"), "on");
  assert.equal(decodeSignal(def({ bits: 16, signed: true }), "FFFE"), -2);
  assert.equal(decodeSignal(def({ bit: 288, bits: 16 }), "00".repeat(20)), null);          // beyond the data
  assert.equal(decodeSignal(def({ bits: 16, nullmax: 65535 }), "FFFF"), null);
});

test("signals by how closely they match the vehicle", () => {
  const kb = { signals: [
    def({ key: "std" }), def({ key: "make", vehicle: { make: "Mercedes-Benz" } }),
    def({ key: "eclass", vehicle: { make: "Mercedes-Benz", model: "E-Class", years: [[2010, 2016]] } }),
    def({ key: "sprinter", vehicle: { make: "Mercedes-Benz", model: "Sprinter", years: [[2007, 2018]] } }),
    def({ key: "old-sprinter", vehicle: { make: "Mercedes-Benz", model: "Sprinter", years: [[1995, 2006]] } }),
    def({ key: "ford", vehicle: { make: "Ford", model: "Transit" } }),
  ] };
  const r = signalsFor(kb, { make: "Mercedes-Benz", model: "Sprinter", year: 2015 });
  assert.deepEqual([r.standard, r.make, r.model, r.otherModels].map((l) => l.map((s) => s.key)), [["std"], ["make"], ["sprinter"], ["eclass", "old-sprinter"]]);
});

test("fault codes: open ones get a meaning, maker ones are said to be the maker's", () => {
  const kb = { dtcs: [{ code: "P2610", title: "ECM/PCM Internal Engine Off Timer Performance", source: "obdex" }] };
  assert.equal(dtcMeaning(kb, "P2610-00").title, "ECM/PCM Internal Engine Off Timer Performance");
  assert.equal(dtcMeaning(kb, "P20E8").title, undefined);
  assert.equal(dtcMeaning(kb, "P20E8").makerSpecific, false);
  for (const c of ["B170B", "P1234", "U1100", "C2100", "P3123"]) assert.ok(isMakerSpecificDtc(c), c);
  for (const c of ["P0420", "P2610", "U0100", "B0001", "P3456"]) assert.ok(!isMakerSpecificDtc(c), c);
});

const sweep = (condition: string, refs: ModuleSweep["refs"], hits: Record<string, [string, string?]>): ModuleSweep => ({
  at: "", condition, protocol: "uds", sessions: [], ranges: [], counts: { asked: 0, answered: 0, moving: 0, gated: 0, ms: 0 }, refs,
  hits: Object.entries(hits).map(([id, [a, b]]) => ({ id, session: "03", bytes: a, moving: !!b, ...(b ? { again: b } : {}) })),
});
const ecm = { addressing: { request: "7E0" }, sweeps: [
  sweep("engine off", { volts: [12.0, 12.04], rpm: [0, 0] }, { "22 0168": ["0000000000000000000000000259"], "22 0163": ["0000000000000B7C"] }),
  sweep("idling", { volts: [13.96, 14.06], rpm: [669.5, 688.5] }, { "22 0168": ["00000000000000000000000002BE", "00000000000000000000000002BC"], "22 0163": ["0000000000000B65", "0000000000000B62"] }),
] };

test("a borrowed definition is tested on this car: proven, fits, or does not apply", () => {
  const volts = def({ pid: "0168", bit: 96, bits: 16, mul: 2, div: 100, unit: "volts", name: "Battery voltage", min: 0, max: 30 });
  const v = testSignal(volts, ecm);
  assert.equal(v.verdict, "proven", v.note);
  assert.equal(testSignal(def({ pid: "0163", bit: 48, bits: 16, div: 10, add: -273.1, unit: "celsius", name: "Boost air temperature", min: -273, max: 6280 }), ecm).verdict, "fits");
  assert.equal(testSignal(def({ pid: "016B", bit: 288 }), ecm).verdict, "no-answer");
  assert.equal(testSignal(def({ pid: "0163", bit: 288, bits: 16 }), ecm).verdict, "too-short");
  assert.equal(testSignal(def({ pid: "0168", bit: 96, bits: 16, unit: "volts", name: "Battery voltage", max: 30 }), ecm).verdict, "out-of-range");
  assert.equal(testSignal(volts, { addressing: { request: "7E0" } }).verdict, "not-swept");
});
