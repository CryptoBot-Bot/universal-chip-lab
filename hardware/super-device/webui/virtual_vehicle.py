#!/usr/bin/env python3
"""
Virtual Vehicle — a full, accurate ISO-TP vehicle that lives on a CAN channel so
the Chip Lab can be developed and tested exactly as against a real car.

Run it on can1 (the "vehicle"), wire can1 ↔ can0 (CANH-CANH, CANL-CANL, both
120Ω terminators ON), and the Chip Lab's whole real pipeline — VIN read, module
discovery, per-module AI deep-map — runs against it on can0 as if it were a real
2020 Toyota Corolla. Every ECU answers real OBD/UDS over real ISO-TP framing.

Pure Python standard library (no pip deps) — same raw AF_CAN + CAN_ISOTP sockets
the daemon uses, so padding/framing interoperate exactly.

    sudo python3 virtual_vehicle.py --iface can1 --vehicle corolla
    python3 virtual_vehicle.py --selftest        # validate responder, no CAN needed
    python3 virtual_vehicle.py --list

Design: the vehicle is DATA (see VEHICLES). Each ECU is a table of what it knows;
one generic responder serves OBD mode 01/03/09 + UDS 10/3E/22/19 and returns
realistic negative responses (7F) for the gated/unsupported services, so the
capability board the AI builds matches what a real ECU would reveal.
"""
import argparse
import socket
import struct
import sys
import threading
import time

# ---- ISO-TP socket constants (mirror the daemon exactly) --------------------
CAN_ISOTP = getattr(socket, "CAN_ISOTP", 6)
SOL_CAN_ISOTP = 106
CAN_ISOTP_OPTS = 1
CAN_ISOTP_TX_PADDING = 0x004
CAN_ISOTP_RX_PADDING = 0x008
AF_CAN = getattr(socket, "AF_CAN", 29)
CAN_RAW = getattr(socket, "CAN_RAW", 1)
PF_CAN = getattr(socket, "PF_CAN", 29)

RUNNING = threading.Event()
RUNNING.set()
T0 = time.time()


def _tick():
    return time.time() - T0


# ---- helpers to build response bytes ----------------------------------------

def ascii_bytes(s, length=None):
    b = s.encode("ascii", "ignore")
    if length is not None:
        b = b[:length].ljust(length, b"\x00")
    return b


def supported_pid_bitmask(pids):
    """OBD mode 01 PID 00 bitmask for PIDs 0x01..0x20 (4 bytes, MSB = PID 0x01)."""
    mask = 0
    for p in pids:
        if 1 <= p <= 0x20:
            mask |= 1 << (32 - p)
    return struct.pack(">I", mask)


# ---- the vehicle model ------------------------------------------------------
# Each ECU: name, category, addresses, supplier + part numbers (UDS DIDs), OBD
# PIDs it answers, DTCs it holds, sessions it accepts, and which action services
# are GATED (answer 7F with a plausible NRC) vs simply unsupported.

def ecu(name, category, req, resp, supplier, part, sw, hw, serial,
        dtcs=None, obd_pids=None, live_dids=None, sessions=(0x01, 0x03),
        kind="uds+obd"):
    return {
        "name": name, "category": category, "req": req, "resp": resp,
        "supplier": supplier,
        "ids": {
            0xF190: None,            # VIN — filled from the vehicle VIN at build
            0xF187: part, 0xF195: sw, 0xF191: hw, 0xF18C: serial,
            0xF18A: supplier, 0xF194: sw,
        },
        "obd_pids": obd_pids or {},
        "live_dids": live_dids or {},   # UDS data DIDs that return live-ish values
        "dtcs": dtcs or [],
        "sessions": set(sessions),
        "kind": kind,
    }


