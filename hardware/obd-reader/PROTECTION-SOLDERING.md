# Power Protection — Solder It Slowly, Learn It Once

This is the *teaching* guide for the protection section of the OBD reader. Take it
one step at a time. After **every** step there's a **✅ STOP & CHECK** — do not
move on until it passes. By the end you'll understand DC input protection well
enough to design it for any future board, not just this one.

> Pair this with `BUILD.md` (the reference). This file is the *how and why*.

---

## Part 1 — The principle (read this first, don't solder yet)

A protection front-end is a **one-way, self-limiting gate** between dirty power
and your fragile electronics. Three threats come down a car's 12 V wire, and there
is exactly **one guard for each**:

| Threat | What it does | The guard | How the guard works |
| --- | --- | --- | --- |
| **Too much current** (a short downstream) | melts wires, starts fires | **F1 — fuse** | a wire that's *designed* to melt first, opening the circuit |
| **Reversed polarity** (leads swapped) | instantly kills chips | **D1 — series Schottky** | a one-way valve: passes + power, blocks − power |
| **Voltage spikes** (load dump → 40 V+) | punches through silicon | **D2 — TVS clamp** | a pressure-relief valve to ground: opens only above a set voltage |

Then there's a **second, smaller gate** just for the battery-sense pin, because the
Pico's ADC can only tolerate **3.3 V**:

| Job | Part | How |
| --- | --- | --- |
| Scale 12 V down into ADC range | **R1 + R2** divider | two resistors split the voltage by ratio |
| Smooth noise | **C1** | a small tank that absorbs fast wiggles |
| Hard-clamp at 3.3 V | **D3 — Zener** | a valve that dumps anything over 3.3 V to ground |

**The mental model to keep forever:** *fuse for current, series diode for polarity,
TVS for spikes — then divide, filter, clamp before anything sensitive.* That order
is the same on every board you'll ever protect. This is your
"reverse-polarity-on-the-M95" lesson, made permanent.

### The map (what connects to what)
```
 OBD-16 (+12V) ──[F1 fuse]──● node A ●──[D1 ▷|]──► to LM2596 IN+   (protected +12V)
                            │      │
                       [D2 ▽|]   [R1 47k]
                       (to GND)    │
                            │      ●─ ADC node ─► Pico GP28
                            │      ├──[R2 10k]──► GND
                            │      ├──[C1]──────► GND
                            │      └──[D3 ▽|]───► GND   (band toward ADC node)
                           GND ◄── OBD-5
```
- **node A** = right after the fuse. Everything branches from here.
- The little **▷| / ▽|** marks show the **band (cathode)** side of each diode.
  *Getting these backwards is the #1 way to fry a board — we'll check each one.*

**✅ STOP & CHECK (understanding):** before touching the iron, say out loud which
part guards against which threat. If you can't, re-read the tables. That's the
whole point of this build.

---

## Part 2 — Know your parts & how to read polarity

Three of your parts are **polarized** (they have a direction). Two are not.

| Part | Polarized? | The marked end is the… | Where the mark goes |
| --- | --- | --- | --- |
| **D1 1N5822** (Schottky, axial) | YES | **stripe = cathode** | stripe points **downstream** (toward LM2596) |
| **D2 SMBJ24A** (TVS, SMD) | YES | **bar/notch = cathode** | cathode toward **+12 V** (node A), body to GND |
| **D3 1N4728A** (Zener, axial) | YES | **stripe = cathode** | stripe toward the **ADC node** |
| **R1, R2** (resistors) | no | — | either way is fine |
| **C1** (100 nF ceramic) | no | — | either way is fine |

> **Anode vs cathode in one sentence:** current flows *into* the anode and *out of*
> the cathode (the striped end), the way the arrow in the ▷| symbol points.

### Bench-test each diode BEFORE soldering (2 minutes, saves hours)
Set your multimeter to **diode mode** (the ▷| symbol).
- Touch **red → plain end (anode)**, **black → striped end (cathode)**:
  - **1N5822:** shows **~0.2–0.4 V** (it conducts forward). ✔
  - **1N4728A:** shows **~0.7 V**. ✔
  - **SMBJ24A:** shows **~0.7–0.9 V**. ✔
- Now **swap the probes** (red on the stripe): all three should read **OL** (open). ✔

