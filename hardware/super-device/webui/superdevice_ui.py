#!/usr/bin/env python3
"""
SuperDevice Control Panel — a self-contained web UI for the Raspberry Pi 5 +
2-CH Isolated CAN-FD HAT. Pure Python standard library (no pip deps). Serves a
dashboard that shows both SocketCAN interfaces, brings them up/down at any
bitrate (classic or CAN-FD), streams live bus traffic, and sends frames.

Runs as root (via systemd) so it can drive `ip`/`cansend` directly.
Open from the laptop at:  http://superdevice.local:8080
"""
import hashlib, json, os, platform, re, shlex, shutil, socket, subprocess, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# SD_PORT / SD_DATA_DIR exist so a second, staging copy of this daemon can run
# beside the installed one (other port, other data dir) to try a change out.
PORT = int(os.environ.get("SD_PORT", "8080"))
DATA_DIR = os.environ.get("SD_DATA_DIR", "/var/lib/superdevice")
HW_IFACES = ("can0", "can1")
# vcan0 is a kernel-only CAN bus: the virtual vehicle and this daemon can both sit
# on it, so the whole pipeline runs with no can1<->can0 jumper. It exists only
# while a virtual vehicle runs on it (sim_start creates it, sim_stop removes it).
VIRT_IFACES = ("vcan0",)
IFACES = HW_IFACES + VIRT_IFACES
HEXID = re.compile(r"^[0-9A-Fa-f]{1,8}$")
HEXDATA = re.compile(r"^[0-9A-Fa-f]{0,128}$")
STARTED = time.time()


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True)


