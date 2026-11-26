import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { VehicleProfile } from "@ecu/vehicle-db";
import { saveStoredVehicleProfile } from "@ecu/vehicle-db/vehicleStore";

import { ensureSimLibrary, isSimulatorTarget, realLibraryDir, simLibraryDir } from "./simLibrary";

test("simulators are recognised by address or by bus; real devices are not", () => {
  for (const h of ["127.0.0.1:8765", "localhost:8771", "http://127.0.0.1:8765", "[::1]:8765", "127.0.0.1"]) assert.ok(isSimulatorTarget(h, "can0"), h);
  assert.ok(isSimulatorTarget("100.64.0.1:8080", "vcan0"));
  for (const [h, i] of [["100.64.0.1:8080", "can0"], ["superdevice.local:8080", "can1"], [undefined, "can0"], ["", undefined]] as const) {
    assert.ok(!isSimulatorTarget(h, i), `${h} ${i}`);
  }
});

const profile = (over: Partial<VehicleProfile> = {}): VehicleProfile => ({
  id: "t-car", year: 2015, make: "Mercedes-Benz", model: "Sprinter", bodyType: "van", buses: [{ id: "hs-can", label: "HS-CAN", protocol: "CAN", bitrate: 500000 }],
  modules: [], capabilities: [], provenance: { source: "user", confidence: 0.5, createdAt: "2026-11-24T00:00:00Z", updatedAt: "2026-11-24T00:00:00Z" }, ...over,
} as unknown as VehicleProfile);
const withSimScan = () => profile({ knownVins: [{ vin: "WDB0000000A000001", firstReadAt: "", lastReadAt: "", reads: 1, scans: [{ at: "", kind: "auto", systems: [], sim: "desk" }] }] } as unknown as Partial<VehicleProfile>);

test("the sandbox starts as a copy of the real library and is never copied back", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "ual-lib-"));
  const real = realLibraryDir(ws), sim = simLibraryDir(ws);
  await mkdir(real, { recursive: true });
  await writeFile(path.join(real, "a.vehicle.json"), "{\"real\":1}");
  await ensureSimLibrary(real, sim);
  assert.deepEqual(await readdir(sim), ["a.vehicle.json"]);
  await writeFile(path.join(sim, "a.vehicle.json"), "{\"sandbox\":1}");
  await ensureSimLibrary(real, sim);                                   // a filled sandbox is left as it is
  assert.equal(await readFile(path.join(sim, "a.vehicle.json"), "utf8"), "{\"sandbox\":1}");
  assert.equal(await readFile(path.join(real, "a.vehicle.json"), "utf8"), "{\"real\":1}");
});

test("the real library refuses simulator-tagged records; the sandbox takes them", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "ual-lib-"));
  await assert.rejects(saveStoredVehicleProfile(realLibraryDir(ws), withSimScan(), "2026-11-24T00:00:00Z"), /real cars only/);
  await saveStoredVehicleProfile(simLibraryDir(ws), withSimScan(), "2026-11-24T00:00:00Z");
  await saveStoredVehicleProfile(realLibraryDir(ws), profile(), "2026-11-24T00:00:00Z");   // a clean record still saves
  // an inventory or a sweep from a simulator is refused too
  await assert.rejects(saveStoredVehicleProfile(realLibraryDir(ws), profile({ modules: [{ id: "m", label: "ECM", category: "powertrain", bus: "hs-can", location: "engine",
    sweeps: [{ at: "", condition: "x", sim: "desk", protocol: "uds", sessions: [], ranges: [], hits: [], counts: { asked: 0, answered: 0, moving: 0, gated: 0, ms: 0 } }] }] } as unknown as Partial<VehicleProfile>), "n"), /completeness sweep/);
});

test("the sandbox follows the real library when the real one learned more since", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "ual-lib-"));
  const real = realLibraryDir(ws), sim = simLibraryDir(ws);
  await mkdir(real, { recursive: true });
  await writeFile(path.join(real, "a.vehicle.json"), "{\"v\":1}");
  await ensureSimLibrary(real, sim);
  await writeFile(path.join(real, "a.vehicle.json"), "{\"v\":2}");                      // a real visit adds knowledge
  const later = new Date(Date.now() + 5000);
  await utimes(path.join(real, "a.vehicle.json"), later, later);
  await writeFile(path.join(real, "b.vehicle.json"), "{\"new\":1}");
  await ensureSimLibrary(real, sim);
  assert.equal(await readFile(path.join(sim, "a.vehicle.json"), "utf8"), "{\"v\":2}");
  assert.equal(await readFile(path.join(sim, "b.vehicle.json"), "utf8"), "{\"new\":1}");
  assert.equal(await readFile(path.join(real, "a.vehicle.json"), "utf8"), "{\"v\":2}");
});
