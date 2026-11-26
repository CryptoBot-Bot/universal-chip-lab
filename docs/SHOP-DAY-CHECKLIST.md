# Shop-day checklist — first real vehicle with the SuperDevice

## Start here — a car with Universal Auto Lab (updated 2026-11-26)

**What it does today** — read-only diagnostics on CAN cars (OBD pins 6/14, 500 kbit/s): the VIN
and model, every module and its identity, every fault memory with the public meaning of the
code, the standard live values, the supply voltage, a complete map of each module, and a
mechanic assistant that can read but not act. All of it proven on the 2015 Sprinter (Nov 23–24)
except the mechanic reading live, which so far ran only on the simulator.

**What it does not do** — clear codes (the Pi refuses, the "Erase codes…" button included),
active tests, coding, programming, keys / immobiliser, anything on the airbag beyond its
identity and codes. It cannot talk to K-line or other pre-CAN cars (the Mini was one) or to
cars that diagnose over Ethernet.

**Before you go (at home, ten minutes)**
1. `pnpm test` — all pass.
2. The Pi is current: `python hardware/super-device/webui/deploy.py --status`; only if
   `superdevice_ui.py` shows CHANGED, run `python hardware/super-device/webui/deploy.py`
   (it checks itself on the Pi and rolls back on failure).
3. Once a month: Vehicles Database → any car → **What we know** → **Update sources**
   (or `pnpm vehicle sources sync`) — community values and fault-code meanings.
4. Pack: OBD harness (can0 = pins 6/14), Pi power, **battery charger**, exhaust extraction.

**At the car — in this order**
1. Ignition ON (dash lit), engine off, parking brake on. Harness in. Pi on an outlet or its battery.
2. Connection pill (top right) → the Pi. The **READ-ONLY** badge must be there.
3. **Voltage chip** next to it: green ≥ 12.4 V, amber 12.0–12.4 V, red below 12.0 V — red, or
   anything longer than a few minutes on amber: charger first. "— V" until the first VIN read;
   "old" means not current (click it to read now).
4. Auto Diagnostic → **AUTO VIN**. Check year / make / model.
5. **Auto Scan** (about a minute; a model seen for the first time searches every address first,
   about a minute more — the live map shows modules appearing). Then:
   - **Systems** — faults per system. Generic codes show their public meaning; a maker-specific
     code says so instead of guessing.
   - **Modules & serials** — part numbers, serial numbers, the VIN each module holds. A module
     from another car or a changed serial is flagged. Voltage for modules that report it.
6. **Mechanic** tab — ask about the car (about $0.07–0.11 per question). It reads live values
   and says how sure each one is (proven · standard · fits · AI guess). It cannot act.
7. Mapping deeper (a model seen for the first time, or a module with gaps): Vehicles Database →
   the model → its system → **Completeness** → what the car is doing → **Sweep this system**.
   Every module with the engine off first, then idling. Before every module the sweep reads
   engine speed, road speed and voltage and **stops if the car is not in the chosen state, is
   moving, or is below 11.8 V**. Idling only parked, brake on, with extraction,
   nobody driving: a sweep keeps diagnostic sessions open on modules such as the gearbox.
   Airbag and immobiliser modules are never offered.
8. Before unplugging: **Fault Scan** once more — the same codes as at the start, nothing new.

**After (no car needed)**
- Prove it stayed read-only: `pnpm vehicle --host <pi> rec fetch`, then
  `pnpm vehicle audit <recording id>` — it must say READ-ONLY.
- Names for what was swept: system → **Names and proof** → **Name with AI** (about
  $0.05–0.20 per module), or `pnpm vehicle --profile <id> label <module>`. Proven values come
  from the car's own readings in two states; everything else is shown as a proposal.
- **Dig deeper** (AI deep map, 1–4 min per module, engine off with a charger) when a module
  needs its sessions and services explored — that one does need the car.
- Vehicles Database → the model → **What we know**: what the day added.

