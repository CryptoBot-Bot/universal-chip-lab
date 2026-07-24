#!/usr/bin/env python3
"""
SuperDevice Control Panel — a self-contained web UI for the Raspberry Pi 5 +
2-CH Isolated CAN-FD HAT. Pure Python standard library (no pip deps). Serves a
dashboard that shows both SocketCAN interfaces, brings them up/down at any
bitrate (classic or CAN-FD), streams live bus traffic, and sends frames.

Runs as root (via systemd) so it can drive `ip`/`cansend` directly.
Open from the laptop at:  http://superdevice.local:8080
"""
import json, os, re, shlex, subprocess, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = 8080
IFACES = ("can0", "can1")
HEXID = re.compile(r"^[0-9A-Fa-f]{1,8}$")
HEXDATA = re.compile(r"^[0-9A-Fa-f]{0,128}$")


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True)


def status():
    out = {"ifaces": [], "sys": {}}
    try:
        data = json.loads(sh("ip -j -d -s link show").stdout)
    except Exception:
        data = []
    seen = {d.get("ifname"): d for d in data}
    for name in IFACES:
        d = seen.get(name)
        if not d:
            out["ifaces"].append({"name": name, "present": False})
            continue
        flags = d.get("flags", [])
        info = (d.get("linkinfo", {}) or {}).get("info_data", {}) or {}
        bt = info.get("bittiming", {}) or {}
        dbt = info.get("dbittiming", {}) or {}
        ctrl = info.get("ctrlmode", []) or []
        st = d.get("stats64", {}) or {}
        rx = (st.get("rx", {}) or {})
        tx = (st.get("tx", {}) or {})
        out["ifaces"].append({
            "name": name, "present": True,
            "up": "UP" in flags,
            "bitrate": bt.get("bitrate", 0),
            "dbitrate": dbt.get("bitrate", 0),
            "fd": "FD" in ctrl,
            "canstate": info.get("state", ""),
            "rx": rx.get("packets", 0), "tx": tx.get("packets", 0),
            "rxerr": rx.get("errors", 0) + rx.get("dropped", 0),
            "role": "HS-CAN" if name == "can0" else "MS-CAN",
        })
    sysinfo = out["sys"]
    try:
        sysinfo["temp"] = round(int(open("/sys/class/thermal/thermal_zone0/temp").read()) / 1000, 1)
    except Exception:
        sysinfo["temp"] = None
    sysinfo["uptime"] = sh("uptime -p").stdout.strip()
    try:
        sysinfo["model"] = open("/proc/device-tree/model").read().strip("\x00")
    except Exception:
        sysinfo["model"] = "Raspberry Pi"
    sysinfo["kernel"] = sh("uname -r").stdout.strip()
    try:
        sysinfo["load"] = open("/proc/loadavg").read().split()[0]
    except Exception:
        sysinfo["load"] = "?"
    return out


def iface_up(iface, bitrate, dbitrate, fd):
    if iface not in IFACES:
        return "bad iface"
    sh(f"ip link set {iface} down")
    # loopback off is explicit: the ctrlmode persists across down/up, so without it a
    # prior self-test can leave the iface internally looped (no real bus traffic).
    cmd = f"ip link set {iface} up type can bitrate {int(bitrate)} loopback off restart-ms 100"
    if fd:
        cmd += f" dbitrate {int(dbitrate)} fd on"
    return sh(cmd).stderr.strip() or "ok"


def iface_down(iface):
    if iface not in IFACES:
        return "bad iface"
    return sh(f"ip link set {iface} down").stderr.strip() or "ok"


def send_frame(iface, cid, data):
    if iface not in IFACES or not HEXID.match(cid or "") or not HEXDATA.match(data or ""):
        return "bad frame"
    if len(data) % 2:
        return "data must be whole bytes"
    return sh(f"cansend {iface} {cid}#{data}").stderr.strip() or "sent"


def _ensure_up(iface, bitrate=500000):
    st = sh(f"ip -br link show {iface}").stdout
    if " UP " not in f" {st} " and "UP" not in st.split()[1:2]:
        sh(f"ip link set {iface} up type can bitrate {bitrate} loopback off restart-ms 100")