If forward/reverse behave as above, the part is good **and** you've confirmed which
end is the stripe. Mark it with a dot of marker if it helps.

**✅ STOP & CHECK:** all three diodes pass the forward/reverse test. A part that
conducts both ways is dead — set it aside.

---

## Part 3 — Tools & safety

- **Iron** ~330–350 °C, clean tinned tip. **Flux** helps everything flow.
- **ESD:** wrist strap on, like always (you have the mat). Handle the Pico last.
- **Helping hands / vise** to hold the board so both your hands are free.
- **Multimeter** within reach — you'll use it after every step.
- Build the protection on a **small piece of perfboard** as its own little module
  (pigtail wires in and out). It's cleaner, inspectable, and reworkable — much
  better for *learning* than free-air blobs. (Inline-on-the-wire also works once
  you're confident.)

---

## Part 4 — Lay it out first (no soldering yet)
Place the parts on the perfboard **without soldering** and confirm the nodes line
up. Leave 2–3 empty holes between nodes so nothing accidentally bridges.

Rough layout (left = input, right = output):
```
  [OBD+12 wire] → [FUSE holder] → ● node A ● → [D1 ▷|] → [protected+12 wire → LM2596]
                                   │
                                  [D2 ▽|] → [GND rail]
                                   │
                                  [R1] → ● ADC node ● → [ADC wire → GP28]
                                          ├ [R2] → GND rail
                                          ├ [C1] → GND rail
                                          └ [D3 ▽|] → GND rail
```
Pick one row of holes to be your **GND rail** and one node to be **node A**. Dry-fit
everything to those.

**✅ STOP & CHECK:** parts physically reach their nodes with slack to spare, and the
diode stripes all point the way the map shows. Photograph it — that's your wiring
reference.

---

## Part 5 — Solder, one part at a time

> Rule for the whole section: **solder → inspect the joint (shiny, volcano-shaped,
> not a ball) → multimeter check → only then the next part.**

### Step 1 — The GND rail
Run a bare wire (or solder-bridge a row) as your common ground rail. Solder the
**OBD-5 (GND)** pigtail to it.
**✅ CHECK:** continuity (beep) along the whole rail end to end.

### Step 2 — F1 fuse holder
Solder the fuse holder so the **OBD-16 (+12 V)** pigtail enters one side and **node
A** is the other side. Put the **1 A fuse in**.
**✅ CHECK:** continuity from OBD-16 pigtail → through fuse → node A (beep). Pull the
fuse → beep stops. Put it back.

### Step 3 — D1 Schottky (1N5822) — *mind the stripe*
Anode (plain end) to **node A**; **stripe (cathode) to the protected-+12 output**
that will go to LM2596 IN+. Solder both legs, trim.
**✅ CHECK (diode mode):** red on node A, black on the output → ~0.3 V. Swap → OL.
That OL is your **reverse-polarity protection proving itself** — backwards power
simply can't pass.

### Step 4 — D2 TVS (SMBJ24A) — the SMD one
This is surface-mount, so go gentle:
1. **Tin one pad** at node A (melt a little solder onto it).
2. Hold the TVS with tweezers, **cathode (bar) toward node A / +12 V**, body toward
   the GND rail. Re-melt the tinned pad and slide the part in; let it set.
3. Solder the **other end to the GND rail**. Reflow the first end once more.

(If mounting SMD on perfboard is fiddly, solder two short wire tails to the TVS
first, then treat those tails like normal legs.)

**✅ CHECK (diode mode):** red on node A (+12 side), black on GND → OL (it blocks
normal voltage — correct; it only opens during a big spike). Swap probes → ~0.7 V.
**Also:** continuity between +12 and GND should be **OL / no beep** (no short).

### Step 5 — R1 + R2 divider (not polarized)
- **R1 (47 k):** node A → **ADC node**.
- **R2 (10 k):** ADC node → GND rail.
**✅ CHECK (resistance mode, power OFF):** from ADC node to GND you should read
**~8.5 kΩ** (10 k ∥ 47 k). From node A to ADC node ≈ **47 k**. Numbers in range =
divider is correct.

### Step 6 — C1 (100 nF, not polarized)
ADC node → GND rail, right next to R2.
**✅ CHECK:** no new short — ADC-node-to-GND still reads ~8.5 kΩ (the cap is open to
DC, so it doesn't change the reading).

### Step 7 — D3 Zener (1N4728A) — *mind the stripe*
**Stripe (cathode) to the ADC node**, plain end to GND rail.
**✅ CHECK (diode mode):** red on ADC node, black on GND → ~0.7 V; swap → OL. (We'll
prove the 3.3 V clamp under power next.)

### Step 8 — Output pigtails
Solder the **protected-+12** wire (D1 cathode) and the **ADC** wire (ADC node) out
to where they'll meet LM2596 IN+ and Pico GP28. **Don't connect the Pico yet.**

---

## Part 6 — Final inspection BEFORE any power
Eyes + meter, no power:
1. **Look:** every joint shiny and distinct, no solder bridges between adjacent
   holes, no stray whiskers. Magnify if you can.
2. **The one test that matters most — short check:** meter in continuity, probes on
   **+12 input ↔ GND**. It must be **OL / no beep.** A beep here means a short —
   find and fix it before power. (D1 and the TVS both block, so DC should not pass.)
3. **Polarity re-confirm:** all three stripes match the map (D1 → downstream,
   D2 → +12, D3 → ADC node).

**✅ STOP & CHECK:** no shorts, all polarities correct. Only now do we power it.

---

## Part 7 — First power-up (the smoke test, done safely)
Use your **bench supply**, not the car. The supply is your safety net.
1. Set the supply to **12.0 V** and **current limit ~100 mA**. This limit means a
   mistake *can't* deliver enough current to burn anything — it'll just fold back.
2. Connect supply **+ to OBD-16 input**, **− to GND**. Watch the current: it should
   be **nearly 0 mA** (nothing downstream is connected yet). If it slams into the
   limit → power off, there's a short → back to Part 6.
3. **Measure (black probe on GND):**
   | Point | Expected | Meaning |
   | --- | --- | --- |
   | node A | ~12.0 V | fuse + input good |
   | D1 cathode (protected +12) | ~**11.6 V** | the ~0.4 V drop = the Schottky doing its job |
   | ADC node | ~**2.1 V** | divider: 12 × 10 / 57. *This is what GP28 will read.* |

If those three match, **your protection works.** 🎉

### Prove the guards (optional but this is where it *clicks*)
- **Reverse-polarity test:** power off. Swap the supply leads (+ to GND, − to
  input). Power on. The protected-+12 output should stay **~0 V** and current stays
  low — **D1 blocked it.** This is the exact event that kills unprotected boards;
  yours shrugs. Restore correct polarity after.
- **ADC clamp test:** slowly raise the supply from 12 → ~18 V while watching the
  **ADC node**. It tracks up (2.1 → ~3.1 V) then **stops climbing near 3.3 V** —
  that's D3 clamping, protecting GP28. Don't dwell at high voltage; drop back to 12.
- *(Load-dump/TVS clamp needs >24 V to demonstrate and stresses the part — skip it
  on the bench; trust the diode-mode test from Step 4.)*

---

## Part 8 — Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Current slams to limit at power-on | short (bridge, or a diode in backwards) | power off; redo Part 6 short check; verify D1/D2 stripes |
| Protected +12 reads ~0 V (correct polarity) | D1 in backwards | desolder, flip so stripe faces downstream |
| ADC node ≈ node A (no division) | R2 open / not soldered | reflow R2 to GND |
| ADC node ≈ 0 V | R1 open, or ADC node shorted to GND | check R1 joint; check for bridge |
| No power past the fuse | fuse blown or holder joint cold | swap fuse; reflow holder |
| ADC node never clamps, keeps rising | D3 backwards or not connected | stripe must face the ADC node |

---

## Part 9 — Say it back (so it sticks)
Before you close the lid, recite the principle one more time:

> **Fuse** stops too much *current*. **Series Schottky** stops *reversed* power.
> **TVS** stops *spikes*. Then **divide, filter, clamp** before the ADC.

That four-beat sentence is the whole discipline of DC input protection. Every board
you protect from now on is just this pattern, resized. You've now soldered it and
*watched each guard work* — that's how it becomes permanent.

**Next:** once this passes, follow `BUILD.md` → **set the LM2596 to 5.1 V with the
meter BEFORE connecting the Pico** (the other load-bearing rule), then wire the
protected-+12 to the buck and the ADC node to GP28.
