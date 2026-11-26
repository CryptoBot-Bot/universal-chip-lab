/** The completeness sweep against a fake module: what it sends, what it keeps. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRequest } from "@ecu/vehicle-db";
import type { VehicleModule, VehicleProfile } from "@ecu/vehicle-db";

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { saveStoredVehicleProfile } from "@ecu/vehicle-db/vehicleStore";

import { conditionProblem, normaliseCondition, provenSessions, readObdSupport, sweepAndSave, sweepModule, sweepTargets } from "./sweepPipeline";

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
  const sw = await sweepModule({ host: "fake:8080", iface: "vcan0", profile, condition: "engine off", refs: false }, profile.modules[0], 0, 1);
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
const run = (m: VehicleModule) => sweepModule({ host: "fake:8080", iface: "vcan0", profile: { ...profile, modules: [m] } as VehicleProfile, condition: "x", refs: false }, m, 0, 1);

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

test("the car's own readings are kept beside the sweep, and long data is compared whole", async () => {
  let reads = 0; let rpm = 0x0aa0;
  const long = "AB".repeat(300);
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const b = JSON.parse(init?.body ?? "{}") as { tx: string; requests: string[] };
    const results = b.requests.map((q) => {
      if (b.tx === "7E0") { const a: Record<string, string> = { "010C": `410C${rpm.toString(16).padStart(4, "0")}`, "010D": "410D00", "0142": "414236D8", "0105": "41053D" }; if (q === "010C") rpm += 16; return { request: q, response: a[q] }; }
      if (q === "2110") { reads += 1; return { request: q, response: `6110${long}${reads === 1 ? "01" : "02"}` }; }   // differs only at byte 300
      return { request: q, response: "7F2112", negative: true, nrc: 0x12 };
    });
    return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const m = { ...mod("body", "Body module", "body", "72E", "4EE", "kwp2000") } as VehicleModule;
  const sw = await sweepModule({ host: "fake:8080", iface: "can0", profile: { ...profile, modules: [m] } as VehicleProfile, condition: "idling" }, m, 0, 1);
  assert.deepEqual(sw.refs, { rpm: [680, 684], kmh: [0, 0], volts: [14.04, 14.04], coolant: [21, 21] });
  const h = sw.hits.find((x) => x.id === "21 10")!;
  assert.equal(h.bytes.length, 512);
  assert.equal(h.moving, true);
});

test("an OBD-type module is asked which standard values it supports (real Sprinter engine masks)", async () => {
  const masks: Record<string, string> = { "0100": "4100BE3FA813", "0120": "41209005B015", "0140": "4140FED00400", "0160": "416001800000" };
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const b = JSON.parse(init?.body ?? "{}") as { requests: string[] };
    return new Response(JSON.stringify({ ok: true, results: b.requests.map((q) => (masks[q] ? { request: q, response: masks[q] } : { request: q, response: "7F0112", negative: true, nrc: 0x12 })) }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const pids = await readObdSupport({ host: "fake:8080", iface: "can0" }, "7E0", "7E8");
  assert.ok(pids.includes("0C") && pids.includes("42") && pids.includes("05"));
  assert.ok(!pids.includes("20") && !pids.includes("40"));          // "more" bits are not values
  assert.ok(!pids.some((p) => parseInt(p, 16) > 0x60 + 32));
});

test("whatever the words, sweeps are filed under the two states on file", () => {
  for (const w of ["ignition on, engine off", "ignition on", "engine off", "Key on engine off", ""]) assert.equal(normaliseCondition(w), "engine off", w);
  for (const w of ["engine idling", "idling", "Idle", "engine running"]) assert.equal(normaliseCondition(w), "idling", w);
});

test("the car's state is checked: engine, standstill, voltage", () => {
  const off = { rpm: 0, kmh: 0, volts: 12.4 }, idle = { rpm: 680, kmh: 0, volts: 14.0 };
  assert.equal(conditionProblem("engine off", off), null);
  assert.equal(conditionProblem("idling", idle), null);
  assert.match(conditionProblem("engine off", idle)!, /engine is running/);
  assert.match(conditionProblem("idling", off)!, /not running/);
  assert.match(conditionProblem("idling", { ...idle, kmh: 12 })!, /moving/);
  assert.match(conditionProblem("engine off", { ...off, volts: 11.5 })!, /charger/);
  assert.match(conditionProblem("engine off", { rpm: null, kmh: null, volts: null })!, /did not answer/);
});

test("a sweep refuses to start on a car in the wrong state, and sends nothing to the module", async () => {
  const sent: string[] = [];
  let rpm = "410C0AA0";                                        // 680 rpm
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const b = JSON.parse(init?.body ?? "{}") as { tx: string; requests: string[] };
    const a: Record<string, string> = { "010C": rpm, "010D": "410D00", "0142": "414236D8" };
    return new Response(JSON.stringify({ ok: true, results: b.requests.map((q) => { if (b.tx !== "7E0" || !a[q]) sent.push(`${b.tx}:${q}`); return a[q] && b.tx === "7E0" ? { request: q, response: a[q] } : { request: q, response: "7F2112", negative: true, nrc: 0x12 }; }) }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const dir = await mkdtemp(path.join(os.tmpdir(), "ual-guard-"));
  const p = { ...profile, buses: [{ id: "hs-can", label: "HS-CAN", protocol: "CAN", bitrate: 500000 }], modules: [mod("body", "Body module", "body", "72E", "4EE", "kwp2000")], provenance: { source: "user", confidence: 1, createdAt: "2026-11-26T00:00:00Z", updatedAt: "2026-11-26T00:00:00Z" } } as unknown as VehicleProfile;
  await saveStoredVehicleProfile(dir, p, "2026-11-26T00:00:00Z");
  await assert.rejects(sweepAndSave(dir, { host: "fake:8080", iface: "can0", profile: p, condition: "ignition on, engine off" }), /engine is running \(680 rpm\).*Nothing was swept/);
  assert.equal(sent.length, 0);
  rpm = "410C0000";
  const r = await sweepAndSave(dir, { host: "fake:8080", iface: "can0", profile: p, condition: "ignition on, engine off" });
  assert.equal(r.sweeps.body.condition, "engine off");
  assert.ok(sent.length > 0);
});