def _isotp_socket(iface, tx_id, rx_id, timeout):
    """Open a padded ISO-TP socket. TX/RX padding to 8 bytes is enabled — many
    modules (Nissan/Infiniti, Toyota, etc.) silently ignore short/unpadded single
    frames, so padding is required for them to answer; it's harmless otherwise."""
    import socket as _s
    import struct as _st
    CAN_ISOTP = getattr(_s, "CAN_ISOTP", 6)
    _ensure_up(iface)
    sh("modprobe can_isotp")
    sock = _s.socket(_s.AF_CAN, _s.SOCK_DGRAM, CAN_ISOTP)
    # struct can_isotp_options: flags(u32) frame_txtime(u32) ext_addr(u8) txpad(u8) rxpad(u8) rx_ext(u8)
    SOL_CAN_ISOTP, CAN_ISOTP_OPTS = 106, 1
    CAN_ISOTP_TX_PADDING, CAN_ISOTP_RX_PADDING = 0x004, 0x008
    try:
        opts = _st.pack("=IIBBBB", CAN_ISOTP_TX_PADDING | CAN_ISOTP_RX_PADDING, 0, 0, 0x00, 0x00, 0)
        sock.setsockopt(SOL_CAN_ISOTP, CAN_ISOTP_OPTS, opts)
    except OSError:
        pass  # padding unsupported on this kernel — fall back to unpadded
    sock.settimeout(timeout)
    sock.bind((iface, rx_id, tx_id))   # (interface, rx_id, tx_id)
    return sock


def isotp_request(iface, tx_id, rx_id, payload, timeout=2.0):
    """One ISO-TP request/response (kernel can_isotp handles multi-frame + flow control)."""
    sock = _isotp_socket(iface, tx_id, rx_id, timeout)
    try:
        sock.send(bytes(payload))
        return sock.recv(4095)
    finally:
        sock.close()


def bus_monitor(iface, ms=700):
    """Sniff the bus for a short window and aggregate per CAN id: latest bytes,
    frame count and rate. Powers the live per-id bus view (polled) and the AI
    explorer's bus-read tool. Read-only."""
    if iface not in IFACES:
        return {"ok": False, "error": "bad iface"}
    _ensure_up(iface)
    try:
        dur = max(0.1, min(float(ms) / 1000.0, 3.0))
    except (ValueError, TypeError):
        dur = 0.7
    try:
        r = subprocess.run(["timeout", f"{dur}", "candump", iface],
                           capture_output=True, text=True, timeout=dur + 2)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    frames = {}
    for line in r.stdout.splitlines():
        parts = line.split()
        # default candump: "  can0  174   [8]  FF E7 D4 AA ..." -> [iface, id, [dlc], b0..]
        if len(parts) < 3 or parts[0] != iface:
            continue
        cid = parts[1]
        try:
            dlc = int(parts[2].strip("[]"))
        except ValueError:
            continue
        data = parts[3:3 + dlc]
        f = frames.setdefault(cid, {"id": cid, "dlc": dlc, "bytes": "", "count": 0})
        f["bytes"] = " ".join(data)
        f["dlc"] = dlc
        f["count"] += 1
    out = []
    for f in frames.values():
        f["hz"] = round(f["count"] / dur, 1)
        out.append(f)
    out.sort(key=lambda x: int(x["id"], 16))
    return {"ok": True, "window_ms": int(dur * 1000), "count": len(out), "frames": out}


def read_vin(iface="can0"):
    """Real OBD-II VIN read: mode 09 PID 02 to the ECM (7E0), response from 7E8."""
    if iface not in IFACES:
        return {"ok": False, "error": "bad iface"}
    try:
        data = isotp_request(iface, 0x7E0, 0x7E8, [0x09, 0x02], timeout=2.5)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    raw = data.hex() if data else ""
    # positive response: 49 02 <count> <17 ASCII VIN bytes>
    if len(data) >= 4 and data[0] == 0x49 and data[1] == 0x02:
        vin = data[3:].decode("ascii", "ignore").replace("\x00", "").strip()
        if len(vin) >= 11:
            return {"ok": True, "vin": vin, "raw": raw}
    return {"ok": False, "error": "no VIN in response (ignition on? ECM present?)", "raw": raw}


