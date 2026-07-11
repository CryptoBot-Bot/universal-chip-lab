#!/usr/bin/env python3
"""
SuperDevice Control Panel — a self-contained web UI for the Raspberry Pi 5 +
2-CH Isolated CAN-FD HAT. Pure Python standard library (no pip deps). Serves a
dashboard that shows both SocketCAN interfaces, brings them up/down at any
bitrate (classic or CAN-FD), streams live bus traffic, and sends frames.

Runs as root (via systemd) so it can drive `ip`/`cansend` directly.
Open from the laptop at:  http://superdevice.local:8080
"""
import json, re, shlex, subprocess
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


def isotp_request(iface, tx_id, rx_id, payload, timeout=2.0):
    """One ISO-TP request/response (kernel can_isotp handles multi-frame + flow control)."""
    import socket as _s
    CAN_ISOTP = getattr(_s, "CAN_ISOTP", 6)
    _ensure_up(iface)
    sh("modprobe can_isotp")
    sock = _s.socket(_s.AF_CAN, _s.SOCK_DGRAM, CAN_ISOTP)
    sock.settimeout(timeout)
    sock.bind((iface, rx_id, tx_id))   # (interface, rx_id, tx_id)
    try:
        sock.send(bytes(payload))
        return sock.recv(4095)
    finally:
        sock.close()


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


# ---- device management (identity + network) --------------------------------

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
        elif u.path == "/api/net":
            self._json(net_status())
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
        elif u.path == "/api/hostname":
            self._json(set_hostname((d.get("name") or "").strip()))
        elif u.path == "/api/reboot":
            self._json(reboot_device())
        elif u.path == "/api/provision":
            self._json(provision(d.get("ssid"), d.get("password")))
        elif u.path == "/api/ap":
            self._json(ap_control(d.get("action")))
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
