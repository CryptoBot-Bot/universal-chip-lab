# Shop-day checklist — first real vehicle with the SuperDevice

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
3. **⚡ Operate** any module: reads are free; every write confirms first. Clear DTCs is the
   safe first write to try on a real car; security seed/key needs the OEM algorithm.
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
- **Next step for true remote access to the car** (not built yet): a reverse tunnel from
  the Pi to a relay (e.g. Tailscale on the Pi) so the Pi's API is reachable from home while
  the device is plugged into a car at the shop. The daemon already exposes everything over
  HTTP, so that is a networking change, not an app change.
