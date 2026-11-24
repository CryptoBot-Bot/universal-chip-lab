#!/usr/bin/env python3
"""Desk simulator — a stand-in for the Super Device that runs on a PC.

It answers the same HTTP API as the daemon on the Pi (superdevice_ui.py), but
there is no CAN hardware behind it: each diagnostic request is handed straight to
the virtual vehicle's responder (virtual_vehicle.respond — the same code that
plays a car on can1 on the Pi). So the app and the command-line runner can be
developed, demonstrated and tested with the Pi switched off or left at the shop.

    python desk_sim.py                     # 2020 Corolla on http://127.0.0.1:8765
    python desk_sim.py --vehicle f150      # 2018 F-150
    python desk_sim.py --port 8770
    python desk_sim.py --replay 20261123-auto     # a car the Pi recorded, played back
    python desk_sim.py --replay 20261123-183159-2015-Sprinter-3500-diesel 20261123-auto

--replay takes recording ids (looked up in <repo>/.runtime/recordings/*/, where
"pnpm vehicle ... rec fetch" puts them) or paths, several merged into one car. Every module
answers what the real car answered, in the session it was asked in; a request the car
never saw gets no answer. POST /api/sim/start {"replay": "<id>"} switches to one live.

In the app: Diagnostics → device → "Desk simulator" (or connect to 127.0.0.1:8765).
Command line: pnpm vehicle --host 127.0.0.1:8765 run

What is faithful: every ECU's answers, sessions, security, DTC clear/re-set,
negative responses — it is the same responder. What is NOT simulated: bus timing,
ISO-TP framing, bitrate, wiring, a module that is slow to answer. An address with
no ECU answers "no response" after a short pause instead of a real 0.45 s timeout,
so a full discovery takes ~2 s here and ~30 s on a car.
Pure standard library; listens on localhost only.
"""
import argparse
import glob
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import virtual_vehicle as vv

LOCK = threading.Lock()
STATE = {"vehicle_key": "corolla", "vehicle": None, "running": True, "up": {"can0": True, "can1": True},
         "claim": None, "started": time.time(), "frames": 0, "replay": None}
RECORDINGS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".runtime", "recordings")
NO_ANSWER_PAUSE = 0.03     # seconds — stands in for the real per-address timeout
CLAIM_TTL = 120


def load(key):
    STATE["vehicle_key"] = key
    STATE["vehicle"] = vv.VEHICLES[key]()
    STATE["replay"] = None
    STATE["running"] = True


def find_recording(ref):
    if os.path.isfile(ref):
        return ref
    hits = sorted(glob.glob(os.path.join(RECORDINGS, "*", glob.escape(ref) + ".jsonl")))
    return hits[0] if hits else None


def load_replay(refs):
    """One car from one or more recordings: ECUs merged by address pair, answers appended in
    file order (repeated reads cycle through them), broadcast from the first file that has some."""
    paths = []
    for r in refs:
        p = find_recording(r)
        if not p:
            raise ValueError(f"no recording '{r}' (looked in {os.path.normpath(RECORDINGS)})")
        paths.append(p)
    merged = None
    for p in paths:
        v = vv.load_replay(p)
        if merged is None:
            merged = v
            continue
        have = {(e["req"], e["resp"]): e for e in merged["ecus"]}
        for e in v["ecus"]:
            m = have.get((e["req"], e["resp"]))
            if m is None:
                merged["ecus"].append(e)
                have[(e["req"], e["resp"])] = e
                continue
            for tbl in ("table", "any"):
                for k, seq in e[tbl].items():
                    dst = m[tbl].setdefault(k, [])
                    dst.extend(seq[: max(0, vv.REPLAY_MAX_ANSWERS - len(dst))])
        merged["broadcast"] = merged["broadcast"] or v["broadcast"]
        merged["vin"] = merged["vin"] or v["vin"]
    ids = [os.path.basename(p)[:-6] for p in paths]
    merged["name"] = f"replay of {' + '.join(ids)}"
    STATE.update(vehicle_key="replay", vehicle=merged, replay=ids, running=True)
    return merged


