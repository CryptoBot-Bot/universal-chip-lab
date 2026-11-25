import assert from "node:assert/strict";
import { test } from "node:test";

import { ageText, voltageView } from "./voltage";

test("what the number means: battery with the engine off, charging with it running", () => {
  const s = (v: number, rpm: number | null) => voltageView(v, rpm).level;
  assert.equal(s(12.6, 0), "ok"); assert.equal(s(12.2, 0), "warn"); assert.equal(s(11.98, 0), "low");
  assert.equal(s(14.2, 800), "ok"); assert.equal(s(12.8, 800), "warn"); assert.equal(s(15.6, 800), "low");
  assert.equal(s(12.5, null), "none"); assert.equal(s(24.6, 0), "none");   // unknown engine state, 24 V vehicle: no verdict
});

test("a reading that is not refreshed says how old it is", () => {
  const at = "2026-11-25T02:26:00.000Z", t0 = Date.parse(at);
  assert.equal(ageText(at, t0 + 10_000), "");
  assert.equal(ageText(at, t0 + 40_000), "read 40 s ago");
  assert.equal(ageText(at, t0 + 11 * 60_000), "read 11 min ago");   // the real case: engine off, the chip still said "charging"
});
