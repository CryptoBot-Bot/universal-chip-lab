/** The completeness sweep against a fake module: what it sends, what it keeps. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRequest } from "@ecu/vehicle-db";
import type { VehicleModule, VehicleProfile } from "@ecu/vehicle-db";

import { sweepModule, sweepTargets } from "./sweepPipeline";

function fakeEcm() {
  const sent: string[] = [];
  let reads0163 = 0;
  let session = "01";
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const b = JSON.parse(init?.body ?? "{}") as { tx: string; requests: string[] };
    const results = b.requests.map((q0) => {
      const q = q0.toUpperCase();
      sent.push(q);
      if (q.startsWith("10")) { session = q.slice(2); return { request: q, response: `50${q.slice(2)}` }; }
      if (session !== "03") return { request: q, response: "7F227F", negative: true, nrc: 0x7f };
      if (q === "220163") { reads0163 += 1; return { request: q, response: `620163${reads0163 === 1 ? "0BB8" : "0BC2"}` }; }  // live: changes
      if (q === "220200") return { request: q, response: "62020001" };                                                   // fixed
      if (q === "22F18C") return { request: q, response: `62F18C${Buffer.from("SN123456").toString("hex")}` };
      if (q === "220300") return { request: q, response: "7F2233", negative: true, nrc: 0x33 };                          // security-gated
      return { request: q, response: "7F2231", negative: true, nrc: 0x31 };
    });
    return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return sent;
}

const mod = (id: string, label: string, category: string, req: string, resp: string, protocol = "uds") =>
  ({ id, label, category, bus: "hs-can", location: "engine", addressing: { request: req, response: resp }, protocol }) as unknown as VehicleModule;
const profile = { id: "t", year: 2015, make: "Mercedes-Benz", model: "Sprinter", bodyType: "van", buses: [], capabilities: [],
  provenance: { source: "user", confidence: 1, createdAt: "", updatedAt: "" },
  modules: [mod("ecm", "CDI Engine Control Unit (ECM)", "powertrain", "7E0", "7E8"), mod("srs", "SRS — Airbag Control Unit", "safety", "784", "785")],
} as unknown as VehicleProfile;

test("airbag / immobiliser modules are never sweep targets", () => {
  assert.deepEqual(sweepTargets(profile).map((m) => m.id), ["ecm"]);
});

test("sweep: extended session, every identifier, a second read, back to default", async () => {
  const sent = fakeEcm();
  const sw = await sweepModule({ host: "fake:8080", iface: "vcan0", profile, condition: "engine off" }, profile.modules[0], 0, 1);
  for (const q of sent) assert.ok(checkRequest(q).ok, q);
  assert.equal(sent[0], "1003");
  assert.equal(sent[sent.length - 1], "1001");
  assert.equal(sw.counts.asked, 1280);
  const by = Object.fromEntries(sw.hits.map((h) => [h.id, h]));
  assert.equal(by["22 0163"].moving, true);
  assert.equal(by["22 0200"].moving, false);
  assert.equal(by["22 F18C"].ascii, "SN123456");
  assert.equal(by["22 0300"].gated, true);
  assert.equal(sw.counts.answered, 3);
  assert.equal(sw.condition, "engine off");
});

test("a protected module handed in directly is refused", async () => {
  fakeEcm();
  await assert.rejects(sweepModule({ host: "fake:8080", iface: "vcan0", profile, condition: "x" }, profile.modules[1], 0, 1), /never swept/);
});