def isotp_http(iface, tx_hex, rx_hex, data_hex, timeout=2.0):
    """Generic diagnostic request over ISO-TP for the Bench Module Master.
    tx_hex/rx_hex = diagnostic ids (e.g. "7E1"/"7E9"); data_hex = the raw service
    payload (e.g. "1081" or "22 F1 90"). Returns the raw response hex + the first
    byte so the app can tell a positive response (0x40+SID) from a negative (0x7F)."""
    if iface not in IFACES:
        return {"ok": False, "error": "bad iface"}
    try:
        tx_id = int(str(tx_hex), 16)
        rx_id = int(str(rx_hex), 16)
        payload = bytes.fromhex((data_hex or "").replace(" ", ""))
    except (ValueError, TypeError):
        return {"ok": False, "error": "bad hex (tx/rx/data)"}
    if not payload:
        return {"ok": False, "error": "empty request"}
    try:
        t = float(timeout)
    except (ValueError, TypeError):
        t = 2.0
    t = max(0.2, min(t, 8.0))
    try:
        data = isotp_request(iface, tx_id, rx_id, list(payload), timeout=t)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "request": payload.hex()}
    raw = data.hex() if data else ""
    if not data:
        return {"ok": False, "error": "no response (module powered/ignition on? right ids/speed? bus terminated?)", "request": payload.hex()}
    negative = len(data) >= 3 and data[0] == 0x7F
    return {
        "ok": not negative,
        "request": payload.hex(),
        "response": raw,
        "sid": data[0],
        "negative": negative,
        "nrc": (data[2] if negative and len(data) >= 3 else None),
    }


def isotp_seq(iface, tx_hex, rx_hex, requests, timeout=2.0):
    """Run a SEQUENCE of ISO-TP requests over ONE socket so a diagnostic session
    persists across them (needed for session-gated reads like live-data blocks).
    `requests` is a list of hex payload strings. Returns a list of per-request
    results in order."""
    if iface not in IFACES:
        return {"ok": False, "error": "bad iface"}
    try:
        tx_id = int(str(tx_hex), 16)
        rx_id = int(str(rx_hex), 16)
    except (ValueError, TypeError):
        return {"ok": False, "error": "bad hex (tx/rx)"}
    if not isinstance(requests, list) or not requests:
        return {"ok": False, "error": "no requests"}
    try:
        t = max(0.2, min(float(timeout), 8.0))
    except (ValueError, TypeError):
        t = 2.0
    try:
        sock = _isotp_socket(iface, tx_id, rx_id, t)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    out = []
    try:
        for r in requests[:24]:
            try:
                payload = bytes.fromhex(str(r).replace(" ", ""))
            except (ValueError, TypeError):
                out.append({"request": str(r), "ok": False, "error": "bad hex"}); continue
            if not payload:
                out.append({"request": "", "ok": False, "error": "empty"}); continue
            try:
                sock.send(payload)
                data = sock.recv(4095)
            except Exception as e:
                out.append({"request": payload.hex(), "ok": False, "error": f"{type(e).__name__}: {e}", "response": ""}); continue
            resp = data.hex() if data else ""
            negative = len(data) >= 3 and data[0] == 0x7F
            out.append({
                "request": payload.hex(), "response": resp,
                "ok": bool(data) and not negative, "negative": negative,
                "nrc": (data[2] if negative and len(data) >= 3 else None),
            })
    finally:
        sock.close()
    return {"ok": True, "results": out}


# ---- occupancy claim (which PC "owns" this device right now) ----------------
# A claim is a soft lock so two laptops don't drive the same buses at once.
# The owning PC renews it (heartbeat); a stale claim expires on its own, so a
# crashed laptop can never brick the device into "occupied" forever.

CLAIM_PATH = "/run/superdevice/claim.json"
CLAIM_TTL = 120  # seconds between heartbeats before a claim goes stale


def _claim_read():
    try:
        c = json.loads(open(CLAIM_PATH).read())
        if time.time() > float(c.get("expires", 0)):
            return None
        return c
    except Exception:
        return None


def claim_info():
    c = _claim_read()
    if not c:
        return None
    return {
        "owner": c.get("owner", "?"),
        "since": c.get("since", ""),
        "expires_in": max(0, int(float(c.get("expires", 0)) - time.time())),
    }


def claim_acquire(owner, force=False):
    owner = (owner or "").strip()[:64]
    if not owner:
        return {"ok": False, "error": "no owner"}
    c = _claim_read()
    if c and c.get("owner") != owner and not force:
        return {"ok": False, "error": f"occupied by {c.get('owner')}", "occupied_by": c.get("owner")}
    since = c.get("since") if (c and c.get("owner") == owner) else time.strftime("%Y-%m-%dT%H:%M:%S")
    rec = {"owner": owner, "since": since, "expires": time.time() + CLAIM_TTL}
    try:
        os.makedirs(os.path.dirname(CLAIM_PATH), exist_ok=True)
        with open(CLAIM_PATH, "w") as f:
            f.write(json.dumps(rec))
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "claim": claim_info()}