def answer(e, payload):
    return vv.replay_respond(e, payload) if "table" in e else vv.respond(e, payload)


def find_ecu(tx_id, rx_id):
    """The ECU a request reaches: its physical address, or — for the OBD functional
    address 7DF / 18DB33F1 — the emissions ECU that answers on rx_id."""
    v = STATE["vehicle"]
    if not (STATE["running"] and v):
        return None
    for e in v["ecus"]:
        if e["req"] == tx_id and e["resp"] == rx_id:
            return e
    if tx_id in (0x7DF, 0x18DB33F1):
        for e in v["ecus"]:
            if e["resp"] == rx_id and ("tpl" not in e or vv.TEMPLATES[e["tpl"]]["obd"]):
                return e
    return None


def exchange(tx_id, rx_id, payload):
    with LOCK:
        e = find_ecu(tx_id, rx_id)
        resp = answer(e, bytes(payload)) if e else None
        STATE["frames"] += 2 if resp else 1
    if resp is None:
        time.sleep(NO_ANSWER_PAUSE)
    return resp


def item(payload, resp):
    if resp is None:
        return {"request": payload.hex(), "ok": False, "error": "TimeoutError: timed out", "response": ""}
    neg = len(resp) >= 3 and resp[0] == 0x7F
    return {"request": payload.hex(), "response": resp.hex(), "ok": not neg, "negative": neg,
            "nrc": (resp[2] if neg else None)}


def isotp(d):
    try:
        tx, rx = int(str(d.get("tx")), 16), int(str(d.get("rx")), 16)
        payload = bytes.fromhex(str(d.get("data") or "").replace(" ", ""))
    except (ValueError, TypeError):
        return {"ok": False, "error": "bad hex (tx/rx/data)"}
    if not payload:
        return {"ok": False, "error": "empty request"}
    resp = exchange(tx, rx, payload)
    if resp is None:
        return {"ok": False, "error": "TimeoutError: timed out", "request": payload.hex()}
    out = item(payload, resp)
    out["sid"] = resp[0]
    return out


def isotp_seq(d):
    try:
        tx, rx = int(str(d.get("tx")), 16), int(str(d.get("rx")), 16)
    except (ValueError, TypeError):
        return {"ok": False, "error": "bad hex (tx/rx)"}
    reqs = d.get("requests")
    if not isinstance(reqs, list) or not reqs:
        return {"ok": False, "error": "no requests"}
    out = []
    for r in reqs[:24]:
        try:
            payload = bytes.fromhex(str(r).replace(" ", ""))
        except (ValueError, TypeError):
            out.append({"request": str(r), "ok": False, "error": "bad hex"})
            continue
        if not payload:
            out.append({"request": "", "ok": False, "error": "empty"})
            continue
        out.append(item(payload, exchange(tx, rx, payload)))
    return {"ok": True, "results": out}


def read_vin():
    tried = []
    for tx, rx, payload, label in ((0x7E0, 0x7E8, b"\x09\x02", "OBD 09 02 physical 7E0"),
                                   (0x7DF, 0x7E8, b"\x09\x02", "OBD 09 02 functional 7DF"),
                                   (0x7E0, 0x7E8, b"\x22\xF1\x90", "UDS 22 F190 on 7E0")):
        resp = exchange(tx, rx, payload)
        if resp and len(resp) > 3 and resp[0] in (0x49, 0x62):
            vin = "".join(chr(b) for b in resp[3:] if 0x20 < b < 0x7F).strip()
            if len(vin) >= 11:
                return {"ok": True, "vin": vin, "raw": resp.hex(), "via": label}
        tried.append(f"{label}: {resp.hex() if resp else 'TimeoutError'}")
    return {"ok": False, "error": "no VIN from the ECM (the desk simulator's vehicle is powered off — POST /api/sim/start)", "tried": tried}