**A car of another make (the next real test)** — same order. **Models we know** tells you
beforehand whether community values exist for it; after the sweeps, **What we know** shows
which of them fit this car, which are wrong and which do not apply.

**The 2015 Sprinter** — fully swept (engine off and idling), all 13 sweepable modules labelled
(20 identifiers proven), 7 systems AI-mapped on Nov 24. Still to prove on the van itself: the
Mechanic reading live, and a sweep with the new reference readings. EZS (immobiliser) and SRS
(airbag) stay identity + fault memory only.

The sections below are older: §1–§2 describe earlier screens; the troubleshooting (§3), remote
work (§4) and the read-only rules (§5) still apply.

---

What to do, in order, so the first real car "just works" — and what to do when it
doesn't. Written 2026-09-04 after the bench loop (virtual Corolla / F-150 on CAN1→CAN0)
was verified end to end; the real-car path is the same pipeline on a real bus.

## 0. The night before (at home, on the bench)

1. **Run the app version that has today's work.** Either the dev build (`pnpm dev` in the
   repo) or the installer built from it (`apps/desktop/release/*.exe`, v4.3.0+). The old
   installed release (≤ 4.2.2) does NOT have NHTSA decode, census, strict identity or the
   connection fix.
2. **Anthropic API key set** in Settings (or `ANTHROPIC_API_KEY` in `.env` for dev) — the
   census and the deep-map need it. NHTSA decode needs internet but no key.
3. **Power off the virtual vehicle and pull the CAN1↔CAN0 jumper.** In the app: Simulator
   → "Power off". Real mode now warns if the sim is still running and offers the button.
   Leave the 120 Ω terminators as they are for the bench; see §2 for the car.
4. **Pi Wi-Fi at the shop.** The Pi joins known Wi-Fi networks; if none is known within
   60 s it starts its own setup hotspot. Options:
   - **Shop Wi-Fi (best):** in the app, "📶 Set up new device / WiFi" and provision the
     shop SSID/password now if you know it — or do it at the shop from the hotspot.
   - **Phone hotspot:** provision the Pi to your phone's hotspot; the laptop joins the same
     hotspot → Pi + laptop + internet (NHTSA, AI) all work. This is the most reliable
     shop setup.
   - **Pi setup hotspot only (no internet):** discovery, identification, live READ/WRITE
     all work; NHTSA (unless the VIN is cached) and the AI census/deep-map do not. The
     app degrades to the Identify stage with manual entry.
5. Battery: the X1200 UPS shows % in the device card; the Pi is also powered from the OBD
   port (pin 16) once plugged in.

## 1. At the car — connect

1. Ignition **ON** (engine off is fine; running is fine too).
2. Plug the OBD cable. The Pi powers from the port; wait ~40 s for it to boot and join
   Wi-Fi; the app's "🔍 Scan network" finds it (or type its IP).
3. In the app: **REAL VEHICLE** → Connect → bring **can0 UP at 500k** (HS-CAN, pins 6/14).
   The bus card's RX rate should climb within a second or two — a real car chatters.
   - No RX at all: check bitrate (almost everything is 500k; some older US cars 250k),
     cable seated, and that can0 is the channel wired to pins 6/14 (AS-BUILT §4).
   - `canstate` BUS-OFF or error counters climbing: wrong bitrate or a wiring/termination
     problem — the car provides its own termination; the Pi's CAN0 terminator jumper must
     be **OFF** on a real vehicle (it was ON for the bench loop).
4. **① Read VIN.** The daemon now tries physical 7E0, functional 7DF, UDS 22 F190, and
   29-bit (Honda-style) addressing before giving up; the error lists what it tried.
5. The **NHTSA** line appears (year/make/model/trim/engine/plant). The car is bound to a
   library profile or filed as a new one automatically. If NHTSA is unreachable or can't
   name the model, the **Identify** card appears: scan the bus and let the AI decode it,
   or type the make/model.

## 2. Map it

1. **① Discover & census** (≈ 20-40 s + one AI call). Every responding module appears
   with its part number, supplier and a name/role. This alone is worth saving.