def claim_release(owner, force=False):
    c = _claim_read()
    if c and c.get("owner") != (owner or "").strip()[:64] and not force:
        return {"ok": False, "error": f"occupied by {c.get('owner')}", "occupied_by": c.get("owner")}
    try:
        os.remove(CLAIM_PATH)
    except FileNotFoundError:
        pass
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True}


# ---- device management (identity + network + battery) -----------------------

def _swap16(v):
    return ((v & 0xFF) << 8) | (v >> 8)


def battery_info():
    """Geekworm X1200 UPS fuel gauge (MAX17040-class, I2C addr 0x36). Registers
    are big-endian; i2cget word reads are little-endian, hence the byte swap.
    Best-effort: returns present=False on a Pi without the UPS HAT."""
    r = sh("i2cget -y 1 0x36 0x02 w")
    if r.returncode != 0 or not r.stdout.strip():
        return {"present": False}
    try:
        vcell = _swap16(int(r.stdout.strip(), 16))
        soc = _swap16(int(sh("i2cget -y 1 0x36 0x04 w").stdout.strip(), 16))
    except (ValueError, TypeError):
        return {"present": False}
    out = {
        "present": True,
        "voltage": round((vcell >> 4) * 1.25 / 1000.0, 2),
        "percent": min(100.0, round(soc / 256.0, 1)),
    }
    # X1200 PLD on GPIO6 — polarity bench-verified 2026-07-23 on this unit:
    # HIGH = external feed present, LOW = running on cells.
    sh("pinctrl set 6 ip pu")  # input + pull-up: floats safe-high when no UPS
    p = sh("pinctrl get 6").stdout
    if "| lo" in p or "| hi" in p:
        out["external_power"] = "| hi" in p
    return out


def power_guard_state():
    """State published by powerguard.py (superdevice-power.service): 'ok',
    'countdown' (+seconds_left), 'shutting-down', or 'no-ups'. None if the
    guard service isn't running on this Pi."""
    try:
        st = json.loads(open("/run/superdevice/power.json").read())
        return st if isinstance(st, dict) else None
    except Exception:
        return None


def device_info():
    ip = sh("hostname -I").stdout.strip().split()
    ssid = sh("nmcli -t -f active,ssid dev wifi 2>/dev/null | grep '^yes' | cut -d: -f2").stdout.strip()
    model = ""
    try:
        model = open("/proc/device-tree/model").read().strip("\x00")
    except Exception:
        pass
    return {
        "hostname": sh("hostname").stdout.strip(),
        "ip": ip[0] if ip else "",
        "ssid": ssid,
        "model": model,
        "claim": claim_info(),
        "battery": battery_info(),
        "power": power_guard_state(),
    }


def _parse_wifi_lines(text, nets):
    for line in text.splitlines():
        p = line.split(":")
        if len(p) >= 2 and p[0].strip():
            ssid = p[0]
            sig = int(p[1]) if p[1].isdigit() else 0
            sec = (p[2] if len(p) > 2 else "").strip()
            if ssid not in nets or sig > nets[ssid]["signal"]:
                nets[ssid] = {"ssid": ssid, "signal": sig, "secure": bool(sec)}


def wifi_scan():
    sh("nmcli dev wifi rescan 2>/dev/null")
    nets = {}
    _parse_wifi_lines(sh("nmcli -t -f SSID,SIGNAL,SECURITY dev wifi 2>/dev/null").stdout, nets)
    if not nets:  # in AP mode a single radio can't scan — use the cache ap.sh wrote
        try:
            _parse_wifi_lines(open("/run/superdevice/wifi-cache").read(), nets)
        except Exception:
            pass
    return {"networks": sorted(nets.values(), key=lambda n: -n["signal"])}


def wifi_saved():
    """Every WiFi network this Pi remembers (NetworkManager saved connections),
    with which one is active right now and whether it auto-connects."""
    active = set(sh("nmcli -t -f NAME connection show --active").stdout.strip().splitlines())
    nets = []
    for line in sh("nmcli -t -f NAME,TYPE,AUTOCONNECT connection show").stdout.splitlines():
        p = line.split(":")
        if len(p) >= 2 and "wireless" in p[1]:
            nets.append({
                "name": p[0],
                "autoconnect": (p[2] if len(p) > 2 else "") == "yes",
                "active": p[0] in active,
            })
    nets.sort(key=lambda n: (not n["active"], n["name"].lower()))
    return {"networks": nets}


