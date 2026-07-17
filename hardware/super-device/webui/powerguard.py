#!/usr/bin/env python3
"""
SuperDevice power-loss guard for the Geekworm X1200 UPS.

Behavior (the §13 Stage-4 contract):
  - External 12 V feed drops (key-off / unplug)  → keep running on the cells,
    start a 30 s countdown.
  - Power returns inside the window              → countdown cancels, nothing
    happens; the drive continues.
  - Window elapses (or the cells go critical)    → clean `shutdown -h now`, so
    the SD/NVMe is never corrupted. The X1200's auto-power-on then boots the
    Pi again when the 12 V feed returns.

Safety when the UPS is NOT mounted: the guard only arms itself when it can see
the X1200 fuel gauge on I²C (0x36), and PLD GPIO6 is configured with a
pull-DOWN so a floating pin reads "power OK". No UPS → the guard just idles.

State is published to /run/superdevice/power.json so the web UI / desktop app
can show "ON BATTERY — shutdown in N s". Runs as root via systemd
(superdevice-power.service).
"""
import json
import os
import subprocess
import time

GRACE_S = 30           # ride-through window after external power is lost
CRITICAL_SOC = 5.0     # % — don't honour the full grace on near-dead cells
STATE_PATH = "/run/superdevice/power.json"


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True)


def _swap16(v):
    return ((v & 0xFF) << 8) | (v >> 8)


def gauge_soc():
    """Battery %, or None when the X1200 fuel gauge isn't reachable (UPS absent)."""
    r = sh("i2cget -y 1 0x36 0x04 w")
    if r.returncode != 0 or not r.stdout.strip():
        return None
    try:
        return min(100.0, round(_swap16(int(r.stdout.strip(), 16)) / 256.0, 1))
    except (ValueError, TypeError):
        return None


def power_lost():
    """X1200 PLD on GPIO6: HIGH = external 5 V feed gone (running on cells)."""
    return "| hi" in sh("pinctrl get 6").stdout


def write_state(obj):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        f.write(json.dumps(obj))
    os.replace(tmp, STATE_PATH)


def main():
    # pull-DOWN: with no UPS stacked the pin floats safe-low ("power OK")
    sh("pinctrl set 6 ip pd")
    deadline = None
    while True:
        soc = gauge_soc()
        if soc is None:
            # No fuel gauge on the bus. Two very different situations:
            #  - PLD low  → no UPS at all (bare Pi): disarm, all quiet.
            #  - PLD high → the X1200 IS here and says "on battery", but its
            #    I²C pogo pins aren't contacting. We can't see the cell level,
            #    so don't auto-shutdown — but shout, because the Pi is
            #    draining cells unmonitored.
            if deadline is not None:
                print("fuel gauge vanished — guard disarmed", flush=True)
            deadline = None
            if power_lost():
                write_state({"state": "ups-degraded"})
            else:
                write_state({"state": "no-ups"})
            time.sleep(5)
            continue

        if power_lost():
            if deadline is None:
                deadline = time.time() + GRACE_S
                print(f"external power LOST — clean shutdown in {GRACE_S}s "
                      f"unless it returns (battery {soc}%)", flush=True)
            left = max(0, int(round(deadline - time.time())))
            if soc <= CRITICAL_SOC and left > 5:
                print(f"battery critical ({soc}%) — shortening grace", flush=True)
                deadline = time.time() + 5
                left = 5
            write_state({"state": "countdown", "seconds_left": left,
                         "grace": GRACE_S, "soc": soc})
            if left <= 0:
                print("grace elapsed — shutting down cleanly NOW", flush=True)
                write_state({"state": "shutting-down", "soc": soc})
                sh("shutdown -h now")
                time.sleep(120)  # nothing more to do; systemd stops us on halt
        else:
            if deadline is not None:
                print("external power RESTORED — countdown cancelled", flush=True)
            deadline = None
            write_state({"state": "ok", "soc": soc})
        time.sleep(1)


if __name__ == "__main__":
    main()
