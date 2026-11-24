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
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import virtual_vehicle as vv

LOCK = threading.Lock()
STATE = {"vehicle_key": "corolla", "vehicle": None, "running": True, "up": {"can0": True, "can1": True},
         "claim": None, "started": time.time(), "frames": 0}
NO_ANSWER_PAUSE = 0.03     # seconds — stands in for the real per-address timeout
CLAIM_TTL = 120


def load(key):
    STATE["vehicle_key"] = key
    STATE["vehicle"] = vv.VEHICLES[key]()
    STATE["running"] = True


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
            if e["resp"] == rx_id and vv.TEMPLATES[e["tpl"]]["obd"]:
                return e
    return None


def exchange(tx_id, rx_id, payload):
    with LOCK:
        e = find_ecu(tx_id, rx_id)
        resp = vv.respond(e, bytes(payload)) if e else None
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
    for cid, period_ms, kind in v["broadcast"]:
        data = vv.frame_payload(kind, now).ljust(8, b"\x00")
        n = max(1, int(dur * 1000 / period_ms))
        frames.append({"id": f"{cid:03X}", "dlc": 8, "bytes": " ".join(f"{b:02X}" for b in data), "count": n, "hz": round(n / dur, 1)})
    frames.sort(key=lambda f: int(f["id"], 16))
    time.sleep(min(dur, 0.25))
    return {"ok": True, "window_ms": int(dur * 1000), "count": len(frames), "frames": frames}


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
    return {"running": on, "vehicle": STATE["vehicle_key"] if on else None, "iface": "can1" if on else None, "replay": None, "pid": None,
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
                        "port": self.server.server_address[1], "features": ["version", "desk-sim"]})
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
        elif u.path == "/api/sim/start":
            key = d.get("vehicle") or STATE["vehicle_key"]
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
    args = ap.parse_args()
    load(args.vehicle)
    v = STATE["vehicle"]
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Desk simulator on http://127.0.0.1:{args.port} — {v['name']}, VIN {v['vin']}, {len(v['ecus'])} ECUs. Ctrl+C to stop.", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
