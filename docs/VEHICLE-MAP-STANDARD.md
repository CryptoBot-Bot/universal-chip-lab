# Vehicle Map — the Gold Standard

The canonical structure every vehicle in the library must reach, and the target the
AI mapper must produce for an **unknown** car. The reference implementation is the
seeded **2020 Toyota Corolla** (`packages/vehicle-db/src/vehicleProfileSeed.ts` +
`moduleCatalog.ts`). A map is "gold" when it lets a user *see everything they can see*
and *do everything they can do* on that car — honestly labelled by how real each item is.

---

## 1. The honesty principle: what is *actually* real over OBD

Not everything is reachable the same way. A gold map tags every capability with its truth:

| Tier | What it is | Reality on a real car |
|---|---|---|
| **Universal OBD-II (SAE J1979)** | Modes 01–0A: live PIDs, freeze frame, DTCs (stored/pending/permanent), readiness monitors, on-board monitor tests, VIN/CAL-ID/CVN | **100% real on every compliant car** (US ≥1996, EU petrol ≥2001 / diesel ≥2004). This is the guaranteed floor. |
| **Manufacturer UDS diagnostics** | Per-module DIDs, live blocks, extended DTCs, actuator tests, coding | Real but **manufacturer/module-specific**; needs the right addressing, sessions, often SecurityAccess. |
| **Memory read (the clone source)** | Full flash/EEPROM image | **Module-dependent** — see §4. Many modern ECUs block OBD read; those need bench/boot-mode. |
| **Writes** | Clear DTCs, coding, adaptations, calibration, reflash | Real but gated — confirmation + (for memory) the Cloning Ceremony. |

**Rule:** the map never claims more than the car actually offers. Guessed items are marked
`ai_suggested`; confirmed-on-silicon items are `bench_verified`; the OBD-II floor is `seed`.

---

## 2. The canonical structure

Every `VehicleProfile` should carry:

1. **Identity** — year, make, model, trim, body type, market, WMI list, engine/platform.
2. **Buses & topology** — each bus (protocol, bitrate, OBD pins) **and** which modules are
   reached directly vs. behind the **Central Gateway** (they must be routed).
3. **Universal OBD-II baseline** — the J1979 modes/PIDs/monitors that are guaranteed real.
4. **Modules** — for each: id, label, category, 3D location, addressing (request/response),
   protocol, supplier, and **memory read method** (`obd` / `obd_partial` / `bench`).
