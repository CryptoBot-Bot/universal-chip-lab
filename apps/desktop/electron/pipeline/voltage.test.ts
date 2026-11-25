import assert from "node:assert/strict";
import { test } from "node:test";

import { onBus, quickRead, touchesBus } from "./busUse";
import { decodeRpm, decodeVolts, readVoltage, voltageSources } from "./voltage";
import { piPost } from "./vehiclePipeline";

const MODS = [
  { id: "ecm", req: "7E0", resp: "7E8" }, { id: "tcm", req: "7E1", resp: "7E9" }, { id: "def", req: "7E4", resp: "7EC" },
  { id: "srs", req: "784", resp: "785" }, { id: "ezs", req: "662", resp: "4E2" },
];

/** A fake device: answers 01 42 / 01 0C, counts recorder lines, records every request. */
function fakePi(o: { up?: boolean; silent?: boolean; recorderMoves?: boolean } = {}) {
  const sent: string[] = []; let lines = 10;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const p = new URL(url).pathname;
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { "Content-Type": "application/json" } });
    if (p === "/api/status") return json({ ifaces: [{ name: "can0", up: o.up ?? true }] });
    if (p === "/api/rec/status") { if (o.recorderMoves) lines += 5; return json({ recording: true, session: { id: "s", bytes: 1, lines_this_run: lines } }); }
    if (p === "/api/isotp/seq") {
      const b = JSON.parse(init?.body ?? "{}") as { tx: string; requests: string[] };
      const v: Record<string, string> = { "7E0": "41422ECC", "7E1": "41422EF9", "7E4": "41422EF4" };
      return json({ ok: true, results: b.requests.map((q) => { sent.push(`${b.tx}:${q}`); return o.silent ? { request: q, error: "timeout" } : { request: q, response: q === "010C" ? "410C0000" : v[b.tx] }; }) });
    }
    return json({});
  }) as typeof fetch;
  return sent;
}

test("volts and rpm decode only from their own answers (real Sprinter values)", () => {
  assert.equal(decodeVolts("41422ECC"), 11.98);
  assert.equal(decodeVolts("41 42 2E F9"), 12.025);
  assert.equal(decodeRpm("410C0C80"), 800);
  for (const bad of ["62F190574433", "7F0112", "", null, "410C0C80", "4142", "41420000"]) assert.equal(decodeVolts(bad), null);
  assert.equal(decodeRpm("41422ECC"), null);          // another request's answer is never taken for rpm
});

test("only the standard OBD addresses are asked — never airbag, immobiliser or body modules", async () => {
  assert.deepEqual(voltageSources(MODS).map((s) => s.id), ["ecm", "tcm", "def"]);
  const sent = fakePi();
  const r = await readVoltage({ host: "t1:8080", iface: "can0", modules: MODS });
  assert.equal(r.state, "ok");
  assert.equal(r.volts, 11.98);
  assert.equal(r.rpm, 0);
  assert.deepEqual(r.modules, [{ id: "ecm", volts: 11.98 }, { id: "tcm", volts: 12.025 }, { id: "def", volts: 12.02 }]);
  assert.deepEqual(sent, ["7E0:010C", "7E0:0142", "7E1:0142", "7E4:0142"]);
});

test("nothing is sent when the bus is down, or while anything else uses it", async () => {
  let sent = fakePi({ up: false });
  assert.equal((await readVoltage({ host: "t2:8080", iface: "can0" })).state, "down");
  assert.equal(sent.length, 0);
  sent = fakePi({ recorderMoves: true });             // a scan from the command line
  assert.equal((await readVoltage({ host: "t3:8080", iface: "can0" })).state, "busy");
  assert.equal(sent.length, 0);
  sent = fakePi();                                    // a scan from this process a moment ago
  await piPost("t4:8080", "/api/isotp/seq", { iface: "can0", tx: "726", rx: "4E6", requests: ["1A87"] });
  assert.equal((await readVoltage({ host: "t4:8080", iface: "can0" })).state, "busy");
  assert.deepEqual(sent, ["726:1A87"]);
});

test("a silent engine module: the other modules are not asked", async () => {
  const sent = fakePi({ silent: true });
  assert.equal((await readVoltage({ host: "t5:8080", iface: "can0", modules: MODS })).state, "silent");
  assert.deepEqual(sent, ["7E0:010C", "7E0:0142"]);
});

test("a scan that starts during the voltage read waits for it", async () => {
  const order: string[] = [];
  const slow = quickRead("t6:8080", 0, async () => { order.push("volts start"); await new Promise((r) => setTimeout(r, 60)); order.push("volts end"); });
  const scan = onBus("t6:8080", "/api/isotp/seq", async () => { order.push("scan"); });
  await Promise.all([slow, scan]);
  assert.deepEqual(order, ["volts start", "volts end", "scan"]);
  assert.ok(touchesBus("/api/vin?iface=can0") && !touchesBus("/api/status") && !touchesBus("/api/scan/sweep/status"));
});
