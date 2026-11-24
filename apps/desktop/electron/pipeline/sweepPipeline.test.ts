/** The completeness sweep against a fake module: what it sends, what it keeps. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRequest } from "@ecu/vehicle-db";
import type { VehicleModule, VehicleProfile } from "@ecu/vehicle-db";

import { provenSessions, sweepModule, sweepTargets } from "./sweepPipeline";

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

/** A KWP module that answers local-ID reads only in one session; records which sessions were asked. */
function fakeKwp(openSession: string) {
  const sent: string[] = [];
  let session = "01";
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const b = JSON.parse(init?.body ?? "{}") as { requests: string[] };
    const results = b.requests.map((q0) => {
      const q = q0.toUpperCase();
      sent.push(q);
      if (q.startsWith("10")) { const ok = q.slice(2) === openSession || q === "1001"; session = ok && q !== "1001" ? openSession : session; return ok ? { request: q, response: `50${q.slice(2)}` } : { request: q, response: "7F1012", negative: true, nrc: 0x12 }; }
      if (session === openSession && q === "2105") return { request: q, response: "6105AA" };
      return { request: q, response: "7F2122", negative: true, nrc: 0x22 };
    });
    return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return sent;
}
const kwpMod = (over: Record<string, unknown>) => ({ ...mod("esp", "Electronic Stability Program", "chassis", "726", "4E6", "kwp2000"), ...over }) as unknown as VehicleModule;
const run = (m: VehicleModule) => sweepModule({ host: "fake:8080", iface: "vcan0", profile: { ...profile, modules: [m] } as VehicleProfile, condition: "x" }, m, 0, 1);

test("sessions proven by an earlier real map come first; text like 'default' proves nothing", () => {
  const explored = { liveData: [{ id: "21 05", label: "x", session: "81 (also 92)" }], identification: [], sessions: [{ id: "default", label: "" }, { id: "85", label: "programming" }] };
  assert.deepEqual(provenSessions({ explored } as never), ["81", "92"]);   // 85 (programming) is never a candidate
});

test("a chassis module (brakes / stability) never gets an unproven session", async () => {
  const sent = fakeKwp("92");
  await run(kwpMod({}));
  assert.ok(!sent.some((q) => q.startsWith("10") && q !== "1001"), sent.filter((q) => q.startsWith("10")).join(","));
});

test("a proven session is used, also on a chassis module", async () => {
  const sent = fakeKwp("92");
  const m = kwpMod({ explored: { liveData: [{ id: "21 05", label: "x", session: "92" }], identification: [], sessions: [] } });
  const sw = await run(m);
  assert.equal(sent[0], "1092");
  assert.ok(sw.hits.some((h) => h.id === "21 05" && h.session === "92"));
  assert.equal(sent[sent.length - 1], "1081");
});

test("another module may try the standard KWP sessions when the default gives nothing", async () => {
  const sent = fakeKwp("92");
  await run(mod("body", "Body module", "body", "72E", "4EE", "kwp2000") as VehicleModule);
  assert.ok(sent.includes("1092"));
  for (const q of sent) assert.ok(checkRequest(q).ok, q);      // never standby (89) or development (86)
});