def _sha256(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return ""


HERE = os.path.dirname(os.path.abspath(__file__))
DAEMON_SHA = _sha256(os.path.abspath(__file__))  # the code actually running (hashed at start)
try:
    HOSTNAME = socket.gethostname()
except Exception:
    HOSTNAME = ""


def version_info():
    """What is running: deploy.py compares daemon_sha256 with the file it sent, so
    a restart that left the old process alive is not mistaken for a deploy."""
    return {
        "daemon_sha256": DAEMON_SHA,
        "started": round(STARTED, 3),
        "uptime_s": int(time.time() - STARTED),
        "pid": os.getpid(),
        "python": platform.python_version(),
        "port": PORT,
        "files": {n: _sha256(os.path.join(HERE, n)) for n in ("superdevice_ui.py", "virtual_vehicle.py", "powerguard.py")},
        "features": ["version", "recorder", "replay", "vcan", "sweep", "bus-health"],
    }


def _iface_exists(iface):
    return os.path.isdir(f"/sys/class/net/{iface}")


def status():
    # "ifaces" stays exactly the two hardware channels: the app picks the bus it
    # talks to from that list (the UP one with the most traffic), and a virtual bus
    # with a simulated car chattering on it must never win that pick at a real car.
    # A virtual bus that exists is reported separately, under "virtual".
    out = {"ifaces": [], "virtual": [], "sys": {}}
    try:
        data = json.loads(sh("ip -j -d -s link show").stdout)
    except Exception:
        data = []
    seen = {d.get("ifname"): d for d in data}
    for name in IFACES:
        d = seen.get(name)
        bucket = out["ifaces"] if name in HW_IFACES else out["virtual"]
        if not d:
            if name in HW_IFACES:  # a virtual bus is listed only while it exists
                bucket.append({"name": name, "present": False})
            continue
        flags = d.get("flags", [])
        info = (d.get("linkinfo", {}) or {}).get("info_data", {}) or {}
        bt = info.get("bittiming", {}) or {}
        dbt = info.get("dbittiming", {}) or {}
        ctrl = info.get("ctrlmode", []) or []
        st = d.get("stats64", {}) or {}
        rx = (st.get("rx", {}) or {})
        tx = (st.get("tx", {}) or {})
        bucket.append({
            "name": name, "present": True,
            "up": "UP" in flags,
            "bitrate": bt.get("bitrate", 0),
            "dbitrate": dbt.get("bitrate", 0),
            "fd": "FD" in ctrl,
            "canstate": info.get("state", ""),
            "rx": rx.get("packets", 0), "tx": tx.get("packets", 0),
            "rxerr": rx.get("errors", 0) + rx.get("dropped", 0),
            "role": "VIRTUAL" if name in VIRT_IFACES else ("HS-CAN" if name == "can0" else "MS-CAN"),
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


def ensure_int_pin_input(iface):
    """A CAN controller's interrupt GPIO must be an INPUT before the bus comes up.
    The stock mcp251xfd overlay (can0, GPIO25) sets that; the custom can1 overlay
    (mcp-can1-spi1, GPIO24) does not, and on a Pi 5 a pin left unconfigured reads
    LOW — so can1's level-low interrupt was asserted for ever: ~31,000 interrupts/s
    and a third of a core whenever can1 was up, and the kernel switching the
    interrupt off ("irq 186: nobody cared") as soon as can1 carried under ~30
    frames/s, leaving it deaf. Measured 2026-11-21: 31054 -> 81 interrupts/s with
    the pin set to input. The pin number comes from the device tree, so this
    follows the overlay; it is a no-op on a pin that is already an input."""
    if iface not in HW_IFACES:
        return
    try:
        with open(f"/sys/class/net/{iface}/device/of_node/interrupts", "rb") as f:
            gpio = int.from_bytes(f.read(4), "big")
    except OSError:
        return
    if not 0 <= gpio <= 27:
        return
    fields = sh(f"pinctrl get {gpio}").stdout.split(":", 1)[-1].split()
    if fields and fields[0] != "ip":
        sh(f"pinctrl set {gpio} ip pu")
        print(f"[sd] {iface}: interrupt pin GPIO{gpio} was '{fields[0]}', now an input with pull-up", flush=True)


def iface_up(iface, bitrate, dbitrate, fd):
    if iface not in IFACES:
        return "bad iface"
    ensure_int_pin_input(iface)
    if iface in VIRT_IFACES:  # no bit timing on a virtual bus — create it if missing, then up
        if not _iface_exists(iface):
            sh("modprobe vcan")
            r = sh(f"ip link add dev {iface} type vcan")
            if r.returncode != 0:
                return r.stderr.strip() or "could not create the virtual bus"
        return sh(f"ip link set {iface} up").stderr.strip() or "ok"
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
    result = sh(f"cansend {iface} {cid}#{data}").stderr.strip() or "sent"
    REC.log({"type": "tx", "iface": iface, "id": cid.upper(), "data": data.lower(), "result": result})
    return result


def _ensure_up(iface, bitrate=500000):
    st = sh(f"ip -br link show {iface}").stdout
    if iface in VIRT_IFACES:
        # a vcan reports state UNKNOWN; its flags say whether it is up. Never create
        # one here: a request to a virtual bus nobody started should fail plainly.
        if st and "UP" not in st.split("<")[-1].split(">")[0].split(","):
            sh(f"ip link set {iface} up")
        return
    if " UP " not in f" {st} " and "UP" not in st.split()[1:2]:
        ensure_int_pin_input(iface)
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
    # 29-bit ("extended") diagnostic ids need the EFF flag on both sides.
    CAN_EFF_FLAG = 0x80000000
    if rx_id > 0x7FF:
        rx_id |= CAN_EFF_FLAG
    if tx_id > 0x7FF:
        tx_id |= CAN_EFF_FLAG
    sock.bind((iface, rx_id, tx_id))   # (interface, rx_id, tx_id)
    return sock


def _recv_final(sock, timeout, info=None):
    """Receive one diagnostic response, skipping 7F xx 78 (requestCorrectlyReceived-
    ResponsePending): real ECUs send that while they work on slow requests (DTC reads,
    routines, security) and the final answer follows — up to P2* (5 s). `info`, when
    given, gets the number of pending replies skipped (for the recorder)."""
    import time as _t
    deadline = _t.time() + max(timeout, 0.2) + 5.0
    data = sock.recv(4095)
    while len(data) >= 3 and data[0] == 0x7F and data[2] == 0x78 and _t.time() < deadline:
        if info is not None:
            info["pending"] = info.get("pending", 0) + 1
        sock.settimeout(max(0.5, min(5.0, deadline - _t.time())))
        data = sock.recv(4095)
    return data


# ---- ISO-TP recorder ----------------------------------------------------------
# Every diagnostic exchange this daemon performs is appended to a JSONL file on
# the Pi's own disk, so a visit to a car leaves a complete record that can be
# fetched afterwards (GET /api/rec/get) and replayed by the virtual vehicle
# (virtual_vehicle.py --replay). It is always on: with no named session the lines
# go to one automatic file per day. One line per event:
#   {"type":"session"|"resume"|"end", ...}                     file header / daemon restart / session end
#   {"type":"x","t":epoch,"iface","tx","rx","req","resp","ms","via","k", ["pending","err","sim"]}
#        one request and its final response ("resp":"" = no answer); "k" numbers the
#        socket, so requests that shared one diagnostic session share a k (k starts
#        again at 1 after a "resume" line, i.e. after a daemon restart)
#   {"type":"bus","iface","window_ms","frames":[{id,dlc,bytes,hz}]}   a bus-monitor snapshot
#   {"type":"tx","iface","id","data"}                          a raw frame sent from the panel
#   {"type":"sim","event":"start"|"stop",...}                  the virtual vehicle came or went
# Recording must never break a diagnostic request: every failure is swallowed and
# shown in /api/rec/status instead.

REC_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")


class Recorder:
    IDLE_END = 6 * 3600      # a named session nobody stopped ends after this long without traffic
    MIN_FREE_MB = 200        # stop writing rather than fill the SD card

    def __init__(self, root):
        self.root = root
        self.lock = threading.Lock()
        self.fh = None
        self.cur = None           # {"id","label","note","started","auto"}
        self.lines = 0            # lines this process wrote to the current file
        self.last_write = 0.0
        self.last_sync = 0.0
        self.last_space_check = 0.0
        self.full = False
        self.error = ""
        self.sock_seq = 0
        self.resumed = False      # current.json looked at once per process

    def _path(self, sid):
        return os.path.join(self.root, sid + ".jsonl")

    def _state_path(self):
        return os.path.join(self.root, "current.json")

    def next_sock(self):
        with self.lock:
            self.sock_seq += 1
            return self.sock_seq

    # -- everything below runs with self.lock held --------------------------------
    def _emit(self, obj):
        now = time.time()
        obj.setdefault("t", round(now, 3))
        self.fh.write(json.dumps(obj, separators=(",", ":")) + "\n")
        self.fh.flush()
        if now - self.last_sync > 2.0:
            os.fsync(self.fh.fileno())
            self.last_sync = now
        self.lines += 1
        self.last_write = now

    def _close(self, end=False):
        if self.fh:
            try:
                if end:
                    self._emit({"type": "end", "id": self.cur["id"]})
                self.fh.flush()
                os.fsync(self.fh.fileno())
                self.fh.close()
            except Exception:
                pass
        self.fh = None
        self.cur = None

    def _open(self, cur):
        os.makedirs(self.root, exist_ok=True)
        path = self._path(cur["id"])
        new = not os.path.exists(path) or os.path.getsize(path) == 0
        self.fh = open(path, "a", encoding="utf-8")
        self.cur = cur
        self.lines = 0
        self._emit({
            "type": "session" if new else "resume", "id": cur["id"], "label": cur.get("label", ""),
            "note": cur.get("note", ""), "auto": bool(cur.get("auto")), "started": cur.get("started"),
            "host": HOSTNAME, "daemon": DAEMON_SHA[:12], "sim": _sim_tag(),
        })

    def _auto_id(self):
        return time.strftime("%Y%m%d") + "-auto"

    def _ensure(self):
        now = time.time()
        if now - self.last_space_check > 60:
            self.last_space_check = now
            try:
                os.makedirs(self.root, exist_ok=True)
                self.full = shutil.disk_usage(self.root).free < self.MIN_FREE_MB * 1024 * 1024
            except Exception:
                self.full = False
        if self.full:
            raise OSError(f"less than {self.MIN_FREE_MB} MB free — recording paused")
        if self.cur and not self.cur.get("auto") and self.last_write and now - self.last_write > self.IDLE_END:
            self._close(end=True)
            self._forget_state()
        if self.cur and self.cur.get("auto") and self.cur["id"] != self._auto_id():
            self._close()
        self._resume_once()
        if self.cur is None:
            self._open({"id": self._auto_id(), "label": "", "note": "", "auto": True,
                        "started": time.strftime("%Y-%m-%dT%H:%M:%S")})

    def _resume_once(self):
        """A named session survives a daemon restart (a deploy must not split a
        visit): the first look after start reopens the session current.json names."""
        if self.cur is not None or self.resumed:
            return
        self.resumed = True
        try:
            st = json.loads(open(self._state_path()).read())
            if REC_ID.match(st.get("id", "")) and os.path.exists(self._path(st["id"])):
                if time.time() - os.path.getmtime(self._path(st["id"])) > self.IDLE_END:
                    self._forget_state()   # left open long ago (device was off): that visit is over
                    return
                self._open({"id": st["id"], "label": st.get("label", ""), "note": st.get("note", ""),
                            "started": st.get("started"), "auto": False})
        except Exception:
            pass

    def _forget_state(self):
        try:
            os.remove(self._state_path())
        except OSError:
            pass

    # -- public ---------------------------------------------------------------------
    def log(self, obj):
        with self.lock:
            try:
                self._ensure()
                self._emit(obj)
                self.error = ""
            except Exception as e:
                self.error = f"{type(e).__name__}: {e}"

    def exchange(self, iface, tx_id, rx_id, payload, data, err, t0, via, k, pending=0):
        rec = {
            "type": "x", "t": round(t0, 3), "iface": iface, "tx": f"{tx_id:X}", "rx": f"{rx_id:X}",
            "req": bytes(payload).hex(), "resp": data.hex() if data else "",
            "ms": round((time.time() - t0) * 1000, 1), "via": via, "k": k,
        }
        if pending:
            rec["pending"] = pending
        if err:
            rec["err"] = err
        sim = _sim_tag()
        if sim:
            rec["sim"] = sim   # a virtual vehicle was running on this device at that moment
        self.log(rec)

    def start(self, label, note=""):
        slug = re.sub(r"[^A-Za-z0-9]+", "-", (label or "").strip())[:40].strip("-")
        sid = time.strftime("%Y%m%d-%H%M%S") + (f"-{slug}" if slug else "")
        with self.lock:
            try:
                self._close(end=bool(self.cur and not self.cur.get("auto")))
                cur = {"id": sid, "label": (label or "").strip()[:120], "note": (note or "").strip()[:500],
                       "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "auto": False}
                self._open(cur)
                with open(self._state_path(), "w") as f:
                    f.write(json.dumps(cur))
                self.resumed = True
                self.error = ""
            except Exception as e:
                self.error = f"{type(e).__name__}: {e}"
                return {"ok": False, "error": self.error}
        return {"ok": True, **self.status()}

    def stop(self):
        with self.lock:
            self._resume_once()
            named = bool(self.cur and not self.cur.get("auto"))
            ended = self.cur["id"] if named else None
            if named:
                self._close(end=True)
            self._forget_state()
            self.resumed = True
        return {"ok": True, "ended": ended, **self.status()}

    def flush(self):
        with self.lock:
            if self.fh:
                try:
                    self.fh.flush()
                    os.fsync(self.fh.fileno())
                except Exception:
                    pass

    def status(self):
        with self.lock:
            self._resume_once()
            cur = dict(self.cur) if self.cur else None
            if cur:
                try:
                    cur["bytes"] = os.path.getsize(self._path(cur["id"]))
                except OSError:
                    cur["bytes"] = 0
                cur["lines_this_run"] = self.lines
            try:
                free_mb = int(shutil.disk_usage(self.root if os.path.isdir(self.root) else "/").free / 1048576)
            except Exception:
                free_mb = None
            return {"recording": not self.full and not self.error, "session": cur, "dir": self.root,
                    "free_mb": free_mb, "error": self.error or None}

    def path_for(self, sid):
        if not REC_ID.match(sid or ""):
            return None
        p = self._path(sid)
        return p if os.path.isfile(p) else None

    def list(self):
        self.flush()
        out = []
        try:
            names = sorted(n for n in os.listdir(self.root) if n.endswith(".jsonl"))
        except OSError:
            names = []
        active = self.cur["id"] if self.cur else None
        for n in names:
            p = os.path.join(self.root, n)
            sid = n[:-6]
            entry = {"id": sid, "bytes": 0, "lines": 0, "exchanges": 0, "active": sid == active}
            try:
                h = hashlib.sha256()
                with open(p, "rb") as f:
                    first = f.readline()
                    h.update(first)
                    lines, x = (1 if first else 0), 0
                    for line in f:
                        h.update(line)
                        lines += 1
                        if line.startswith(b'{"type":"x"'):
                            x += 1
                head = json.loads(first or b"{}")
                entry.update(bytes=os.path.getsize(p), lines=lines, exchanges=x, sha256=h.hexdigest(),
                             label=head.get("label", ""), note=head.get("note", ""), auto=bool(head.get("auto")),
                             started=head.get("started"), sim=head.get("sim"), mtime=int(os.path.getmtime(p)))
            except Exception as e:
                entry["error"] = f"{type(e).__name__}: {e}"
            out.append(entry)
        return {"sessions": out, "dir": self.root}


REC = Recorder(os.path.join(DATA_DIR, "recordings"))


def isotp_request(iface, tx_id, rx_id, payload, timeout=2.0, via="isotp"):
    """One ISO-TP request/response (kernel can_isotp handles multi-frame + flow control)."""
    t0 = time.time()
    info, data, err = {}, None, ""
    try:
        sock = _isotp_socket(iface, tx_id, rx_id, timeout)
        try:
            sock.send(bytes(payload))
            data = _recv_final(sock, timeout, info)
            return data
        finally:
            sock.close()
    except Exception as e:
        err = type(e).__name__
        raise
    finally:
        REC.exchange(iface, tx_id, rx_id, payload, data, err, t0, via, REC.next_sock(), info.get("pending", 0))


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
    REC.log({"type": "bus", "iface": iface, "window_ms": int(dur * 1000), "frames": out})
    return {"ok": True, "window_ms": int(dur * 1000), "count": len(out), "frames": out}


SWEEP_LOCK = threading.Lock()


def address_sweep(iface="can0", lo=0x600, hi=0x7FF, ext=False, listen_s=3.0, wait_ms=50):
    """Find diagnostic modules on addresses no list knows (maker schemes such as
    Mercedes 6xx/7xx -> 4Ex). Sends ONLY tester-present (3E 00, then 3E 01 for KWP),
    one frame at a time, never on an ID the bus itself uses:
      1. wake the bus with a functional OBD request (7DF 01 00) — gateway cars stay silent
         until a tester talks — then listen `listen_s`; every ID heard is off-limits;
      2. before each send re-check that ID was never heard (slow broadcasts appear late);
      3. a hit is a single-frame 7E xx / 7F 3E nrc on another ID; each is re-confirmed.
    11-bit range is clamped to 0x500-0x7FF (below that is broadcast territory).
    ext=True also tries the ISO 15765-4 29-bit physical block 18DA<tt>F1 -> 18DAF1<tt>."""
    import select as _sel
    import struct as _st
    if iface not in IFACES:
        return {"ok": False, "error": "bad iface"}
    try:
        lo, hi = max(0x500, int(lo)), min(0x7FF, int(hi))
        listen_s = max(1.0, min(float(listen_s), 10.0))
        wait = max(0.02, min(float(wait_ms) / 1000.0, 0.2))
    except (TypeError, ValueError):
        return {"ok": False, "error": "bad range"}
    if hi < lo:
        return {"ok": False, "error": "bad range"}
    if not SWEEP_LOCK.acquire(blocking=False):
        return {"ok": False, "error": "a sweep is already running"}
    t0 = time.time()
    try:
        _ensure_up(iface)
        FMT, EFF = "=IB3x8s", 0x80000000
        s = socket.socket(socket.AF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
        s.bind((iface,))
        s.setblocking(False)
        seen = {}

        def frames_for(dur):
            out, end = [], time.time() + dur
            while True:
                left = end - time.time()
                if left <= 0:
                    return out
                r, _, _ = _sel.select([s], [], [], left)
                if not r:
                    continue
                cid, dlc, data = _st.unpack(FMT, s.recv(16))
                key = (cid & 0x1FFFFFFF) | (EFF if cid & EFF else 0)
                seen[key] = seen.get(key, 0) + 1
                out.append((key, data[:dlc]))

        def send(cid, payload):
            s.send(_st.pack(FMT, cid, 8, bytes(payload) + bytes(8 - len(payload))))

        def is_tp_answer(d):
            return len(d) >= 3 and d[0] in (0x02, 0x03) and (d[1] == 0x7E or (d[1] == 0x7F and d[2] == 0x3E))

        send(0x7DF, [0x02, 0x01, 0x00])          # wake: standard OBD "PIDs supported"
        frames_for(listen_s)
        broadcast = {f"{k & 0x1FFFFFFF:X}": n for k, n in sorted(seen.items())}
        own = {0x7DF} | set(range(0x7E0, 0x7F0))  # legislated block: the normal list covers it
        targets = [(c, None) for c in range(lo, hi + 1)]
        if ext:
            targets += [((0x18DA00F1 | (tt << 8)) | EFF, (0x18DAF100 | tt) | EFF) for tt in range(0x100)]

        def probe(req, want_resp=None):
            for tp in ([0x02, 0x3E, 0x00], [0x02, 0x3E, 0x01]):
                send(req, tp)
                for cid, d in frames_for(wait):
                    if cid == req or (cid & 0x7FF) in own and not (cid & EFF):
                        continue
                    if want_resp is not None and cid != want_resp:
                        continue
                    if is_tp_answer(d) and (want_resp is not None or seen.get(cid, 0) <= 2):
                        return cid, bytes(tp).hex(), d.hex()
            return None

        hits, skipped, probed = [], [], 0
        for req, want in targets:
            if (req & 0x7FF) in own and not (req & EFF):
                continue
            if seen.get(req):
                skipped.append(f"{req & 0x1FFFFFFF:X}")
                continue
            probed += 1
            got = probe(req, want)
            if got:
                hits.append({"req": f"{req & 0x1FFFFFFF:X}", "resp": f"{got[0] & 0x1FFFFFFF:X}", "probe": got[1], "data": got[2]})
        confirmed = []
        for h in hits:   # second, targeted ask: the same answer on the same ID, or it does not count
            req = int(h["req"], 16) | (EFF if len(h["req"]) > 3 else 0)
            resp = int(h["resp"], 16) | (EFF if len(h["resp"]) > 3 else 0)
            again = probe(req, resp)
            h["confirmed"] = bool(again)
            h["kind"] = "uds" if h["data"][2:4] == "7e" and h["probe"] == "023e00" else "kwp" if h["data"][2:4] == "7f" else "unknown"
            if again:
                confirmed.append(h)
        s.close()
        out = {"ok": True, "iface": iface, "range": [f"{lo:03X}", f"{hi:03X}"], "ext": bool(ext), "probed": probed,
               "seconds": round(time.time() - t0, 1), "broadcast": broadcast, "skipped": skipped,
               "responders": confirmed, "unconfirmed": [h for h in hits if not h["confirmed"]]}
        REC.log({"type": "sweep", **out})
        return out
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "seconds": round(time.time() - t0, 1)}
    finally:
        SWEEP_LOCK.release()


VIN_ATTEMPTS = [
    # (tx, rx, payload, label) — in the order real cars answer most often
    (0x7E0, 0x7E8, [0x09, 0x02], "OBD 09 02 physical 7E0"),
    (0x7DF, 0x7E8, [0x09, 0x02], "OBD 09 02 functional 7DF"),
    (0x7E0, 0x7E8, [0x22, 0xF1, 0x90], "UDS 22 F190 on 7E0"),
    (0x18DA10F1, 0x18DAF110, [0x09, 0x02], "OBD 09 02 29-bit physical (Honda & co)"),
    (0x18DB33F1, 0x18DAF110, [0x09, 0x02], "OBD 09 02 29-bit functional"),
]


def _vin_from(data):
    if not data:
        return ""
    if len(data) >= 4 and data[0] == 0x49 and data[1] == 0x02:
        body = data[3:]
    elif len(data) >= 4 and data[0] == 0x62 and data[1] == 0xF1 and data[2] == 0x90:
        body = data[3:]
    else:
        return ""
    vin = "".join(chr(b) for b in body if 0x20 < b < 0x7F).strip()
    return vin if len(vin) >= 11 else ""


def read_vin(iface="can0"):
    """Real OBD-II VIN read with fallbacks (physical, functional, UDS DID, 29-bit)."""
    if iface not in IFACES:
        return {"ok": False, "error": "bad iface"}
    tried = []
    for tx, rx, payload, label in VIN_ATTEMPTS:
        try:
            data = isotp_request(iface, tx, rx, payload, timeout=1.5, via="vin")
        except Exception as e:
            tried.append(f"{label}: {type(e).__name__}")
            continue
        raw = data.hex() if data else ""
        vin = _vin_from(data)
        if vin:
            return {"ok": True, "vin": vin, "raw": raw, "via": label}
        tried.append(f"{label}: {raw or 'no data'}")
    out = {"ok": False, "error": "no VIN from the ECM (ignition on? bus speed 500k? cable on pins 6/14?)", "tried": tried}
    if iface in HW_IFACES:
        h = bus_health(iface)
        out["bus"] = h
        if h.get("no_ack"):
            # Our frames went out and NOTHING acknowledged them — no powered node on this wire.
            # The controller would keep retransmitting the last frame forever: cycle it clean.
            iface_up(iface, h.get("bitrate") or 500000, 2000000, False)
            out["diagnosis"] = "no-ack"
            out["error"] = ("nothing on the bus acknowledged the request (tx error counter "
                            f"{h.get('tx_err')}, 0 frames received) — the device is not on a live CAN bus here: "
                            "ignition ON? OBD pin 6 → can0 H and pin 14 → can0 L wired? Pre-2008 cars may use "
                            "K-line (pin 7) instead of CAN. The bus was reset so the stuck request stops.")
        elif h.get("rx_err", 0) > 0 and h.get("rx_packets", 0) == 0:
            out["diagnosis"] = "bitrate"
            out["error"] = (f"traffic is on the bus but none of it decodes at {h.get('bitrate')} bit/s "
                            f"(rx errors {h.get('rx_err')}) — try another bitrate (250k / 125k)")
        elif h.get("rx_packets", 0) > 0:
            out["diagnosis"] = "no-ecm-answer"
            out["error"] = ("the bus is alive (frames seen and acknowledged) but no ECM answered the VIN request "
                            "on 7E0/7DF/29-bit — a gateway or a maker address scheme; run discovery anyway")
    return out


def bus_health(iface):
    """Controller error counters + traffic for one CAN channel (from `ip -details -statistics`)."""
    txt = sh(f"ip -details -statistics link show {iface}").stdout
    h = {"iface": iface}
    m = re.search(r"can state (\S+) \(berr-counter tx (\d+) rx (\d+)\)", txt)
    if m:
        h["state"], h["tx_err"], h["rx_err_counter"] = m.group(1), int(m.group(2)), int(m.group(3))
    m = re.search(r"bitrate (\d+)", txt)
    h["bitrate"] = int(m.group(1)) if m else 0
    m = re.search(r"RX:.*?\n\s*(\d+)\s+(\d+)\s+(\d+)", txt)
    if m:
        h["rx_packets"], h["rx_err"] = int(m.group(2)), int(m.group(3))
    m = re.search(r"TX:.*?\n\s*(\d+)\s+(\d+)", txt)
    if m:
        h["tx_packets"] = int(m.group(2))
    h["no_ack"] = bool(h.get("tx_err", 0) >= 128 and h.get("rx_packets", 0) == 0) or h.get("state") in ("ERROR-PASSIVE", "BUS-OFF") and h.get("rx_packets", 0) == 0
    return h


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
    k = REC.next_sock()
    try:
        for r in requests[:24]:
            try:
                payload = bytes.fromhex(str(r).replace(" ", ""))
            except (ValueError, TypeError):
                out.append({"request": str(r), "ok": False, "error": "bad hex"}); continue
            if not payload:
                out.append({"request": "", "ok": False, "error": "empty"}); continue
            t0, info = time.time(), {}
            try:
                sock.send(payload)
                data = _recv_final(sock, t, info)
            except Exception as e:
                REC.exchange(iface, tx_id, rx_id, payload, None, type(e).__name__, t0, "seq", k, info.get("pending", 0))
                out.append({"request": payload.hex(), "ok": False, "error": f"{type(e).__name__}: {e}", "response": ""}); continue
            REC.exchange(iface, tx_id, rx_id, payload, data, "", t0, "seq", k, info.get("pending", 0))
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


_SSID_CACHE = {"t": 0.0, "ssid": ""}


def _current_ssid():
    """SSID of the active client connection WITHOUT triggering a Wi-Fi scan.
    (`nmcli dev wifi` may rescan when its cache is stale — a scan stalls the radio
    for seconds and made the app's 5 s health poll time out → "lost connection".)
    Cached 30 s; the health poll calls this every 5 s."""
    now = time.time()
    if now - _SSID_CACHE["t"] < 30 and _SSID_CACHE["ssid"]:
        return _SSID_CACHE["ssid"]
    ssid = sh("nmcli -t -f active,ssid dev wifi list --rescan no 2>/dev/null | grep '^yes' | cut -d: -f2").stdout.strip()
    if not ssid:
        ssid = sh("nmcli -t -f GENERAL.CONNECTION dev show wlan0 2>/dev/null | cut -d: -f2").stdout.strip()
    _SSID_CACHE.update(t=now, ssid=ssid)
    return ssid


def ensure_wifi_powersave_off():
    """Wi-Fi power save on the Pi's onboard radio causes multi-second stalls (the
    app saw periodic 'lost connection → restored'). Disable it persistently via
    NetworkManager; takes effect on the next (re)connect. Idempotent, root only."""
    conf = "/etc/NetworkManager/conf.d/superdevice-wifi-powersave.conf"
    try:
        if not os.path.exists(conf):
            with open(conf, "w") as f:
                f.write("[connection]\nwifi.powersave = 2\n")
            sh("nmcli general reload")
        con = sh("nmcli -t -f NAME,DEVICE con show --active | grep ':wlan0' | cut -d: -f1").stdout.strip()
        if con and "disable" not in sh(f"nmcli -t -f 802-11-wireless.powersave con show '{con}'").stdout:
            sh(f"nmcli connection modify '{con}' 802-11-wireless.powersave 2")
    except Exception as e:
        print(f"[sd] wifi powersave: {e}", flush=True)


def device_info():
    ip = sh("hostname -I").stdout.strip().split()
    ssid = _current_ssid()
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
_SIM = {"proc": None, "vehicle": None, "iface": None, "replay": None}


def _sim_tag():
    """Name of the virtual vehicle running right now, or None — stamped on recorded
    exchanges so data from a real car is never confused with the simulator's."""
    p = _SIM["proc"]
    return _SIM["vehicle"] if (p and p.poll() is None) else None


def sim_status():
    p = _SIM["proc"]
    running = bool(p and p.poll() is None)
    if not running and _SIM["proc"] is not None:
        _SIM.update(proc=None, vehicle=None, iface=None, replay=None)
    return {
        "running": running,
        "vehicle": _SIM["vehicle"] if running else None,
        "iface": _SIM["iface"] if running else None,
        "replay": _SIM["replay"] if running else None,
        "pid": (p.pid if running else None),
    }


def sim_start(iface, vehicle, replay=None):
    """Start the virtual vehicle. `vehicle` picks a built-in model; `replay` (a
    recording id from /api/rec/list) instead plays back what a real car answered.
    iface "vcan0" needs no wiring; "can1" needs the can1<->can0 jumper."""
    iface = iface or "can1"
    vehicle = vehicle or "corolla"
    if iface not in IFACES:
        return {"ok": False, "error": "bad iface"}
    if not os.path.exists(VV_PATH):
        return {"ok": False, "error": "virtual_vehicle.py not deployed"}
    if replay:
        rec_path = REC.path_for(str(replay))
        if not rec_path:
            return {"ok": False, "error": f"no recording '{replay}' on this device"}
        REC.flush()
        what, name = ["--replay", rec_path], f"replay:{replay}"
    else:
        what, name = ["--vehicle", vehicle], vehicle
    sim_stop()
    sh("modprobe can_isotp")
    bus = iface_up(iface, 500000, 2000000, False)
    try:
        proc = subprocess.Popen(
            ["python3", VV_PATH, "--iface", iface] + what,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "bus": bus}
    _SIM.update(proc=proc, vehicle=name, iface=iface, replay=(str(replay) if replay else None))
    time.sleep(0.6)
    st = sim_status()
    st["ok"] = st["running"]
    st["bus"] = bus
    if not st["running"]:
        st["error"] = "virtual vehicle exited immediately (can_isotp missing? iface down? empty recording?)"
    else:
        REC.log({"type": "sim", "event": "start", "vehicle": name, "iface": iface})
    return st


def sim_stop():
    p = _SIM["proc"]
    was = _SIM["vehicle"] if (p and p.poll() is None) else None
    iface = _SIM["iface"]
    if p and p.poll() is None:
        try:
            p.terminate()
            try:
                p.wait(timeout=2)
            except Exception:
                p.kill()
        except Exception:
            pass
    _SIM.update(proc=None, vehicle=None, iface=None, replay=None)
    if was:
        REC.log({"type": "sim", "event": "stop", "vehicle": was, "iface": iface})
        if iface in VIRT_IFACES:  # the virtual bus lives only as long as its vehicle
            sh(f"ip link del {iface}")
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
        elif u.path == "/api/version":
            self._json(version_info())
        elif u.path == "/api/rec/status":
            self._json(REC.status())
        elif u.path == "/api/rec/list":
            self._json(REC.list())
        elif u.path == "/api/rec/get":
            # the recording itself, byte for byte (JSONL). The size is fixed before
            # sending so a session still being written downloads as a clean prefix.
            REC.flush()
            p = REC.path_for(parse_qs(u.query).get("id", [""])[0])
            if not p:
                self._json({"error": "no such recording"}, 404)
                return
            size = os.path.getsize(p)
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            with open(p, "rb") as f:
                left = size
                while left > 0:
                    chunk = f.read(min(65536, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
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
            self._json(sim_start(d.get("iface", "can1"), d.get("vehicle", "corolla"), d.get("replay")))
        elif u.path == "/api/sim/stop":
            self._json(sim_stop())
        elif u.path == "/api/rec/start":
            self._json(REC.start(d.get("label"), d.get("note") or ""))
        elif u.path == "/api/rec/stop":
            self._json(REC.stop())
        elif u.path == "/api/isotp":
            self._json(isotp_http(d.get("iface", "can0"), d.get("tx"), d.get("rx"), d.get("data"), d.get("timeout", 2.0)))
        elif u.path == "/api/isotp/seq":
            self._json(isotp_seq(d.get("iface", "can0"), d.get("tx"), d.get("rx"), d.get("requests"), d.get("timeout", 2.0)))
        elif u.path == "/api/scan/sweep":
            self._json(address_sweep(d.get("iface", "can0"), d.get("lo", 0x600), d.get("hi", 0x7FF), bool(d.get("ext")),
                                     d.get("listen_s", 3.0), d.get("wait_ms", 50)))
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
    if PORT == 8080:  # a staging copy on another port leaves the network settings alone
        ensure_wifi_powersave_off()
    for _iface in HW_IFACES:  # also covers a bus that is already up when the daemon restarts
        ensure_int_pin_input(_iface)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"SuperDevice UI on http://0.0.0.0:{PORT}  (daemon {DAEMON_SHA[:12]}, recordings in {REC.root})", flush=True)
    srv.serve_forever()
