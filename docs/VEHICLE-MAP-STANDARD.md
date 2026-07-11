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