2. **Map** modules one at a time (≈ 3-5 min each, one Opus session per module). Start with
   the ECM, then the module you care about. "Map all" works but costs 12× that.
3. **⚡ Operate** any module: reads are free. *(Superseded 2026-11-23: real cars are
   read-only for now — no clears or any other write; see §5.)*
4. **🧾 Export diagnostic capture** before you unplug — ALWAYS. It saves one JSON
   (`<workspace>/reports/capture-<VIN>-<time>.json`: device health, both buses, raw VIN
   attempts, full discovery with identification strings, OBD baseline, the saved profile).
   That file is what remote troubleshooting works from.

## 3. If something is off

| Symptom | Likely cause | Do |
|---|---|---|
| "Lost connection" flicker | fixed 2026-09-04 (Pi Wi-Fi power save + scan) — if it returns, check `dmesg` on the Pi for `power save enabled` | AS-BUILT §7.3 |
| VIN read fails, RX rate > 0 | ECM not on 7E0/7DF (rare) or gateway blocks OBD until a session | Discover & census anyway — modules still answer 3E; export capture |
| Discovery finds only 7E8 | gateway-isolated body bus (VAG/BMW/Mercedes), or modules on MS-CAN | bring can1 up at 125k (MS-CAN, pins 3/11) and discover there; export capture |
| Modules answer 7F 7F to reads | need extended session — the Operate panel session selector (10 03) | pick "10 03 extended" |
| AI steps stall / "No API key" | key missing, or no internet at the shop | set the key; use phone hotspot |
| NHTSA can't name the model | pre-1981 VIN, non-US import, or typo in the VIN read | Identify card → AI or manual |

## 4. Remote troubleshooting (with Claude Code)

The app and the device are built so a Claude Code session can drive them from the repo
without anyone at the car — everything the app does goes through the Pi's HTTP API:

- **Same network as the Pi (you at the shop, Claude Code on your laptop):** open the repo
  in Claude Code; it can read/probe the bus directly (`/api/vin`, `/api/isotp`,
  `/api/isotp/seq`, `/api/bus/monitor`, `/api/sim/*` on `http://<pi>:8080`), run the
  headless pipeline against the car, fix code, typecheck, and redeploy the daemon
  (`hardware/super-device/webui/deploy.py`). Claude Code Remote Control lets you follow
  and steer that session from your phone.