def bus_monitor(ms):
    v = STATE["vehicle"]
    if not (STATE["running"] and v):
        return {"ok": True, "window_ms": ms, "count": 0, "frames": []}
    now = time.time() - STATE["started"]
    dur = max(0.1, min(ms / 1000.0, 3.0))
    frames = []
    for b in v["broadcast"]:
        if STATE["replay"]:          # a recording: (id, hz, last bytes)
            cid, hz, data = b
            n = max(1, int(dur * hz))
        else:                        # a built-in car: (id, period_ms, kind)
            cid, period_ms, kind = b
            data = vv.frame_payload(kind, now)
            n = max(1, int(dur * 1000 / period_ms))
        data = bytes(data).ljust(8, b"\x00")
        text = f"{cid & 0x1FFFFFFF:08X}" if cid & 0x80000000 else f"{cid:03X}"
        frames.append({"id": text, "dlc": 8, "bytes": " ".join(f"{x:02X}" for x in data), "count": n, "hz": round(n / dur, 1)})
    frames.sort(key=lambda f: int(f["id"], 16))
    time.sleep(min(dur, 0.25))
    return {"ok": True, "window_ms": int(dur * 1000), "count": len(frames), "frames": frames}


def sweep(d):
    """The daemon's /api/scan/sweep, against the virtual car: tester-present to every request
    id in the range, 3E 00 then 3E 01 (KWP), every answer counted."""
    try:
        lo, hi = max(0x500, int(d.get("lo", 0x600))), min(0x7FF, int(d.get("hi", 0x7FF)))
    except (TypeError, ValueError):
        return {"ok": False, "error": "bad range"}
    hits, probed, t0 = [], 0, time.time()
    with LOCK:
        v = STATE["vehicle"] if STATE["running"] else None
        for req in range(lo, hi + 1):
            if req == 0x7DF or 0x7E0 <= req <= 0x7EF:
                continue
            probed += 1
            for e in (v["ecus"] if v else []):
                if e["req"] != req:
                    continue
                for tp in (b"\x3e\x00", b"\x3e\x01"):
                    r = answer(e, tp)
                    if r and (r[0] == 0x7E or (len(r) > 1 and r[0] == 0x7F and r[1] == 0x3E)):
                        hits.append({"req": f"{req:03X}", "resp": f"{e['resp']:03X}", "probe": (bytes([len(tp)]) + tp).hex(),
                                     "data": (bytes([len(r)]) + r).hex(), "confirmed": True,
                                     "kind": "uds" if r[0] == 0x7E and tp == b"\x3e\x00" else "kwp"})
                        break
                break
    return {"ok": True, "iface": d.get("iface", "can0"), "range": [f"{lo:03X}", f"{hi:03X}"], "ext": False, "probed": probed,
            "seconds": round(time.time() - t0, 1), "broadcast": {}, "skipped": [], "responders": hits, "unconfirmed": []}


def status():
    return {
        "ifaces": [{"name": n, "present": True, "up": STATE["up"][n], "bitrate": 500000 if STATE["up"][n] else 0, "dbitrate": 0, "fd": False,
                    "canstate": "ERROR-ACTIVE" if STATE["up"][n] else "STOPPED", "rx": STATE["frames"], "tx": STATE["frames"] // 2,
                    "rxerr": 0, "role": "HS-CAN" if n == "can0" else "MS-CAN"} for n in ("can0", "can1")],
        "virtual": [],
        "sys": {"temp": None, "uptime": f"desk simulator, up {int((time.time() - STATE['started']) / 60)} min",
                "model": "Desk simulator (no hardware)", "kernel": "-", "load": "0.00"},
    }


def claim_info():
    c = STATE["claim"]
    if not c or time.time() > c["expires"]:
        return None
    return {"owner": c["owner"], "since": c["since"], "expires_in": max(0, int(c["expires"] - time.time()))}