5. **Per-module detail** (the ECU inspector payload):
   - sessions, services
   - ECU identification DIDs (part #, SW/HW version, serial, supplier, VIN)
   - **live data** parameters
   - **fault codes** (with active-vs-historic behaviour)
   - **configuration / coding** parameters (editable flagged)
   - **memory map** (flash/eeprom size + read method)
   - **actions & routines** (each risk-tagged: read / write / caution)
6. **Provenance / trust** on every learned field (`seed` | `bench_verified` | `ai_suggested`).

---

## 3. Worked example — 2020 Toyota Corolla (TNGA, TSS 2.0)

**Identity:** 2020 · Toyota · Corolla · sedan · US · WMI JTD/2T1/5YF · HS-CAN 500 k on OBD 6/14,
body modules behind the **Central Gateway**.

**Twelve modules mapped**, each with its honest memory read method:

| Module | Addr | Category | Memory read |
|---|---|---|---|
| Engine Control (ECM) | 7E0/7E8 | powertrain | **bench** (Denso read-protected) |
| CVT Transaxle (TCM) | 7E1/7E9 | transmission | **bench** |
| Skid Control (ABS/VSC) | 7B0/7B8 | chassis | obd_partial |
| Airbag (SRS) | 780/788 | safety | obd_partial |
| Main Body ECU (BCM) | 7C0/7C8 | body | **obd** |
| Combination Meter | — | infotainment | **bench** (odometer protected) |
| A/C Amplifier | — | hvac | **obd** |
| Forward Recognition (radar) | 7D0/7D8 | safety | obd_partial |
| Electric Power Steering | 7A6/7AE | chassis | obd_partial |
| Central Gateway (CGW) | 750/758 | network | **bench** |
| Smart Key / Cert (immo) | 751/759 | body | **bench** |
| Parking Assist (sonar) | 7B6/7BE | safety | **obd** |

Each exposes real DIDs, live data, DTCs (some active → re-set after clear, some historic →
stay cleared), coding parameters, and actions. The **immo module is read-only + a lawful
"register your own key" that is never a bypass** — per the project charter.

---

## 4. Why memory read differs per module (the important truth)

Cloning wants the raw firmware image. Whether OBD can give it depends on the ECU:

- **`obd`** — simpler modules (body ECU, A/C, sonar) often allow full OBD read.
- **`obd_partial`** — OBD returns identifiers/calibration, but the code region is walled off.
- **`bench`** — modern engine/trans ECUs, the gateway, the immobiliser, and the tamper-protected
  meter **block OBD firmware read by design**. The real world reaches these via **bench /
  boot-mode** (pull the module → T48 / PicoForge clip / BDM-JTAG), which is the app's
  bench-memory side — *not* OBD.

So the cockpit's dump button is honest: it dumps `obd`/`obd_partial` modules over the bus, and
for `bench` modules it says so and points to the Read → Dumps bench flow. **This is why the
Super Device has both an OBD path and a bench path.**

---

## 5. What the AI mapper must produce for an unknown car

**Inputs** it can use:
- VIN decode (year/make/country/body hint).
- A live bus scan (which response IDs answer, at what rate) + ISO-TP probes.
- Standard OBD-II interrogation (supported PIDs, VIN, CAL-ID — the guaranteed floor).
- Prior library knowledge for the same platform/manufacturer.

**Output:** a `VehicleProfile` matching §2 — as complete as evidence allows, with:
- Every module it can fingerprint, placed and addressed.
- The universal OBD-II baseline always filled (it's guaranteed).
- Manufacturer specifics filled where confidently inferred, **marked `ai_suggested`**.
- Each module's memory read method estimated (and flagged as an estimate until bench-verified).
- **No fabrication** — if it doesn't know, it says "unknown" rather than inventing a DID.

**Growth loop:** `ai_suggested` → user/bench confirms on the real car → promoted to
`bench_verified` → baked into the community catalog → travels with the next publish. Every car
touched makes the next one of that platform map faster and truer.

**Coverage checklist for "gold":** identity ✓ · buses+gateway ✓ · OBD-II baseline ✓ · all
fingerprinted modules ✓ · per-module DIDs/live/DTCs/coding/actions ✓ · memory read method ✓ ·
trust level on every field ✓.


---

## 6. Vehicle identity — how we decide WHICH car this is (the standard)

A VIN never names a model by itself. The WMI (positions 1-3) is the manufacturer +
vehicle type — `JTD` covers every Japan-built Toyota passenger car, `1FT` every Ford
truck. Matching a library profile on WMI (or make + year) alone is how the cockpit
used to pick the wrong car, and worse, then folded the real car's modules into that
wrong profile. The rule now: **a profile is bound only when the library is certain**,
and every bind teaches the library so the next unit is certain sooner.

| Layer | Evidence | Result |
|---|---|---|
| 1 | **Exact VIN** already on file (`knownVins`) | bind (confidence 1.0) |
| 2 | **VIN pattern** — the "squish" of a unit previously CONFIRMED on this YMM: positions 1-8 (WMI + VDS model/body/engine codes) + position 10 (year); check digit and plant/serial wildcarded. Year must agree. | bind (0.95) |
| 3 | **Confirmed Year/Make/Model** from a trusted source — the operator, the shop garage decoder, or the AI identifier after operator confirmation | bind (0.92) |
| 4 | Same WMI / same make (+ year) | **hint only** (≤ 0.4) — shown as a candidate, never bound |

Implementation: `packages/vehicle-db/src/vehicleIdentity.ts` — `resolveVehicleIdentity()`
returns `{ bound, candidates }`; `BIND_THRESHOLD = 0.9`; `learnVin()` records the VIN
**and** its squish pattern + WMI on the profile (called only on a confirmed bind);
`findProfileForVin()` is now strict and only returns a layer-1..3 match.

**When nothing binds → the Identify stage** (`components/VehicleIdentify.tsx`):
1. show the offline decode (maker, model codes, year, plant, check digit) and the hints;
2. **Scan bus & identify with AI** — discovery probes the standard OEM address sweep
   (Toyota / Ford FEPS / VAG +0x6A / Honda / Nissan / Mercedes / BMW 0x6xx / GM +0x400,
   ~50 pairs) and reads every responder's identification DIDs (22 F187 part number,
   F190 VIN, F18A supplier, F195 software, F191 hardware, F18C serial) — read-only,
   no AI, ~20 s; then the AI identifier (`electron/resolver/vehicleIdentifier.ts`,
   Claude Opus 5, structured output) decodes VIN structure + the part numbers (Toyota
   `-02` = Corolla series, Ford `JL3` = 2018 F-150, VAG `5Q0` = MQB, …) + the address
   map + the library candidates (with bus-fingerprint similarity) into a proposed
   identity with **evidence[]**, **warnings[]**, a **matchedProfileId** only when the
   evidence establishes it, and a name for every responding module. It must answer
   `model: "unknown"` rather than invent one;
3. the operator confirms (or corrects, or types it) → the YMM profile is created or
   bound, the VIN + pattern learned, the **bus fingerprint** (responders + each one's
   identification) and every discovered module with its real part number saved.

Verified 2026-09-04 against the virtual vehicles on the bench: the Corolla sim
(`JTDEPRAE6LJ012345`) is NOT bound before learning (hint only), the AI identifies it
as a 2020 Corolla from the `-02` series code in all 12 part numbers and matches the
library profile; the F-150 sim is never bound to the Corolla, all 9 Ford modules are
found, and the AI identifies a 2018 F-150 (`JL3` prefixes, W1E series code). After one
confirmed bind, the next unit of the same VIN shape resolves at layer 2 with no AI.

## 7. The standard scan → map → operate pipeline (every car, same steps)

| Stage | What happens | What is persisted |
|---|---|---|
| ① Read VIN | OBD 09 02 from the ECM on the live bus | — |
| ①b NHTSA decode | free vPIC `DecodeVinValuesExtended` (`electron/resolver/vinOnline.ts`, cached per VIN in `vehicle-library/vin-decode-cache.json`) → year / make / model / trim / series / body / engine / drive / plant. Its Year/Make/Model is a TRUSTED identity (layer 3): binds an existing profile or files a new one (`profileFromOnlineDecode`) | `profile.decoded`, VIN + pattern learned |
| ② Identify (fallback) | only when NHTSA cannot name the model: layers 1-4 above; bus scan + AI + operator | profile bound; VIN, VIN pattern, WMI, fingerprint |
| ③ Discover & census | ~50-pair OEM address sweep + identification DIDs on every responder (no AI, ~20 s), then the **AI census** (`censusModules`, IPC `vehicleId:census`) names every responder in the maker's own terms with role, category, protocol, memory-read estimate and typical services | modules with address, `lastSeenAt`, `identity` (`observedAt` = live-read), `summary`, `protocol`, `memoryRead`, `censusAt` |
| ④ Deep-map | per-module AI explorer, seeded with the discovered identity + census line, verifies sessions / services / IDs / live data / DTCs / broadcast → canonical 14-op capability board. New `scan_dids` tool sweeps DID ranges (0100-03FF measurement+coding, F180-F1FF identification, F400-F4FF OBD mirror) the way a real tester finds a module's blocks; seed requests (27 01) allowed, keys never | `module.explored` (folds, never regresses) |
| ⑤ Operate | **READ** (identification, DTCs, live data, broadcast, raw) and **WRITE** (clear DTCs, security seed/key, write DID, routine, ECU reset) live on the bus — every write through the confirm modal; flash/memory write is bench-only | `module.opsLog` (what actually worked on this car) |

**Bench-verified 2026-09-04 (headless, virtual Corolla):** NHTSA → 2020 Toyota Corolla LE
(ZRE212L, 2ZR-FAE); discovery 12 modules in 21 s; census named all 12 (Skid Control ECU,
Certification ECU, A/C Amplifier …) in 49 s; ECM deep-map with `scan_dids`: 20 identification
records, 19 live-data blocks, 3 DTCs, full board, 7 steps / 246 s.

**Per-module simulators (the training bench):** `hardware/super-device/webui/virtual_vehicle.py`
now models every module TYPE as a real-world template (ecm, tcm, abs, srs, eps, bcm, cluster,
hvac, gateway, radar, camera, immo, sonar): identification block F180-F19F, measurement DIDs
0100-01xx with real scalings, coding DIDs 0200-02xx (2E after security), I/O control 2F 03xx,
routines 31 01, DTC 19 01/02/04/06/0A with snapshots, OBD + F4xx mirror on powertrain. `--describe
<vehicle>` prints the ground truth so an AI deep-map can be scored against it.

Module trust: `identity.observedAt` set = read off the car; absent = seeded/guessed.
Capability statuses come from live responses (`supported` / `gated` with NRC /
`unsupported` / `unknown`). The virtual vehicles (`hardware/super-device/webui/
virtual_vehicle.py`, Corolla + F-150, stateful sessions/security/writes) exercise all
five stages on the bench with no car.
