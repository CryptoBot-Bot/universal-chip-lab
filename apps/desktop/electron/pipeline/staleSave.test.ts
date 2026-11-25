/** Saving from an older copy never drops what was measured meanwhile. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { addSweep, explorationFaults, isDtcCode, recordScan } from "@ecu/vehicle-db";
import type { ModuleSweep, VehicleProfile, VehicleScanRecord } from "@ecu/vehicle-db";
import { loadStoredVehicleProfiles, saveStoredVehicleProfile } from "@ecu/vehicle-db/vehicleStore";

const VIN = "WDB0000000A000001";
const sweep = (condition: string, at: string): ModuleSweep => ({ at, condition, protocol: "kwp2000", sessions: [], ranges: [], hits: [], counts: { asked: 1, answered: 1, moving: 0, gated: 0, ms: 1 } });
const mod = (id: string, response: string, over: Record<string, unknown> = {}) => ({ id, label: id.toUpperCase(), category: "chassis", bus: "hs-can", location: "engine", addressing: { request: "726", response }, ...over });
const base = (): VehicleProfile => ({
  id: "t-car", year: 2015, make: "Mercedes-Benz", model: "Sprinter", bodyType: "van", buses: [{ id: "hs-can", label: "HS-CAN", protocol: "CAN", bitrate: 500000 }],
  modules: [mod("esp", "4E6"), mod("ecm", "7E8")], capabilities: [], knownVins: [{ vin: VIN, firstReadAt: "2026-11-23T00:00:00Z", lastReadAt: "2026-11-23T00:00:00Z", reads: 1 }],
  provenance: { source: "user", confidence: 0.5, createdAt: "2026-11-23T00:00:00Z", updatedAt: "2026-11-23T00:00:00Z" },
} as unknown as VehicleProfile);
const dirOf = () => mkdtemp(path.join(os.tmpdir(), "ual-stale-"));
const load = async (dir: string) => (await loadStoredVehicleProfiles(dir)).records[0];
const scan = (at: string): VehicleScanRecord => ({ at, kind: "fault", systems: [] } as unknown as VehicleScanRecord);

test("the real case: a fault scan saved from an older copy keeps the sweep saved meanwhile", async () => {
  const dir = await dirOf();
  await saveStoredVehicleProfile(dir, base(), "2026-11-25T02:11:00Z");
  const screen = await load(dir);                                              // the app's copy, engine-off state
  const fresh = await load(dir);                                               // the sweep reads the file and saves
  await saveStoredVehicleProfile(dir, { ...fresh, modules: fresh.modules.map((m) => (m.id === "esp" ? { ...m, sweeps: addSweep(m.sweeps, sweep("idling", "2026-11-25T02:11:24Z")) } : m)) }, "2026-11-25T02:11:25Z");
  await saveStoredVehicleProfile(dir, recordScan(screen, VIN, scan("2026-11-25T02:11:40Z")), "2026-11-25T02:11:41Z");
  const end = await load(dir);
  assert.deepEqual(end.modules.find((m) => m.id === "esp")?.sweeps?.map((s) => s.condition), ["idling"]);
  assert.equal(end.knownVins?.[0].scans?.length, 1);
});

test("two steps at once: scans, a deep map, an inventory and a new module all survive", async () => {
  const dir = await dirOf();
  await saveStoredVehicleProfile(dir, base(), "2026-11-25T01:00:00Z");
  const a = await load(dir); const b = await load(dir);
  const withMap = { ...a, modules: [...a.modules.map((m) => (m.id === "ecm" ? { ...m, explored: { lastMappedAt: "2026-11-25T01:20:00Z" } } : m)), mod("new", "4F1")] } as unknown as VehicleProfile;
  await saveStoredVehicleProfile(dir, recordScan(withMap, VIN, scan("2026-11-25T01:05:00Z")), "2026-11-25T01:21:00Z");
  const other = recordScan(b, VIN, scan("2026-11-25T01:10:00Z"));
  other.knownVins![0] = { ...other.knownVins![0], reads: 4, inventory: { at: "2026-11-25T01:11:00Z", modules: [] } as never };
  await saveStoredVehicleProfile(dir, other, "2026-11-25T01:22:00Z");
  const end = await load(dir);
  assert.deepEqual(end.knownVins![0].scans!.map((s) => s.at), ["2026-11-25T01:05:00Z", "2026-11-25T01:10:00Z"]);
  assert.equal(end.knownVins![0].reads, 4);
  assert.equal(end.knownVins![0].inventory?.at, "2026-11-25T01:11:00Z");
  assert.equal(end.modules.find((m) => m.id === "ecm")?.explored?.lastMappedAt, "2026-11-25T01:20:00Z");
  assert.ok(end.modules.some((m) => m.id === "new"));
});

test("a newer sweep of the same condition replaces the older one, whichever copy has it", async () => {
  const dir = await dirOf();
  const p = base(); p.modules[0].sweeps = [sweep("idling", "2026-11-25T01:00:00Z")];
  await saveStoredVehicleProfile(dir, p, "2026-11-25T01:00:01Z");
  const old = await load(dir); const fresh = await load(dir);
  fresh.modules[0].sweeps = addSweep(fresh.modules[0].sweeps, sweep("idling", "2026-11-25T03:00:00Z"));
  await saveStoredVehicleProfile(dir, fresh, "2026-11-25T03:00:01Z");
  await saveStoredVehicleProfile(dir, old, "2026-11-25T03:05:00Z");
  assert.deepEqual((await load(dir)).modules[0].sweeps!.map((s) => s.at), ["2026-11-25T03:00:00Z"]);
});

test("a current copy may still remove things; a healed duplicate does not come back", async () => {
  const dir = await dirOf();
  await saveStoredVehicleProfile(dir, base(), "2026-11-25T01:00:00Z");
  const cur = await load(dir);
  await saveStoredVehicleProfile(dir, { ...cur, modules: cur.modules.filter((m) => m.id !== "ecm") }, "2026-11-25T01:01:00Z");
  assert.deepEqual((await load(dir)).modules.map((m) => m.id), ["esp"]);
  const dup = await load(dir);
  await saveStoredVehicleProfile(dir, { ...dup, modules: [...dup.modules, mod("resp-7e8", "7E8")] } as unknown as VehicleProfile, "2026-11-25T01:02:00Z");
  await saveStoredVehicleProfile(dir, { ...dup, modules: [...dup.modules, mod("ecm", "7E8")] } as unknown as VehicleProfile, "2026-11-25T01:03:00Z");   // stale copy, same address under its proper id
  assert.deepEqual((await load(dir)).modules.map((m) => m.id), ["esp", "ecm"]);
});

test("a sentence is not a fault code, and an untested code is not a fault (the real Sprinter maps)", () => {
  for (const c of ["P0740", "B170B", "U0019-88", "B210D-16", "0x9F12", "9F12", "0001"]) assert.ok(isDtcCode(c), c);
  for (const c of ["No stored DTCs", "None", "", "no faults", "P07"]) assert.ok(!isDtcCode(c), c);
  const list = [{ code: "B210A-00", desc: "Logged, status 0x40 test not completed (not active)" }, { code: "No stored DTCs", desc: "KWP 18 02 FF 00" }, { code: "B170B", desc: "stored, validated" }];
  assert.deepEqual(explorationFaults(list).map((d) => d.code), ["B170B"]);
});

test("of one and the same sweep, the fuller form is kept whichever copy is saved last", async () => {
  const dir = await dirOf();
  const full = { ...sweep("idling", "2026-11-25T01:00:00Z"), refs: { volts: [14, 14.1] as [number, number] }, hits: [{ id: "21 10", session: "92", bytes: "AB".repeat(200), moving: false }] };
  const p = base(); p.modules[0].sweeps = [{ ...full, refs: undefined, hits: [{ ...full.hits[0], bytes: "AB".repeat(64) }] } as ModuleSweep];
  await saveStoredVehicleProfile(dir, p, "2026-11-25T01:00:01Z");
  const old = await load(dir); const fresh = await load(dir);
  fresh.modules[0].sweeps = [full];
  await saveStoredVehicleProfile(dir, fresh, "2026-11-25T02:00:00Z");
  await saveStoredVehicleProfile(dir, old, "2026-11-25T02:05:00Z");
  const end = (await load(dir)).modules[0].sweeps!;
  assert.equal(end.length, 1);
  assert.equal(end[0].hits[0].bytes.length, 400);
  assert.ok(end[0].refs);
});
