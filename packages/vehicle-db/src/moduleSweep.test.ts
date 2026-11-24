import assert from "node:assert/strict";
import { test } from "node:test";

import { addSweep, coverageOf, dataOf, normaliseId, rangeRequests, sweepPlan, type ModuleSweep } from "./moduleSweep.js";
import { checkRequest } from "./readPolicy.js";

test("plans: UDS measurement + identification blocks, OBD mirror on engines, KWP local ids", () => {
  const ecm = sweepPlan("uds", "powertrain").flatMap(rangeRequests);
  assert.equal(ecm.length, 768 + 256 + 256);
  assert.equal(ecm[0], "220100");
  assert.ok(ecm.includes("22F18C") && ecm.includes("22F40C"));
  assert.equal(sweepPlan("uds", "body").flatMap(rangeRequests).length, 768 + 256);
  assert.equal(sweepPlan("uds", "body", { wide: true }).flatMap(rangeRequests).length, 768 + 256 + 3072);
  const kwp = sweepPlan("kwp2000", "body").flatMap(rangeRequests);
  assert.equal(kwp.length, 256 + 32);
  assert.ok(kwp.includes("2100") && kwp.includes("1A9F"));
  // every request a sweep can plan is a read the policy allows
  for (const q of [...ecm, ...kwp, ...sweepPlan("uds", "body", { wide: true }).flatMap(rangeRequests)]) assert.ok(checkRequest(q).ok, q);
});

test("dataOf: only a positive answer to this exact request", () => {
  assert.equal(dataOf("220163", "620163ABCD"), "ABCD");
  assert.equal(dataOf("2105", "6105FF00"), "FF00");
  assert.equal(dataOf("1A87", "5A87313233"), "313233");
  assert.equal(dataOf("220163", "7F2231"), null);
  assert.equal(dataOf("220163", "620164ABCD"), null);
  assert.equal(dataOf("220163", undefined), null);
});

test("normaliseId reads the map's many spellings, and skips OBD service/parameter pairs", () => {
  assert.equal(normaliseId("22 0163"), "22 0163");
  assert.equal(normaliseId("0x0163"), "22 0163");
  assert.equal(normaliseId("DID F190"), "22 F190");
  assert.equal(normaliseId("21 05", "kwp2000"), "21 05");
  assert.equal(normaliseId("1A 87"), "1A 87");
  assert.equal(normaliseId("09 02"), null);
  assert.equal(normaliseId("01 0C"), null);
});

const sweep = (condition: string, hits: ModuleSweep["hits"]): ModuleSweep => ({
  at: "2026-11-24T00:00:00Z", condition, protocol: "uds", sessions: [], ranges: [], hits,
  counts: { asked: 0, answered: hits.length, moving: hits.filter((h) => h.moving).length, gated: 0, ms: 0 },
});

test("coverage: known / answered, moving values the map misses, claims no sweep saw", () => {
  const m = {
    protocol: "uds" as const,
    sweeps: [
      sweep("engine off", [
        { id: "22 0100", session: "03", bytes: "0000", moving: false },
        { id: "22 0101", session: "03", bytes: "5A", moving: false },
        { id: "22 0102", session: "03", bytes: "10", moving: true },
        { id: "22 F190", session: "03", bytes: "57", moving: false },
      ]),
      // the same id with other bytes at idle: it moves between conditions
      sweep("idling", [{ id: "22 0100", session: "03", bytes: "0C80", moving: false }]),
    ],
    explored: {
      runCount: 1, lastMappedAt: "", services: [], dtcs: [], operations: [],
      identification: [{ id: "22 F190", label: "VIN", value: "x" }],
      liveData: [{ id: "22 0102", label: "temp" }, { id: "22 0999", label: "invented" }],
    },
  };
  const c = coverageOf(m as never);
  assert.equal(c.answered, 4);
  assert.equal(c.known, 2);
  assert.equal(c.ratio, 0.5);
  assert.equal(c.moving, 2);                  // 0102 moved in a read pair, 0100 between conditions
  assert.equal(c.movingKnown, 1);
  assert.deepEqual(c.missedLive, ["22 0100"]);
  assert.deepEqual(c.missed.sort(), ["22 0100", "22 0101"]);
  assert.deepEqual(c.unseen, ["22 0999"]);
});

test("one sweep kept per condition", () => {
  const a = sweep("engine off", []), b = sweep("idling", []), c = { ...sweep("engine off", []), at: "later" };
  const list = addSweep(addSweep(addSweep(undefined, a), b), c);
  assert.equal(list.length, 2);
  assert.equal(list.find((x) => x.condition === "engine off")?.at, "later");
});
