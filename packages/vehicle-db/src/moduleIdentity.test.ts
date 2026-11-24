import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KWP_IDENT, UDS_IDENT, bcdDate, decodeIdentResponse, identPlan, inventoryChanges, recordInventory, summarizeRecords,
  type CarInventory, type IdentSpec,
} from "./moduleIdentity.js";
import type { VehicleProfile } from "./vehicleProfile.schema.js";

const spec = (req: string): IdentSpec => [...UDS_IDENT, ...KWP_IDENT].find((s) => s.req === req)!;
const ascii = (t: string) => Buffer.from(t, "latin1").toString("hex");

test("UDS VIN and serial decode to text", () => {
  assert.equal(decodeIdentResponse(spec("22F190"), `62F190${ascii("WDB0000000A000001")}`)?.value, "WDB0000000A000001");
  assert.equal(decodeIdentResponse(spec("22F18C"), `62F18C${ascii("0584601091047203")}`)?.value, "0584601091047203");
});

test("Mercedes part list and version decode", () => {
  assert.equal(decodeIdentResponse(spec("22F121"), `62F121${ascii("642902720364290347176429040300")}`)?.value,
    "6429027203 / 6429034717 / 6429040300");
  assert.equal(decodeIdentResponse(spec("22F150"), "62F1500C0200")?.value, "12/02 00");
  // F151: one year/week/patch group per software part (the ECM of the 2015 Sprinter)
  assert.equal(decodeIdentResponse(spec("22F151"), "62F1510C0D00120F00140500")?.value, "12/13 00 / 18/15 00 / 20/05 00");
  // a 3-byte field that is not a version is not dressed up as one
  assert.equal(decodeIdentResponse(spec("22F150"), "62F150FF4000")?.value, "FF4000");
  assert.equal(decodeIdentResponse(spec("22F111"), `62F111${ascii("6429011100")}`)?.value, "6429011100");
});

test("BCD dates", () => {
  assert.equal(bcdDate([0x14, 0x06, 0x23]), "2014-06-23");
  assert.equal(bcdDate([0x20, 0x15, 0x01, 0x31]), "2015-01-31");
  assert.equal(bcdDate([0x14, 0x13, 0x01]), null);
  assert.equal(decodeIdentResponse(spec("22F18B"), "62F18B140623")?.value, "2014-06-23");
});

test("binary records fall back to hex", () => {
  assert.equal(decodeIdentResponse(spec("22F18A"), "62F18A0A1B")?.value, "0A1B");
});

test("KWP identification: part number is the trailing digit run", () => {
  // a printable status byte 'G' in front of the part number must not stick to it
  const r = decodeIdentResponse(spec("1A87"), `5A87001203${ascii("G9069013501")}`);
  assert.equal(r?.value, "9069013501");
  assert.equal(decodeIdentResponse(spec("1A90"), `5A90${ascii("WDB0000000A000001")}`)?.value, "WDB0000000A000001");
});

test("negative, wrong-echo and blank answers are not records", () => {
  assert.equal(decodeIdentResponse(spec("22F190"), "7F2231"), null);
  assert.equal(decodeIdentResponse(spec("22F190"), `62F18C${ascii("123456")}`), null);
  assert.equal(decodeIdentResponse(spec("22F18C"), "62F18C00000000"), null);
  assert.equal(decodeIdentResponse(spec("22F18C"), "62F18CFFFFFF"), null);
  assert.equal(decodeIdentResponse(spec("1A87"), "5A90AA"), null);
  assert.equal(decodeIdentResponse(spec("22F190"), undefined), null);
});

test("plans: Mercedes DIDs only on Mercedes cars; KWP modules get KWP reads", () => {
  assert.ok(!identPlan("uds").some((s) => s.req === "22F111"));
  assert.ok(identPlan("uds", { mercedes: true }).some((s) => s.req === "22F111"));
  assert.ok(identPlan("kwp2000").every((s) => s.req.startsWith("1A")));
  // every identity request is a plain read
  for (const s of [...UDS_IDENT, ...KWP_IDENT]) assert.match(s.req, /^(22|1A)/);
});

test("summary: first record per key wins, part number falls back to hardware part number", () => {
  const s = summarizeRecords([
    { id: "22 F111", key: "hwPartNo", label: "", value: "6429011100" },
    { id: "22 F18C", key: "serial", label: "", value: "A" },
    { id: "1A 8C", key: "serial", label: "", value: "B" },
  ]);
  assert.equal(s.serial, "A");
  assert.equal(s.partNo, "6429011100");
});

const inv = (at: string, serial: string, extra: CarInventory["modules"] = []): CarInventory => ({
  at,
  modules: [
    { moduleId: "ecm", label: "ECM", requestId: "7E0", responseId: "7E8", status: "ok", summary: { serial, partNo: "6429011100" }, records: [] },
    ...extra,
  ],
});

test("a changed serial is logged as a module change", () => {
  const ch = inventoryChanges(inv("2026-11-23", "111"), inv("2026-12-01", "222"));
  assert.equal(ch.length, 1);
  assert.deepEqual([ch[0].moduleId, ch[0].key, ch[0].from, ch[0].to], ["ecm", "serial", "111", "222"]);
});

test("recordInventory keeps modules a partial read did not reach", () => {
  const vin = "WDB0000000A000001";
  const base = { id: "x", year: 2015, make: "Mercedes-Benz", model: "Sprinter", bodyType: "van", buses: [], modules: [], capabilities: [],
    provenance: { source: "user", confidence: 1, createdAt: "", updatedAt: "" },
    knownVins: [{ vin, firstReadAt: "", lastReadAt: "", reads: 1 }] } as unknown as VehicleProfile;
  const tcm = { moduleId: "tcm", label: "TCM", requestId: "7E1", responseId: "7E9", status: "ok" as const, summary: { serial: "T1" }, records: [] };
  let p = recordInventory(base, vin, inv("2026-11-23", "111", [tcm]));
  p = recordInventory(p, vin, { at: "2026-12-01", modules: [{ ...inv("", "111").modules[0] }, { ...tcm, status: "no_response", summary: {} }] });
  const mods = p.knownVins![0].inventory!.modules;
  assert.equal(mods.find((m) => m.moduleId === "tcm")?.summary.serial, "T1");
  assert.match(mods.find((m) => m.moduleId === "tcm")?.note ?? "", /kept from/);
  // an unknown VIN is not filed
  assert.equal(recordInventory(base, "XXX", inv("a", "1")), base);
});