def wifi_forget(name):
    if not name:
        return {"ok": False, "error": "no name"}
    r = sh(f"nmcli connection delete {shlex.quote(name)}")
    ok = r.returncode == 0
    return {"ok": ok, "error": "" if ok else (r.stderr.strip() or r.stdout.strip())}


def wifi_set(ssid, password):
    if not ssid:
        return {"ok": False, "error": "no SSID"}
    cmd = f"nmcli dev wifi connect {shlex.quote(ssid)}"
    if password:
        cmd += f" password {shlex.quote(password)}"
    r = sh(cmd)
    ok = r.returncode == 0
    return {"ok": ok, "error": "" if ok else (r.stderr.strip() or r.stdout.strip())}


def set_hostname(name):
    if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9-]{0,30}$", name or ""):
        return {"ok": False, "error": "invalid hostname (letters, digits, hyphen; max 31)"}
    sh(f"hostnamectl set-hostname {shlex.quote(name)}")
    sh(f"sed -i 's/^127.0.1.1.*/127.0.1.1\\t{name}/' /etc/hosts")
    sh("systemctl restart avahi-daemon 2>/dev/null")
    return {"ok": True, "hostname": name, "note": f"reachable as {name}.local (reboot if it lags)"}


def reboot_device():
    subprocess.Popen(["bash", "-c", "sleep 1; reboot"])
    return {"ok": True, "rebooting": True}


def _ap_ssid():
    return sh("/opt/superdevice/ap.sh ssid").stdout.strip() or "SuperDevice-Setup"


def net_status():
    iface = "wlan0"
    state, name = "", ""
    for line in sh("nmcli -t -f DEVICE,STATE,CONNECTION dev status").stdout.splitlines():
        p = line.split(":")
        if p and p[0] == iface:
            state = p[1] if len(p) > 1 else ""
            name = p[2] if len(p) > 2 else ""
            break
    ap = "hotspot" in name.lower()
    di = device_info()
    return {
        "iface": iface,
        "mode": "ap" if ap else ("client" if state == "connected" else "disconnected"),
        "connection": name, "ssid": di["ssid"], "ip": di["ip"],
        "ap_ssid": _ap_ssid(), "ap_pass": "superdevice",
    }


def provision(ssid, password):
    """Join a target WiFi; if it fails, bring the setup AP back so we're never stranded."""
    if not ssid:
        return {"ok": False, "error": "no SSID"}
    r = wifi_set(ssid, password)
    if not r.get("ok"):
        sh("/opt/superdevice/ap.sh start")
    return r


def ap_control(action):
    if action == "start":
        sh("/opt/superdevice/ap.sh start"); return {"ok": True, "ssid": _ap_ssid()}
    if action == "stop":
        sh("/opt/superdevice/ap.sh stop"); return {"ok": True}
    return {"ok": False, "error": "bad action"}


# ---- Virtual Vehicle (simulated car on a CAN channel) -----------------------
# Runs virtual_vehicle.py as a subprocess bound to an iface (default can1). Wire
# can1 <-> can0 (CANH-CANH, CANL-CANL, both 120Ω ON) and the Chip Lab's real
# pipeline runs against it on can0 exactly as against a real car.

VV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "virtual_vehicle.py")
_SIM = {"proc": None, "vehicle": None, "iface": None}


def sim_status():
    p = _SIM["proc"]
    running = bool(p and p.poll() is None)
    if not running and _SIM["proc"] is not None:
        _SIM.update(proc=None, vehicle=None, iface=None)
    return {
        "running": running,
        "vehicle": _SIM["vehicle"] if running else None,
        "iface": _SIM["iface"] if running else None,
        "pid": (p.pid if running else None),
    }


