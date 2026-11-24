/**
 * The identity reader against a fake car (the device's HTTP API answered in-process):
 * what it sends, to whom, and what it files. The safety rules are the point here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { VehicleProfile } from "@ecu/vehicle-db";

import { identifyCar } from "./identityPipeline";

const ascii = (t: string) => Buffer.from(t, "latin1").toString("hex");
const VIN = "WDB0000000A000001";

type Sent = { tx: string; requests: string[] };

/** A small fake car: an ECM (UDS), an airbag unit (UDS, protected), a KWP gearbox, a silent module. */
function fakeCar() {
  const sent: Sent[] = [];
  const session: Record<string, string> = {};
  const answer = (tx: string, q: string): { response?: string; negative?: boolean; nrc?: number; error?: string } => {
    const r = q.toLowerCase();
    if (tx === "7E2") return { error: "timeout" };                       // silent module
    if (r.startsWith("10")) { session[tx] = r.slice(2); return { response: `50${r.slice(2)}` }; }
    if (tx === "7E0") {                                                  // ECM
      if (r === "22f190") return { response: `62f190${ascii(VIN)}` };
      if (r === "22f18c") return { response: `62f18c${ascii("SN-ECM-0001")}` };
      if (r === "22f111") return { response: `62f111${ascii("6429011100")}` };
      if (r === "22f18b" && session[tx] === "03") return { response: "62f18b140623" };   // only in extended
      return { response: `7f22${r === "22f18b" ? "7f" : "31"}`, negative: true, nrc: r === "22f18b" ? 0x7f : 0x31 };
    }
    if (tx === "784") {                                                  // airbag — protected
      if (r === "22f18c") return { response: `62f18c${ascii("SN-SRS-0002")}` };
      return { response: "7f227f", negative: true, nrc: 0x7f };          // "not in this session" — must NOT trigger 10 03
    }
    if (tx === "7E3") {                                                  // filed as UDS, speaks only KWP
      if (r.startsWith("22")) return { response: "7f2211", negative: true, nrc: 0x11 };
      if (r === "1a87") return { response: `5a87${ascii("1112223334")}` };
      return { response: "7f1a12", negative: true, nrc: 0x12 };
    }
    if (tx === "7E4") {                                                  // filed as KWP, speaks only UDS
      if (r.startsWith("1a")) return { response: "7f1a11", negative: true, nrc: 0x11 };
      if (r === "22f18c") return { response: `62f18c${ascii("SN-UDS-0003")}` };
      return { response: "7f2231", negative: true, nrc: 0x31 };
    }
    if (tx === "7E1") {                                                  // KWP gearbox
      if (r.startsWith("22")) return { response: "7f2211", negative: true, nrc: 0x11 };
      if (r === "1a87") return { response: `5a87${ascii("G0034464110")}` };
      if (r === "1a90") return { response: `5a90${ascii(VIN)}` };
      return { response: "7f1a12", negative: true, nrc: 0x12 };
    }
    return { error: "timeout" };
  };
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const b = JSON.parse(init?.body ?? "{}") as { tx: string; requests: string[] };
    sent.push({ tx: b.tx, requests: b.requests });
    const results = b.requests.map((q) => ({ request: q, ...answer(b.tx, q) }));
    return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return sent;
}

const mod = (id: string, label: string, category: string, req: string, resp: string, protocol?: string) =>
  ({ id, label, category, bus: "hs-can", location: "engine", addressing: { request: req, response: resp }, ...(protocol ? { protocol } : {}) });

const profile = {
  id: "test-car", year: 2015, make: "Mercedes-Benz", model: "Sprinter", bodyType: "van", buses: [], capabilities: [],
  provenance: { source: "user", confidence: 1, createdAt: "", updatedAt: "" },
  modules: [
    mod("ecm", "CDI Engine Control Unit (ECM)", "powertrain", "7E0", "7E8", "uds"),
    mod("tcm", "EGS Transmission Control Unit", "transmission", "7E1", "7E9", "kwp2000"),
    mod("dead", "Unknown module", "other", "7E2", "7EA"),
    mod("srs", "SRS — Supplemental Restraint System / Airbag Control Unit", "safety", "784", "785", "uds"),
  ],
} as unknown as VehicleProfile;

test("identity read: what is read, filed and never sent", async () => {
  const sent = fakeCar();
  const events: string[] = [];
  const inv = await identifyCar({ host: "fake:8080", iface: "vcan0", profile, vin: VIN, onEvent: (e) => events.push(e.type) });
  const by = Object.fromEntries(inv.modules.map((m) => [m.moduleId, m]));
  const all = sent.flatMap((s) => s.requests.map((q) => ({ tx: s.tx, q: q.toLowerCase() })));

  // every request sent is an identification read or a harmless session switch
  for (const { q } of all) assert.match(q, /^(22|1a|1003|1001)/, q);

  // the airbag unit: identity in its current session only — no session change, ever
  assert.ok(all.filter((x) => x.tx === "784").every((x) => !x.q.startsWith("10")), "a session change was sent to the airbag unit");
  assert.equal(by.srs.summary.serial, "SN-SRS-0002");
  assert.equal(by.srs.protectedKind, "restraint");

  // the ECM: standard + Mercedes DIDs; the date refused in default is read in extended, then back to default
  assert.equal(by.ecm.summary.serial, "SN-ECM-0001");
  assert.equal(by.ecm.summary.vin, VIN);
  assert.equal(by.ecm.summary.mfgDate, "2014-06-23");
  assert.equal(by.ecm.records.find((r) => r.key === "mfgDate")?.session, "03");
  const ecmQs = all.filter((x) => x.tx === "7E0").map((x) => x.q);
  assert.ok(ecmQs.includes("1003") && ecmQs[ecmQs.length - 1] === "1001", "extended pass must end back in the default session");

  // the KWP gearbox: UDS refused as "service not supported" → KWP identification, part number cleaned
  assert.equal(by.tcm.summary.partNo, "0034464110");
  assert.equal(by.tcm.protocol, "kwp2000");

  // the silent module: asked once (one chunk), then left alone
  assert.equal(by.dead.status, "no_response");
  assert.equal(sent.filter((s) => s.tx === "7E2").length, 1);

  // live events for the map
  assert.equal(events[0], "ident-start");
  assert.ok(events.includes("ident-record"));
  assert.equal(events[events.length - 1], "ident-done");
});

test("a module filed under the wrong protocol is still identified", async () => {
  fakeCar();
  const misfiled = {
    ...profile,
    modules: [
      mod("a", "Module A", "body", "7E3", "7EB", "uds"),        // really KWP
      mod("b", "Module B", "body", "7E4", "7EC", "kwp2000"),    // really UDS
    ],
  } as unknown as VehicleProfile;
  const inv = await identifyCar({ host: "fake:8080", iface: "vcan0", profile: misfiled, extended: false });
  const by = Object.fromEntries(inv.modules.map((m) => [m.moduleId, m]));
  assert.equal(by.a.summary.partNo, "1112223334");
  assert.equal(by.a.protocol, "kwp2000");
  assert.equal(by.b.summary.serial, "SN-UDS-0003");
  assert.equal(by.b.protocol, "uds");
});

test("identity read can skip the extended pass", async () => {
  const sent = fakeCar();
  const inv = await identifyCar({ host: "fake:8080", iface: "vcan0", profile, vin: VIN, moduleIds: ["ecm"], extended: false });
  assert.ok(!sent.flatMap((s) => s.requests).some((q) => q.startsWith("10")));
  assert.equal(inv.modules[0].summary.mfgDate, undefined);
});