- **After the fact (you're back home, or offline at the shop):** send the **diagnostic
  capture JSON** (§2.4). It contains the raw responses, so gaps (an unknown address
  layout, a module that refused a session, a wrong census name) can be diagnosed and
  fixed against real data, then verified on the bench sim before the next visit.
- **From anywhere (built 2026-11-21):** the Pi is on the VPN, so its API and SSH are
  reachable from the home PC while it is plugged into a car at the shop (ssh host
  `superdevice`; `superdevice-lan` on the home network). Three tools ride on that
  (AS-BUILT §7.2c):
  - **the command-line runner** — the app's pipeline without the app:
    `pnpm vehicle --host <pi address> run --map <module>` (from the repo root)
    does VIN → NHTSA → discover → census → deep-map one module → capture, records the
    whole visit on the Pi and copies the recording to `<workspace>/recordings/`.
    Single steps: `status`, `vin`, `discover`, `census`, `modules`, `map`, `capture`.
  - **the recorder** — every ISO-TP exchange is kept on the Pi's disk whether or not
    anyone asked (`vehicle … rec list`, `rec fetch`). Back home, `vehicle … sim replay
    <recording id> --on vcan0` turns a visit into a virtual car to develop against.
  - **`deploy.py`** — push a daemon fix by SSH key; it checks the daemon answers after
    the restart and puts the previous files back by itself if it does not.
  Never deploy anything that touches the VPN daemon or the Wi-Fi setup from afar: they
  are the only way in.
- **Working the car live from the home PC (2026-11-21):** you are at the car with the
  laptop, streaming the home PC's screen (Moonlight); the Pi is in the OBD port on the
  shop Wi-Fi; the Claude Code session on the home PC reaches it over the VPN. What that
  session does first, so you know what to expect on screen:
  1. `pnpm vehicle --host <pi address> status` — wants: can0 **UP, ERROR-ACTIVE, rx
     counting**; `Sim not running`; a recorder line. (It warns loudly if a virtual
     vehicle is still running.)
  2. `… run --label "<the car>"` — VIN → NHTSA → discover → census → capture, recorded
     on the Pi and copied home (~1–2 min, one AI call).
  3. `… map <module>` — one module at a time (3–5 min each).
  4. Anything odd: it reads the capture / recording, fixes code, `deploy.py` if the fix
     is in the daemon (the Pi rolls back by itself if the new daemon does not answer).
  To watch the car take shape while that happens, double-click **`START-CHIP-LAB.bat`**
  in the repo on the home PC: it runs the app from source on the SAME library the
  command line writes to, and the Vehicle Cockpit re-reads that library every few seconds
  (a "↻ map updated from outside this window" line appears when something landed). In the
  app use REAL VEHICLE and connect to the Pi's VPN address (listed under Pi Devices) —
  the `.local` name only resolves at home. Let one side drive a module at a time: the
  app and the command line asking the same ECU at the same moment can cross answers.
  Before plugging into the car: **virtual vehicle off, can1↔can0 jumper pulled, can0's
  120 Ω terminator OFF** (§0.3, §1.3), and the UPS showing a battery % (without it there
  is no clean shutdown when the plug is pulled).

## 5. Read-only by default — what the device will and will not do (2026-11-23)

Rule set by Dmytro after the first real car (a customer's 2015 Sprinter): **for now the
lab only READS cars.** Enforced in three places, so no front end can get round it:

- **The Pi's write gate** (`superdevice_ui.py`, `GET /api/write-gate`). Every request that
  can change a module — clear codes (UDS 14 / OBD 04), writes (2E / 3B / 3D), I/O control
  (2F / 30), routines (31 / 32 / 38 / 39), resets (11), downloads (34–37), communication /
  DTC-setting control (28 / 85), security keys (27 even), programming sessions (10 02 / 82 /
  85) and raw frames on a real bus — is refused **before it reaches the bus**, with a
  "write gate: … nothing was sent" message. The airbag safety-system session (10 04 / 84)
  is refused even when armed. The virtual bus (vcan0) is exempt — practising is its point.
  Arming (`POST /api/write-gate/arm`, 5–600 s, one bus + one module, owner + reason,
  logged in the recorder) only works once writes are enabled **on the Pi itself**:
  `/var/lib/superdevice/write-gate.json` → `{"writes_enabled": true}` (root, over SSH or at
  the bench). Nothing over the network can enable writes. Diagnostics shows **READ-ONLY**.
- **Protected modules** (`packages/vehicle-db/src/protectedModules.ts`): airbag / restraint
  systems and immobiliser / ignition-lock / keyless modules are never explored by the AI
  mapper (`map` refuses them; "Map all" skips them). Reading their fault codes in Auto Scan
  stays allowed — that is what every scan tool does.
- **The AI mapper's own gate** (`isReadOnlyRequest` in `moduleExplorer.ts`): reads and normal
  diagnostic sessions only; seed requests (27 odd) allowed, keys never.

**Discovery on a new car:** the first scan of a model also runs the Pi's address sweep
(`POST /api/scan/sweep`, about a minute: wakes the bus with 7DF 01 00, listens, sends only
tester-present on IDs the car does not use, confirms every hit). That is how the Sprinter's
12 Mercedes modules on 6xx/7xx → 4Ex were found. Every later scan re-asks the addresses the
model is known to use. CLI: `discover --deep [--ext]` (29-bit too) / `--no-deep`.

**Long sessions:** watch the car's voltage (OBD 01 42). With the ignition on and the engine
off, the Sprinter fell to 11.5 V in about 30 minutes; the Pi's power guard then shut it down
cleanly and it came back by itself on 12 V. For mapping sessions, run the engine.