def sim_start(iface, vehicle):
    iface = iface or "can1"
    vehicle = vehicle or "corolla"
    if iface not in IFACES:
        return {"ok": False, "error": "bad iface"}
    if not os.path.exists(VV_PATH):
        return {"ok": False, "error": "virtual_vehicle.py not deployed"}
    sim_stop()
    sh("modprobe can_isotp")
    bus = iface_up(iface, 500000, 2000000, False)
    try:
        proc = subprocess.Popen(
            ["python3", VV_PATH, "--iface", iface, "--vehicle", vehicle],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "bus": bus}
    _SIM.update(proc=proc, vehicle=vehicle, iface=iface)
    time.sleep(0.6)
    st = sim_status()
    st["ok"] = st["running"]
    st["bus"] = bus
    if not st["running"]:
        st["error"] = "virtual vehicle exited immediately (can_isotp missing? iface down?)"
    return st


def sim_stop():
    p = _SIM["proc"]
    if p and p.poll() is None:
        try:
            p.terminate()
            try:
                p.wait(timeout=2)
            except Exception:
                p.kill()
        except Exception:
            pass
    _SIM.update(proc=None, vehicle=None, iface=None)
    return {"ok": True}


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
        if u.path == "/":
            b = PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
        elif u.path == "/api/status":
            self._json(status())
        elif u.path == "/api/vin":
            q = parse_qs(u.query)
            self._json(read_vin(q.get("iface", ["can0"])[0]))
        elif u.path == "/api/device":
            self._json(device_info())
        elif u.path == "/api/wifi/scan":
            self._json(wifi_scan())
        elif u.path == "/api/wifi/saved":
            self._json(wifi_saved())
        elif u.path == "/api/sim/status":
            self._json(sim_status())
        elif u.path == "/api/net":
            self._json(net_status())
        elif u.path == "/api/bus/monitor":
            q = parse_qs(u.query)
            self._json(bus_monitor(q.get("iface", ["can0"])[0], int(q.get("ms", ["700"])[0] or 700)))
        elif u.path == "/api/stream":
            q = parse_qs(u.query)
            ifs = [i for i in q.get("ifaces", ["can0,can1"])[0].split(",") if i in IFACES] or list(IFACES)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            p = subprocess.Popen(["candump", "-tz"] + ifs, stdout=subprocess.PIPE, text=True, bufsize=1)
            try:
                for line in p.stdout:
                    self.wfile.write(f"data: {line.rstrip()}\n\n".encode())
                    self.wfile.flush()
            except Exception:
                pass
            finally:
                p.terminate()
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        d = self._body()
        if u.path == "/api/up":
            self._json({"result": iface_up(d.get("iface"), d.get("bitrate", 500000), d.get("dbitrate", 2000000), bool(d.get("fd")))})
        elif u.path == "/api/down":
            self._json({"result": iface_down(d.get("iface"))})
        elif u.path == "/api/send":
            self._json({"result": send_frame(d.get("iface"), (d.get("id") or "").strip(), (d.get("data") or "").replace(" ", ""))})
        elif u.path == "/api/wifi/set":
            self._json(wifi_set(d.get("ssid"), d.get("password")))
        elif u.path == "/api/wifi/forget":
            self._json(wifi_forget((d.get("name") or "").strip()))
        elif u.path == "/api/claim":
            self._json(claim_acquire(d.get("owner"), bool(d.get("force"))))
        elif u.path == "/api/release":
            self._json(claim_release(d.get("owner"), bool(d.get("force"))))
        elif u.path == "/api/hostname":
            self._json(set_hostname((d.get("name") or "").strip()))
        elif u.path == "/api/reboot":
            self._json(reboot_device())
        elif u.path == "/api/provision":
            self._json(provision(d.get("ssid"), d.get("password")))
        elif u.path == "/api/ap":
            self._json(ap_control(d.get("action")))
        elif u.path == "/api/sim/start":
            self._json(sim_start(d.get("iface", "can1"), d.get("vehicle", "corolla")))
        elif u.path == "/api/sim/stop":
            self._json(sim_stop())
        elif u.path == "/api/isotp":
            self._json(isotp_http(d.get("iface", "can0"), d.get("tx"), d.get("rx"), d.get("data"), d.get("timeout", 2.0)))
        elif u.path == "/api/isotp/seq":
            self._json(isotp_seq(d.get("iface", "can0"), d.get("tx"), d.get("rx"), d.get("requests"), d.get("timeout", 2.0)))
        else:
            self._json({"error": "not found"}, 404)