def build_corolla():
    VIN = "JTDEPRAE0LJ012345"  # 2020 Toyota (matches the Chip Lab gold seed)
    # Common engine live PIDs (values are filled live in the responder)
    ENGINE_PIDS = {0x00: None, 0x01: None, 0x04: None, 0x05: None, 0x0C: None,
                   0x0D: None, 0x0F: None, 0x11: None, 0x1F: None, 0x2F: None}
    ecus = [
        ecu("Engine Control Module (ECM)", "powertrain", 0x7E0, 0x7E8,
            "DENSO", "89661-02P70", "8966102P70A0", "156600-1234", "DENSO2019A1",
            dtcs=["P0300", "P0171", "P0420"], obd_pids=ENGINE_PIDS,
            live_dids={0x0146: "rpm", 0x015C: "coolant"}),
        ecu("Transmission (CVT) ECM", "transmission", 0x7E1, 0x7E9,
            "AISIN", "89530-02D10", "8953002D10", "AS-556600", "AISIN2019B",
            dtcs=["P0700", "P0746"], obd_pids={0x00: None, 0x0D: None, 0x05: None},
            live_dids={0x0244: "gear"}),
        ecu("Skid Control (ABS / VSC)", "chassis", 0x7B0, 0x7B8,
            "ADVICS", "44050-02R60", "4405002R60", "ADV-778800", "ADVICS19C",
            dtcs=["C1201", "C1241"], obd_pids={0x00: None},
            live_dids={0x0330: "wheel_speed"}),
        ecu("Airbag / SRS", "safety", 0x780, 0x788,
            "DENSO", "89170-02V00", "8917002V00", "156700-9988", "DENSO19S",
            dtcs=["B0100"], sessions=(0x01, 0x03)),
        ecu("Electric Power Steering (EPS)", "chassis", 0x7A6, 0x7AE,
            "JTEKT", "89650-02U40", "8965002U40", "JTK-334455", "JTEKT19E",
            dtcs=["C1511"]),
        ecu("Main Body ECU (BCM)", "body", 0x720, 0x728,
            "DENSO", "89220-02B10", "8922002B10", "156800-2211", "DENSO19B",
            dtcs=["B2799"], live_dids={0x1120: "door_state"}),
        ecu("Combination Meter (Cluster)", "infotainment", 0x7C4, 0x7CC,
            "DENSO", "83800-02X90", "8380002X90", "156900-7766", "DENSO19M",
            dtcs=[], live_dids={0x1301: "odometer"}),
        ecu("A/C Amplifier (HVAC)", "hvac", 0x7C0, 0x7C8,
            "DENSO", "88650-02C30", "8865002C30", "157000-4433", "DENSO19H",
            dtcs=["B1421"]),
        ecu("Central Gateway (CGW)", "network", 0x750, 0x758,
            "TOYOTA", "89100-02A00", "8910002A00", "157100-0099", "TCGW19N",
            dtcs=[], sessions=(0x01, 0x03)),
        ecu("Forward Recognition (TSS radar/camera)", "safety", 0x7D0, 0x7D8,
            "DENSO", "88210-02090", "8821002090", "157200-5512", "DENSO19R",
            dtcs=["U0129"], live_dids={0x2010: "target_range"}),
        ecu("Smart Key / Certification (immo)", "body", 0x751, 0x759,
            "TOKAI-RIKA", "89784-02010", "8978402010", "TR-990011", "TOKAI19I",
            dtcs=[], sessions=(0x01,)),
        ecu("Parking Assist (Clearance Sonar)", "body", 0x7B6, 0x7BE,
            "DENSO", "89340-02400", "8934002400", "157300-1177", "DENSO19P",
            dtcs=["C1AB2"], live_dids={0x2100: "sonar"}),
    ]
    for e in ecus:
        e["ids"][0xF190] = VIN
    return {
        "name": "2020 Toyota Corolla", "vin": VIN,
        # frames the car continuously broadcasts (id, period_ms, base bytes)
        "broadcast": [
            (0x1C4, 20, "engine"),   # engine rpm/load — fast
            (0x0B4, 50, "speed"),    # wheel/vehicle speed
            (0x224, 100, "brake"),
            (0x3B7, 500, "body"),
        ],
        "ecus": ecus,
    }


VEHICLES = {"corolla": build_corolla}


# ---- the generic OBD/UDS responder ------------------------------------------
# Gated action services: recognised SID, but refused with a realistic NRC.
GATED = {
    0x27: 0x33,   # SecurityAccess -> securityAccessDenied
    0x2E: 0x33,   # WriteDataByIdentifier -> securityAccessDenied
    0x31: 0x22,   # RoutineControl -> conditionsNotCorrect
    0x2F: 0x33,   # InputOutputControl (actuator) -> securityAccessDenied
    0x11: 0x33,   # ECUReset -> securityAccessDenied
    0x23: 0x31,   # ReadMemoryByAddress -> requestOutOfRange (present but locked)
    0x14: 0x22,   # ClearDiagnosticInformation -> conditionsNotCorrect
    0x28: 0x22,   # CommunicationControl
    0x34: 0x33,   # RequestDownload (flash) -> securityAccessDenied
}


