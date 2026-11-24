import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRequest, firstRefusal, isReadOnlyRequest } from "./readPolicy.js";
import { protectedModule } from "./protectedModules.js";

const ok = (q: string, kind?: "restraint" | "immobiliser") => checkRequest(q, { protectedKind: kind ?? null }).ok;

test("plain reads pass on an ordinary module", () => {
  for (const q of ["22F190", "22 F1 8C", "1A87", "1A8C", "1902FF", "190A", "1802FF00", "1702FF00", "3E00", "3E80", "2101", "0100", "0902", "03", "0A", "2312345602", "24F190"]) {
    assert.ok(ok(q), `${q} should be allowed`);
  }
});

test("harmless sessions pass, programming and safety-system sessions never", () => {
  for (const q of ["1001", "1003", "1081", "1086", "1087", "1089", "1092", "10C0"]) assert.ok(ok(q), q);
  for (const q of ["1002", "1082", "1085", "1004", "1084", "100300", "10"]) assert.ok(!ok(q), q);
});

test("security access: seed only, never a key", () => {
  assert.ok(ok("2701"));
  assert.ok(ok("2711"));
  assert.ok(!ok("2702"));
  assert.ok(!ok("27021234"));
  assert.ok(!ok("270112"));
});

test("every write service is refused, with its name", () => {
  const writes: [string, RegExp][] = [
    ["14FFFFFF", /clear DTC/], ["04", /clear codes/], ["1101", /reset/], ["2EF19001", /write data/],
    ["2F", /actuator/], ["3101FF00", /routine/], ["3401", /download/], ["3601", /transfer/],
    ["3B9001", /write data by local/], ["3D", /write memory/], ["2803", /communication/], ["8502", /DTC setting/],
  ];
  for (const [q, why] of writes) {
    const v = checkRequest(q);
    assert.equal(v.ok, false, q);
    if (!v.ok) assert.match(v.reason, why, q);
  }
});

test("garbage never passes", () => {
  for (const q of ["", "2", "22F", "zz", "22F19G"]) assert.ok(!isReadOnlyRequest(q), JSON.stringify(q));
});

test("airbag / immobiliser: identity and fault memory only, in the current session", () => {
  for (const kind of ["restraint", "immobiliser"] as const) {
    for (const q of ["22F18C", "22F190", "1A87", "1A8C", "1902FF", "1802FF00", "3E00"]) assert.ok(ok(q, kind), `${kind} ${q}`);
    for (const q of ["1003", "1001", "1092", "2701", "2312345602", "2101", "14FFFFFF", "3101FF00", "1004", "0100"]) {
      assert.ok(!ok(q, kind), `${kind} ${q} must be refused`);
    }
  }
});

test("a sequence is refused as a whole by its first bad request", () => {
  assert.equal(firstRefusal(["1003", "22F190", "22F18C"]), null);
  assert.match(firstRefusal(["1003", "14FFFFFF"]) ?? "", /^14FFFFFF: clear DTC/);
  assert.match(firstRefusal(["1003", "22F18C"], { protectedKind: "restraint" }) ?? "", /^1003: session change refused/);
});

test("the Sprinter's protected modules are recognised by name", () => {
  assert.equal(protectedModule({ label: "SRS — Supplemental Restraint System / Airbag Control Unit", category: "safety" })?.kind, "restraint");
  assert.equal(protectedModule({ label: "EZS — Electronic Ignition Switch / Electronic Ignition Lock (EIS, immobiliser)", category: "body" })?.kind, "immobiliser");
  assert.equal(protectedModule({ label: "CDI Engine Control Unit (ECM, OM642 3.0L V6 BlueTEC)", category: "powertrain" }), null);
});
