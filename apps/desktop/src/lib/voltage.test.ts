import assert from "node:assert/strict";
import { test } from "node:test";

import { voltageView } from "./voltage";

test("what the number means: battery with the engine off, charging with it running", () => {
  const s = (v: number, rpm: number | null) => voltageView(v, rpm).level;
  assert.equal(s(12.6, 0), "ok"); assert.equal(s(12.2, 0), "warn"); assert.equal(s(11.98, 0), "low");
  assert.equal(s(14.2, 800), "ok"); assert.equal(s(12.8, 800), "warn"); assert.equal(s(15.6, 800), "low");
  assert.equal(s(12.5, null), "none"); assert.equal(s(24.6, 0), "none");   // unknown engine state, 24 V vehicle: no verdict
});