def sim_status():
    v = STATE["vehicle"]
    on = bool(STATE["running"] and v)
    return {"running": on, "vehicle": STATE["vehicle_key"] if on else None, "iface": "can1" if on else None, "replay": STATE["replay"] if on else None, "pid": None,
            "name": v["name"] if on else None, "ecus": len(v["ecus"]) if on else 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/status":
            self._json(status())
        elif u.path == "/api/device":
            self._json({"hostname": "DeskSim", "ip": "127.0.0.1", "ssid": "", "model": "Desk simulator (no hardware)",
                        "claim": claim_info(), "battery": {"present": False}, "power": None})
        elif u.path == "/api/version":
            self._json({"daemon_sha256": "desk-simulator", "started": STATE["started"], "uptime_s": int(time.time() - STATE["started"]),
                        "port": self.server.server_address[1], "features": ["version", "desk-sim", "replay", "sweep"]})
        elif u.path == "/api/vin":
            self._json(read_vin())
        elif u.path == "/api/sim/status":
            self._json(sim_status())
        elif u.path == "/api/bus/monitor":
            self._json(bus_monitor(int(q.get("ms", ["700"])[0] or 700)))
        elif u.path == "/api/wifi/saved":
            self._json({"networks": []})
        elif u.path == "/":
            self._json({"desk_simulator": True, "vehicle": sim_status()})
        else:
            self._json({"error": "not available on the desk simulator"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        d = self._body()
        if u.path == "/api/isotp":
            self._json(isotp(d))
        elif u.path == "/api/isotp/seq":
            self._json(isotp_seq(d))
        elif u.path == "/api/scan/sweep":
            self._json(sweep(d))
        elif u.path == "/api/up":
            if d.get("iface") in STATE["up"]:
                STATE["up"][d["iface"]] = True
            self._json({"result": "ok"})
        elif u.path == "/api/down":
            if d.get("iface") in STATE["up"]:
                STATE["up"][d["iface"]] = False
            self._json({"result": "ok"})
        elif u.path == "/api/claim":
            owner = (d.get("owner") or "").strip()[:64]
            cur = claim_info()
            if cur and cur["owner"] != owner and not d.get("force"):
                self._json({"ok": False, "error": f"occupied by {cur['owner']}", "occupied_by": cur["owner"]})
                return
            since = STATE["claim"]["since"] if (cur and cur["owner"] == owner) else time.strftime("%Y-%m-%dT%H:%M:%S")
            STATE["claim"] = {"owner": owner, "since": since, "expires": time.time() + CLAIM_TTL}
            self._json({"ok": True, "claim": claim_info()})
        elif u.path == "/api/release":
            STATE["claim"] = None
            self._json({"ok": True})
        elif u.path == "/api/sim/start" and d.get("replay"):
            refs = d["replay"] if isinstance(d["replay"], list) else [d["replay"]]
            try:
                with LOCK:
                    load_replay([str(r) for r in refs])
            except (ValueError, OSError) as ex:
                self._json({"ok": False, "error": str(ex)})
                return
            self._json({**sim_status(), "ok": True, "bus": "ok"})
        elif u.path == "/api/sim/start":
            key = d.get("vehicle") or STATE["vehicle_key"]
            if key == "replay":
                key = "corolla"
            if key not in vv.VEHICLES:
                self._json({"ok": False, "error": f"unknown vehicle '{key}' (have: {', '.join(vv.VEHICLES)})"})
                return
            with LOCK:
                load(key)
            self._json({**sim_status(), "ok": True, "bus": "ok"})
        elif u.path == "/api/sim/stop":
            STATE["running"] = False
            self._json({"ok": True})
        else:
            self._json({"error": "not available on the desk simulator"}, 404)


def main():
    ap = argparse.ArgumentParser(description="Desk simulator: the Super Device's HTTP API with a virtual vehicle behind it, no hardware.")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--vehicle", default="corolla", choices=list(vv.VEHICLES))
    ap.add_argument("--replay", nargs="+", metavar="RECORDING", help="play back recording id(s) or path(s) instead of a built-in car")
    args = ap.parse_args()
    if args.replay:
        load_replay(args.replay)
    else:
        load(args.vehicle)
    v = STATE["vehicle"]
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Desk simulator on http://127.0.0.1:{args.port} — {v['name']}, VIN {v['vin'] or '(none recorded)'}, {len(v['ecus'])} ECUs. Ctrl+C to stop.", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