PAGE = r"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SuperDevice Control</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--panel2:#1c232d;--bd:#273040;--fg:#c9d4e0;--dim:#7d8998;
--grn:#34d399;--amb:#fbbf24;--red:#f87171;--blu:#60a5fa;--mono:ui-monospace,"Cascadia Code",Menlo,Consolas,monospace;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.45}
.wrap{max-width:1100px;margin:0 auto;padding:18px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:11px}
.dot{width:11px;height:11px;border-radius:50%;background:var(--grn);box-shadow:0 0 10px var(--grn)}
h1{font-size:17px;margin:0;letter-spacing:.02em}h1 small{color:var(--dim);font-weight:400;font-size:12px}
.sys{display:flex;gap:16px;color:var(--dim);font-size:12px;font-family:var(--mono);flex-wrap:wrap}
.sys b{color:var(--fg);font-weight:600}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:720px){.grid{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--bd);border-radius:12px;padding:15px}
.cardhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.iname{font-family:var(--mono);font-size:16px;font-weight:700}
.role{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-left:8px}
.pill{font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:.04em}
.pill.up{background:rgba(52,211,153,.15);color:var(--grn)}
.pill.down{background:rgba(125,137,152,.18);color:var(--dim)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}
.stat{background:var(--panel2);border:1px solid var(--bd);border-radius:8px;padding:8px 6px;text-align:center}
.stat .k{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
.stat .v{font-family:var(--mono);font-size:16px;font-weight:700;margin-top:2px}
.stat .v.err{color:var(--amb)}
.ctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
select,input{background:var(--panel2);color:var(--fg);border:1px solid var(--bd);border-radius:7px;padding:7px 9px;font-size:13px;font-family:var(--mono)}
label.fd{display:flex;align-items:center;gap:5px;color:var(--dim);font-size:12px;cursor:pointer;user-select:none}
button{background:var(--panel2);color:var(--fg);border:1px solid var(--bd);border-radius:7px;padding:7px 13px;font-size:13px;font-weight:600;cursor:pointer}
button:hover{border-color:var(--dim)}
button.up{background:var(--grn);color:#06281c;border-color:var(--grn)}
button.down{background:transparent;color:var(--red);border-color:rgba(248,113,113,.4)}
button.send{background:var(--blu);color:#04203f;border-color:var(--blu)}
.feed{margin-top:14px}
.feedhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.log{background:#0a0e14;border:1px solid var(--bd);border-radius:10px;height:300px;overflow-y:auto;
padding:10px 12px;font-family:var(--mono);font-size:12.5px;white-space:pre;line-height:1.5}
.log .can0{color:var(--grn)}.log .can1{color:var(--blu)}.log .id{color:var(--amb)}.log .t{color:var(--dim)}
.send-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
.send-row .hint{color:var(--dim);font-size:11px}
.muted{color:var(--dim)}
.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--panel2);
border:1px solid var(--bd);border-radius:8px;padding:9px 16px;font-family:var(--mono);font-size:12px;opacity:0;transition:.25s;pointer-events:none}
.toast.show{opacity:1}
</style></head><body><div class="wrap">
<header>
  <div class="brand"><span class="dot"></span><h1>SuperDevice&nbsp;<small>· CAN control panel</small></h1></div>
  <div class="sys" id="sys"></div>
</header>
<div class="grid" id="cards"></div>

<div class="card feed">
  <div class="feedhead">
    <div><b>Live bus traffic</b> <span class="muted" id="feedstate">— stopped</span></div>
    <div class="ctl">
      <label class="fd"><input type="checkbox" id="f0" checked> can0</label>
      <label class="fd"><input type="checkbox" id="f1" checked> can1</label>
      <button id="startbtn" class="up">Start</button>
      <button id="clearbtn">Clear</button>
    </div>
  </div>
  <div class="log" id="log"></div>
  <div class="send-row">
    <span class="hint">Send:</span>
    <select id="sif"><option>can0</option><option>can1</option></select>
    <input id="sid" placeholder="ID (hex) e.g. 7DF" size="8" value="7DF">
    <input id="sdata" placeholder="data (hex) e.g. 0201050000000000" size="24" value="0201050000000000">
    <button class="send" id="sendbtn">Send frame</button>
    <span class="hint">ID#DATA — pad data to whole bytes</span>
  </div>
</div>
<div class="toast" id="toast"></div>
</div>
<script>
const $=s=>document.querySelector(s);
const BITRATES=[125000,250000,500000,1000000];
let es=null;

function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),1800);}
function fmtN(n){return (n||0).toLocaleString();}
function kbps(b){return b?(b/1000)+"k":"—";}