def live_pid(pid):
    """Deterministic-but-moving OBD PID values so the bus looks alive."""
    t = _tick()
    if pid == 0x0C:  # RPM: A*256+B = rpm*4  -> idle ~750 rpm wobble
        rpm = int(760 + 40 * (1 + __import__("math").sin(t)))
        v = rpm * 4
        return bytes([(v >> 8) & 0xFF, v & 0xFF])
    if pid == 0x0D:  # speed km/h
        return bytes([int(0 + (t * 3) % 60)])
    if pid == 0x05:  # coolant °C (A-40)
        return bytes([min(90, 40 + int(t)) + 40 & 0xFF])
    if pid == 0x04:  # engine load %
        return bytes([int(30 + 20 * (1 + __import__("math").sin(t / 2)))])
    if pid == 0x11:  # throttle %
        return bytes([int(14 + 6 * (1 + __import__("math").sin(t / 3)))])
    if pid == 0x0F:  # intake air temp
        return bytes([30 + 40])
    if pid == 0x1F:  # run time since start (2 bytes, seconds)
        s = int(t)
        return bytes([(s >> 8) & 0xFF, s & 0xFF])
    if pid == 0x2F:  # fuel level %
        return bytes([int(0.7 * 255)])
    if pid == 0x01:  # monitor status
        return bytes([0x00, 0x07, 0xE5, 0x00])
    return bytes([0x00])


def dtc_bytes(code):
    """'P0300' -> 3 bytes (2 DTC + we append status in the caller)."""
    letter = {"P": 0, "C": 1, "B": 2, "U": 3}.get(code[0].upper(), 0)
    n = int(code[1:], 16)
    b0 = (letter << 6) | ((n >> 8) & 0x3F)
    b1 = n & 0xFF
    return bytes([b0, b1])


def respond(e, data):
    """Compute one ECU's response bytes to a request, or None to stay silent."""
    if not data:
        return None
    sid = data[0]

    # Tester present
    if sid == 0x3E:
        return bytes([0x7E, 0x00])

    # Diagnostic session control
    if sid == 0x10 and len(data) >= 2:
        sub = data[1]
        if sub in e["sessions"]:
            # 50 <sub> <P2> <P2*> — canned timing params
            return bytes([0x50, sub, 0x00, 0x32, 0x01, 0xF4])
        return bytes([0x7F, 0x10, 0x12])  # subFunctionNotSupported

    # ReadDataByIdentifier (UDS)
    if sid == 0x22 and len(data) >= 3:
        did = (data[1] << 8) | data[2]
        if did in e["ids"] and e["ids"][did] is not None:
            val = e["ids"][did]
            payload = ascii_bytes(val) if isinstance(val, str) else bytes(val)
            return bytes([0x62, data[1], data[2]]) + payload
        if did in e.get("live_dids", {}):
            # a small live value that changes over time
            v = int(_tick() * 10) & 0xFFFF
            return bytes([0x62, data[1], data[2], (v >> 8) & 0xFF, v & 0xFF])
        return bytes([0x7F, 0x22, 0x31])  # requestOutOfRange

    # ReadDTCInformation (UDS) — subfunction 0x02 report by status mask
    if sid == 0x19 and len(data) >= 2:
        if data[1] == 0x02:
            out = bytes([0x59, 0x02, 0xFF])
            for c in e["dtcs"]:
                out += dtc_bytes(c) + bytes([0x08])  # status: confirmed
            return out
        return bytes([0x7F, 0x19, 0x12])

    # OBD mode 01 — current data
    if sid == 0x01 and len(data) >= 2:
        pid = data[1]
        if pid == 0x00:
            return bytes([0x41, 0x00]) + supported_pid_bitmask([p for p in e["obd_pids"] if p != 0x00])
        if pid in e["obd_pids"]:
            return bytes([0x41, pid]) + live_pid(pid)
        return None  # OBD: no response to unsupported PID (like a real ECU)

    # OBD mode 03 — stored DTCs
    if sid == 0x03:
        codes = [c for c in e["dtcs"]]
        out = bytes([0x43, len(codes)])
        for c in codes:
            out += dtc_bytes(c)
        return out

    # OBD mode 09 — vehicle info (VIN, calibration)
    if sid == 0x09 and len(data) >= 2:
        if data[1] == 0x02:
            return bytes([0x49, 0x02, 0x01]) + ascii_bytes(e["ids"][0xF190], 17)
        if data[1] == 0x0A:
            return bytes([0x49, 0x0A, 0x01]) + ascii_bytes(e["supplier"], 20)
        if data[1] == 0x00:
            return bytes([0x49, 0x00, 0x55, 0x40, 0x00, 0x00])
        return None

    # KWP-style ReadDataByLocalId (rare on Toyota, kept for coverage)
    if sid == 0x21 and len(data) >= 2:
        v = int(_tick() * 5) & 0xFFFF
        return bytes([0x61, data[1], (v >> 8) & 0xFF, v & 0xFF])

    # Gated action services — recognised but refused with a realistic NRC
    if sid in GATED:
        return bytes([0x7F, sid, GATED[sid]])

    # Everything else: serviceNotSupported
    return bytes([0x7F, sid, 0x11])


# ---- ISO-TP server per ECU + broadcast loop ---------------------------------

def _isotp_bind(iface, rx_id, tx_id):
    s = socket.socket(AF_CAN, socket.SOCK_DGRAM, CAN_ISOTP)
    try:
        opts = struct.pack("=IIBBBB", CAN_ISOTP_TX_PADDING | CAN_ISOTP_RX_PADDING, 0, 0, 0x00, 0x00, 0)
        s.setsockopt(SOL_CAN_ISOTP, CAN_ISOTP_OPTS, opts)
    except OSError:
        pass
    s.settimeout(0.5)
    s.bind((iface, rx_id, tx_id))   # (iface, rx_id, tx_id) — we RX on req, TX on resp
    return s


def serve_ecu(iface, e):
    try:
        sock = _isotp_bind(iface, e["req"], e["resp"])
    except OSError as ex:
        print(f"[vv] {e['name']} bind failed on {iface} {hex(e['req'])}: {ex}", flush=True)
        return
    print(f"[vv] {e['name']}  {hex(e['req'])}->{hex(e['resp'])}", flush=True)
    while RUNNING.is_set():
        try:
            req = sock.recv(4095)
        except socket.timeout:
            continue
        except OSError:
            break
        if not req:
            continue
        try:
            resp = respond(e, bytes(req))
            if resp:
                sock.send(resp)
        except Exception as ex:  # never let one bad frame kill the ECU
            print(f"[vv] {e['name']} error: {ex}", flush=True)
    try:
        sock.close()
    except Exception:
        pass


def broadcast_loop(iface, frames):
    """Raw-CAN periodic broadcast so the passive bus map is alive."""
    try:
        raw = socket.socket(PF_CAN, socket.SOCK_RAW, CAN_RAW)
        raw.bind((iface,))
    except OSError as ex:
        print(f"[vv] broadcast disabled: {ex}", flush=True)
        return
    period = {}
    last = {}
    for (cid, ms, _kind) in frames:
        period[cid] = ms / 1000.0
        last[cid] = 0.0
    while RUNNING.is_set():
        now = _tick()
        for (cid, ms, kind) in frames:
            if now - last[cid] >= period[cid]:
                last[cid] = now
                data = frame_payload(kind, now)
                pkt = struct.pack("=IB3x8s", cid, len(data), data.ljust(8, b"\x00"))
                try:
                    raw.send(pkt)
                except OSError:
                    pass
        time.sleep(0.005)


def frame_payload(kind, now):
    import math
    ctr = int(now * 50) & 0xFF
    if kind == "engine":
        rpm = int(760 + 40 * (1 + math.sin(now))) * 4
        return bytes([(rpm >> 8) & 0xFF, rpm & 0xFF, 0x20, ctr, 0x00, 0x00, 0x00, 0x00])
    if kind == "speed":
        spd = int((now * 3) % 60)
        return bytes([0x00, spd, spd, ctr, 0x00, 0x00, 0x00, 0x00])
    if kind == "brake":
        return bytes([0x00, 0x00, ctr, 0x00, 0x00, 0x00, 0x00, 0x00])
    return bytes([ctr, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])