async function refresh(){
  let s; try{s=await (await fetch("/api/status")).json();}catch(e){return;}
  const y=s.sys;
  $("#sys").innerHTML=`<span>${y.model||""}</span><span>kernel <b>${y.kernel||""}</b></span>`
    +`<span>temp <b>${y.temp!=null?y.temp+"°C":"—"}</b></span><span>load <b>${y.load}</b></span><span>${y.uptime||""}</span>`;
  $("#cards").innerHTML=s.ifaces.map(cardHTML).join("");
  s.ifaces.forEach(wire);
}
function cardHTML(i){
  if(!i.present) return `<div class="card"><div class="cardhead"><span class="iname">${i.name}</span>
    <span class="pill down">MISSING</span></div><div class="muted">interface not found</div></div>`;
  const opts=BITRATES.map(b=>`<option value="${b}" ${b==(i.bitrate||500000)?"selected":""}>${b/1000}k</option>`).join("");
  return `<div class="card" data-if="${i.name}">
    <div class="cardhead">
      <div><span class="iname">${i.name}</span><span class="role">${i.role}</span></div>
      <span class="pill ${i.up?"up":"down"}">${i.up?"UP":"DOWN"}</span>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">bitrate</div><div class="v">${kbps(i.bitrate)}</div></div>
      <div class="stat"><div class="k">${i.fd?"data":"mode"}</div><div class="v">${i.fd?kbps(i.dbitrate):"classic"}</div></div>
      <div class="stat"><div class="k">rx / tx</div><div class="v">${fmtN(i.rx)}/${fmtN(i.tx)}</div></div>
      <div class="stat"><div class="k">errors</div><div class="v ${i.rxerr?"err":""}">${fmtN(i.rxerr)}</div></div>
    </div>
    <div class="ctl">
      <select class="br">${opts}</select>
      <label class="fd"><input type="checkbox" class="fd" ${i.fd?"checked":""}> CAN-FD (2M)</label>
      <button class="up doup">Up</button>
      <button class="down dodown">Down</button>
    </div></div>`;
}
function wire(i){
  const el=document.querySelector(`.card[data-if="${i.name}"]`); if(!el) return;
  el.querySelector(".doup").onclick=async()=>{
    const br=+el.querySelector(".br").value, fd=el.querySelector("input.fd").checked;
    const r=await post("/api/up",{iface:i.name,bitrate:br,dbitrate:2000000,fd});
    toast(i.name+": "+r.result); refresh();
  };
  el.querySelector(".dodown").onclick=async()=>{
    const r=await post("/api/down",{iface:i.name}); toast(i.name+": "+r.result); refresh();
  };
}
async function post(url,body){return (await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})).json();}

function colorize(line){
  return line
    .replace(/\((\d+\.\d+)\)/,'<span class="t">($1)</span>')
    .replace(/\b(can0|can1)\b/,'<span class="$1">$1</span>')
    .replace(/\b([0-9A-F]{3,8})\s+\[/,'<span class="id">$1</span> [');
}
function startFeed(){
  if(es){es.close();es=null;$("#startbtn").textContent="Start";$("#startbtn").classList.add("up");$("#feedstate").textContent="— stopped";return;}
  const ifs=[]; if($("#f0").checked)ifs.push("can0"); if($("#f1").checked)ifs.push("can1");
  es=new EventSource("/api/stream?ifaces="+ifs.join(","));
  const log=$("#log");
  es.onmessage=e=>{const d=document.createElement("div");d.innerHTML=colorize(e.data);log.appendChild(d);
    while(log.childNodes.length>600)log.removeChild(log.firstChild);log.scrollTop=log.scrollHeight;};
  es.onerror=()=>{$("#feedstate").textContent="— reconnecting…";};
  $("#startbtn").textContent="Stop";$("#startbtn").classList.remove("up");$("#feedstate").textContent="— streaming "+ifs.join(", ");
}
$("#startbtn").onclick=startFeed;
$("#clearbtn").onclick=()=>$("#log").innerHTML="";
$("#sendbtn").onclick=async()=>{
  const r=await post("/api/send",{iface:$("#sif").value,id:$("#sid").value,data:$("#sdata").value});
  toast(r.result);
};
refresh(); setInterval(refresh,2500);
</script></body></html>"""


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"SuperDevice UI on http://0.0.0.0:{PORT}")
    srv.serve_forever()