def run(iface, vehicle_key):
    v = VEHICLES[vehicle_key]()
    print(f"[vv] Virtual Vehicle: {v['name']}  VIN {v['vin']}  on {iface}  ({len(v['ecus'])} ECUs)", flush=True)
    threads = []
    for e in v["ecus"]:
        t = threading.Thread(target=serve_ecu, args=(iface, e), daemon=True)
        t.start()
        threads.append(t)
    bt = threading.Thread(target=broadcast_loop, args=(iface, v["broadcast"]), daemon=True)
    bt.start()
    try:
        while RUNNING.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        RUNNING.clear()
    print("[vv] stopped", flush=True)


# ---- self-test (no CAN needed) ----------------------------------------------

def selftest():
    v = VEHICLES["corolla"]()
    ecm = v["ecus"][0]
    fails = 0

    def check(label, cond):
        nonlocal fails
        print(("PASS  " if cond else "FAIL  ") + label)
        if not cond:
            fails += 1

    # VIN via OBD 09 02
    r = respond(ecm, bytes([0x09, 0x02]))
    check("OBD 09 02 -> VIN", r[:3] == bytes([0x49, 0x02, 0x01]) and r[3:].rstrip(b"\x00").decode() == v["vin"])
    # VIN via UDS 22 F190
    r = respond(ecm, bytes([0x22, 0xF1, 0x90]))
    check("UDS 22 F190 -> VIN", r[:3] == bytes([0x62, 0xF1, 0x90]) and v["vin"].encode() in r)
    # Part number 22 F187
    r = respond(ecm, bytes([0x22, 0xF1, 0x87]))
    check("UDS 22 F187 -> part no", r[:1] == bytes([0x62]) and b"89661-02P70" in r)
    # DTCs via 19 02
    r = respond(ecm, bytes([0x19, 0x02, 0xFF]))
    check("UDS 19 02 -> DTCs present", r[:2] == bytes([0x59, 0x02]) and len(r) > 3)
    # Supported PIDs 01 00
    r = respond(ecm, bytes([0x01, 0x00]))
    check("OBD 01 00 -> supported bitmask", r[:2] == bytes([0x41, 0x00]) and len(r) == 6)
    # Live RPM 01 0C
    r = respond(ecm, bytes([0x01, 0x0C]))
    check("OBD 01 0C -> RPM", r[:2] == bytes([0x41, 0x0C]) and len(r) == 4)
    # Session control accepted
    r = respond(ecm, bytes([0x10, 0x03]))
    check("UDS 10 03 -> extended session", r[:2] == bytes([0x50, 0x03]))
    # Security is gated (7F 27 33) not unsupported
    r = respond(ecm, bytes([0x27, 0x01]))
    check("UDS 27 -> gated (securityAccessDenied)", r == bytes([0x7F, 0x27, 0x33]))
    # Memory read gated
    r = respond(ecm, bytes([0x23, 0x00]))
    check("UDS 23 -> gated (out of range)", r == bytes([0x7F, 0x23, 0x31]))
    # Tester present
    r = respond(ecm, bytes([0x3E, 0x00]))
    check("UDS 3E 00 -> tester present", r == bytes([0x7E, 0x00]))
    # Unknown service unsupported
    r = respond(ecm, bytes([0x99]))
    check("unknown SID -> 7F .. 11", r == bytes([0x7F, 0x99, 0x11]))
    # Every ECU answers tester-present (discoverable)
    check(f"all {len(v['ecus'])} ECUs answer 3E00", all(respond(e, bytes([0x3E, 0x00])) == bytes([0x7E, 0x00]) for e in v["ecus"]))

    print(f"\n=== {'ALL PASS' if fails == 0 else str(fails) + ' FAILED'} · {v['name']} · {len(v['ecus'])} ECUs ===")
    return 0 if fails == 0 else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iface", default="can1")
    ap.add_argument("--vehicle", default="corolla", choices=list(VEHICLES))
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    if args.list:
        for k in VEHICLES:
            v = VEHICLES[k]()
            print(f"{k}: {v['name']} — {len(v['ecus'])} ECUs, VIN {v['vin']}")
        return 0
    if args.selftest:
        return selftest()
    return run(args.iface, args.vehicle)


if __name__ == "__main__":
    sys.exit(main())
