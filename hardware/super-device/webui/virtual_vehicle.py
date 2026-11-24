#!/usr/bin/env python3
"""
Virtual Vehicle — a full, accurate ISO-TP vehicle that lives on a CAN channel so
the Chip Lab can be developed and tested exactly as against a real car.

Run it on can1 (the "vehicle"), wire can1 ↔ can0 (CANH-CANH, CANL-CANL, both
120Ω terminators ON), and the Chip Lab's whole real pipeline — VIN read, NHTSA
decode, module discovery + identification, AI census, per-module AI deep-map,
live READ/WRITE operations — runs against it on can0 as if it were a real car.

Pure Python standard library (no pip deps) — same raw AF_CAN + CAN_ISOTP sockets
the daemon uses, so padding/framing interoperate exactly.

    sudo python3 virtual_vehicle.py --iface can1 --vehicle corolla
    sudo python3 virtual_vehicle.py --iface can1 --vehicle f150
    python3 virtual_vehicle.py --selftest            # validate responder, no CAN needed
    python3 virtual_vehicle.py --list
    python3 virtual_vehicle.py --describe corolla    # GROUND TRUTH per module (score the AI)
    sudo python3 virtual_vehicle.py --iface vcan0 --replay /var/lib/superdevice/recordings/<id>.jsonl
    python3 virtual_vehicle.py --replay-info <file.jsonl>   # what a recording holds, no CAN needed

--iface vcan0 is a kernel-only bus (no wiring): the daemon creates it when asked
to start a vehicle there. --replay turns a recording the daemon made on a REAL
car (its ISO-TP recorder) into a vehicle that answers what that car answered.

Design: every MODULE TYPE is a real-world TEMPLATE (see TEMPLATES) — the
structure a tester actually meets on that kind of ECU:
  • identification block  22 F180-F19F (boot/app sw, part no, supplier, dates,
    serial, VIN, hw, system name, tester serial, programming date, active session)
  • measurement DIDs      22 0100-01xx — live values with real scalings
  • coding DIDs           22/2E 0200-02xx — configuration, writable after security
  • I/O control           2F 0300-03xx — actuator tests, security-gated
  • routines              31 01 xxxx — self-test / calibrations / resets
  • DTCs                  19 01/02/04/06/0A (count, list, snapshot, extended data,
                          supported), OBD 03/07/0A on emissions modules; active
                          faults re-set ~4 s after a clear
  • OBD mirror            22 F4xx = J1979 PIDs over UDS (powertrain modules)
A vehicle is DATA: a list of modules = template + brand identity + addresses +
faults. Each ECU keeps STATE (session with S3 timeout, security unlock — test key
= bitwise NOT of the seed —, DTC presence, coding values). Memory read (23) and
flash (34/35/36) stay gated: that is the bench path.
"""
import argparse
import json
import math
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
S3_TIMEOUT = 5.0          # seconds without any request before an ECU drops to default session
DTC_RESET_AFTER = 4.0     # seconds after a clear before ACTIVE faults come back
MAX_KEY_ATTEMPTS = 3


def _tick():
    return time.time() - T0


# ---- byte helpers ------------------------------------------------------------

def u8(v):
    return bytes([int(v) & 0xFF])


def u16(v):
    v = int(v) & 0xFFFF
    return bytes([v >> 8, v & 0xFF])


def i16(v):
    return struct.pack(">h", max(-32768, min(32767, int(v))))


def u24(v):
    v = int(v) & 0xFFFFFF
    return bytes([v >> 16, (v >> 8) & 0xFF, v & 0xFF])


def u32(v):
    return struct.pack(">I", int(v) & 0xFFFFFFFF)


def ascii_bytes(s, length=None):
    b = s.encode("ascii", "ignore")
    if length is not None:
        b = b[:length].ljust(length, b"\x00")
    return b


def bcd_date(y, m, d):
    return bytes([int(str(y % 100), 16), int(str(m).zfill(2), 16), int(str(d).zfill(2), 16)])


def supported_pid_bitmask(pids):
    """OBD mode 01 PID 00 bitmask for PIDs 0x01..0x20 (4 bytes, MSB = PID 0x01)."""
    mask = 0
    for p in pids:
        if 1 <= p <= 0x20:
            mask |= 1 << (32 - p)
    return struct.pack(">I", mask)


def vin_check_char(vin17):
    tr = {c: i for i, c in enumerate("0123456789")}
    tr.update({"A": 1, "B": 2, "C": 3, "D": 4, "E": 5, "F": 6, "G": 7, "H": 8, "J": 1, "K": 2, "L": 3, "M": 4,
               "N": 5, "P": 7, "R": 9, "S": 2, "T": 3, "U": 4, "V": 5, "W": 6, "X": 7, "Y": 8, "Z": 9})
    w = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]
    s = sum(tr.get(c, 0) * w[i] for i, c in enumerate(vin17))
    r = s % 11
    return "X" if r == 10 else str(r)


def make_vin(prefix8, year_code, tail7):
    base = prefix8 + "0" + year_code + tail7
    return prefix8 + vin_check_char(base) + year_code + tail7


# ---- live signal generators (deterministic, moving) --------------------------

def rpm(t):
    return 760 + 40 * (1 + math.sin(t))


def speed(t):
    return (t * 3) % 60


def coolant(t):
    return min(90, 40 + t)


def pct(t, base=30, amp=20, period=2.0):
    return base + amp * (1 + math.sin(t / period)) / 2


def wobble(t, base, amp, period=3.0):
    return base + amp * math.sin(t / period)


# ---- MODULE TEMPLATES — real-world structure per ECU type -------------------
# data:    DID -> (label, generator(t) -> bytes, decode)
# coding:  DID -> (label, default bytes, decode)         (2E after security)
# io:      DID -> label                                  (2F after security)
# routines: RID -> (label, needs_security)               (31 01, extended session)
# obd:     answers J1979 01/02/03/04/07/09/0A + mirrors PIDs on 22 F4xx
# security: has SecurityAccess (27); False => 27 -> serviceNotSupported
# sessions: accepted 10 xx sub-functions

def _tpl(system, data, coding, io, routines, obd=False, security=True, sessions=(0x01, 0x02, 0x03), memory="obd_partial"):
    return {"system": system, "data": data, "coding": coding, "io": io, "routines": routines,
            "obd": obd, "security": security, "sessions": set(sessions), "memory": memory}


TEMPLATES = {
    "ecm": _tpl("Engine Control Module", {
        0x0100: ("Engine speed", lambda t: u16(rpm(t) * 4), "rpm = (A*256+B)/4"),
        0x0101: ("Coolant temperature", lambda t: u8(coolant(t) + 40), "°C = A-40"),
        0x0102: ("Intake air temperature", lambda t: u8(28 + 40), "°C = A-40"),
        0x0103: ("Throttle position", lambda t: u8(pct(t, 14, 6, 3) * 255 / 100), "% = A*100/255"),
        0x0104: ("Mass air flow", lambda t: u16(wobble(t, 3.2, 0.6) * 100), "g/s = (A*256+B)/100"),
        0x0105: ("Battery voltage", lambda t: u16(13900 + 80 * math.sin(t * 2)), "V = (A*256+B)/1000"),
        0x0106: ("Fuel trim STFT / LTFT bank 1", lambda t: u8(128 + 3 * math.sin(t)) + u8(131), "% = (A-128)*100/128 each byte"),
        0x0107: ("Ignition timing advance", lambda t: u8((wobble(t, 12, 3) + 64) * 2), "° BTDC = A/2-64"),
        0x0108: ("Engine run time since start", lambda t: u16(t), "s = A*256+B"),
        0x0109: ("Misfire counters cyl 1-4", lambda t: bytes([0, 2, 0, 0]), "count per cylinder"),
        0x010A: ("O2 sensor B1S1 / B1S2 voltage", lambda t: u16(450 + 350 * math.sin(t * 4)) + u16(600), "mV each u16"),
        0x010B: ("VVT intake cam angle", lambda t: u8(wobble(t, 12, 8) + 64), "° = A-64"),
        0x010C: ("Engine oil temperature", lambda t: u8(coolant(t) - 5 + 40), "°C = A-40"),
        0x010D: ("Fuel rail pressure", lambda t: u16(wobble(t, 380, 10)), "kPa = A*256+B"),
        0x010E: ("Vehicle speed", lambda t: u8(speed(t)), "km/h = A"),
        0x010F: ("Immobiliser status", lambda t: u8(0x01), "bit0 key matched, bit1 learning, bit2 fault"),
    }, {
        0x0200: ("Rev limiter", u16(7000), "rpm u16"),
        0x0201: ("Idle speed target", u16(750), "rpm u16"),
        0x0202: ("Immobiliser enabled", b"\x01", "0/1"),
        0x0203: ("Cruise control enabled", b"\x01", "0/1"),
        0x0204: ("Speed limiter", u16(190), "km/h u16 (0 = off)"),
    }, {
        0x0300: "Fuel pump relay", 0x0301: "Radiator fan", 0x0302: "EVAP purge valve", 0x0303: "Check-engine lamp",
    }, {
        0xFF00: ("ECU self-test", False), 0x0203: ("Reset learned values / adaptations", True),
        0x0301: ("Throttle body relearn", False), 0x0302: ("Injector compensation code write", True),
    }, obd=True, memory="bench"),

    "tcm": _tpl("Transmission Control Module", {
        0x0100: ("Gear position", lambda t: u8(1 + int(speed(t) / 15)), "0=P/N, 1-6 = gear (CVT: simulated ratio step)"),
        0x0101: ("ATF temperature", lambda t: u8(coolant(t) - 10 + 40), "°C = A-40"),
        0x0102: ("Input shaft speed", lambda t: u16(rpm(t) * 0.98), "rpm u16"),
        0x0103: ("Output shaft speed", lambda t: u16(speed(t) * 42), "rpm u16"),
        0x0104: ("Line pressure", lambda t: u16(wobble(t, 640, 30)), "kPa u16"),
        0x0105: ("Solenoid currents SL1-SL6", lambda t: b"".join(u16(wobble(t, 400 + 60 * i, 25, 2 + i)) for i in range(6)), "mA u16 ×6"),
        0x0106: ("Torque converter slip", lambda t: u16(wobble(t, 35, 20)), "rpm u16"),
        0x0107: ("Shift lever position", lambda t: u8(0x04), "1=P 2=R 3=N 4=D 5=S"),
        0x0108: ("Gear ratio", lambda t: u16(2400 - speed(t) * 25), "ratio×1000"),
    }, {
        0x0200: ("Shift schedule mode", b"\x00", "0 normal, 1 sport, 2 eco"),
        0x0201: ("ATF change counter", u16(0), "count"),
        0x0202: ("Tow/haul enabled", b"\x00", "0/1"),
    }, {
        0x0300: "Lock-up solenoid", 0x0301: "Line pressure solenoid",
    }, {
        0xFF00: ("ECU self-test", False), 0x0204: ("Reset adaptation values", True), 0x0205: ("ATF service counter reset", False),
    }, obd=True, memory="bench"),

    "abs": _tpl("ABS / Stability Control", {
        0x0100: ("Wheel speeds FL FR RL RR", lambda t: b"".join(u16((speed(t) + i * 0.3) * 100) for i in range(4)), "km/h = u16/100 ×4"),
        0x0101: ("Yaw rate", lambda t: i16(wobble(t, 0, 1.5) * 100), "°/s = i16/100"),
        0x0102: ("Lateral acceleration", lambda t: i16(wobble(t, 0, 0.2, 4) * 1000), "g = i16/1000"),
        0x0103: ("Longitudinal acceleration", lambda t: i16(wobble(t, 0.05, 0.1, 5) * 1000), "g = i16/1000"),
        0x0104: ("Brake pressure", lambda t: u16(0), "kPa u16"),
        0x0105: ("Steering angle (from EPS)", lambda t: i16(wobble(t, 0, 25, 6) * 10), "° = i16/10"),
        0x0106: ("Pump motor / valve status", lambda t: u8(0x00), "bit0 pump on, bit1-4 valves"),
        0x0107: ("Warning lamps", lambda t: u8(0x00), "bit0 ABS, bit1 VSC/ESC, bit2 brake"),
    }, {
        0x0200: ("Tire circumference", u16(1980), "mm u16"),
        0x0201: ("Stability control enabled", b"\x01", "0/1"),
        0x0202: ("Hill-start assist", b"\x01", "0/1"),
    }, {
        0x0300: "Pump motor", 0x0301: "Inlet valve FL", 0x0302: "Outlet valve FL", 0x0303: "ABS warning lamp",
    }, {
        0xFF00: ("ECU self-test", False), 0x0301: ("Brake bleed sequence", False), 0x0302: ("Yaw / G sensor zero-point calibration", True),
        0x0303: ("Steering angle sensor calibration", True),
    }, obd=False, memory="obd_partial"),

    "srs": _tpl("Airbag / Restraints", {
        0x0100: ("Crash event count", lambda t: u8(0), "count (non-zero = deployed, module replace)"),
        0x0101: ("Squib resistance DAB PAB LPT RPT", lambda t: b"".join(u16(v) for v in (215, 220, 198, 201)), "Ω = u16/100 ×4"),
        0x0102: ("Seat occupancy", lambda t: u8(0x01), "bit0 driver, bit1 passenger, bit2 child seat"),
        0x0103: ("Buckle switches", lambda t: u8(0x01), "bit0 driver buckled, bit1 passenger"),
        0x0104: ("Warning lamp", lambda t: u8(0x00), "0 off 1 on"),
        0x0105: ("Backup power voltage", lambda t: u16(24800), "mV u16"),
    }, {}, {}, {
        0xFF00: ("ECU self-test", False),
    }, obd=False, security=False, sessions=(0x01, 0x03), memory="obd_partial"),

    "eps": _tpl("Electric Power Steering", {
        0x0100: ("Steering angle", lambda t: i16(wobble(t, 0, 25, 6) * 10), "° = i16/10"),
        0x0101: ("Steering torque", lambda t: i16(wobble(t, 0, 2.5, 6) * 100), "Nm = i16/100"),
        0x0102: ("Assist motor current", lambda t: u16(abs(wobble(t, 0, 18, 6)) * 1000), "mA u16"),
        0x0103: ("Assist mode", lambda t: u8(1), "0 off 1 normal 2 sport 3 comfort"),
        0x0104: ("Motor temperature", lambda t: u8(48 + 40), "°C = A-40"),
        0x0105: ("Angle sensor calibrated", lambda t: u8(1), "0/1"),
    }, {
        0x0200: ("Assist map", b"\x01", "0 light 1 normal 2 heavy"),
        0x0201: ("Lane-keep assist allowed", b"\x01", "0/1"),
    }, {
        0x0300: "Assist motor drive",
    }, {
        0xFF00: ("ECU self-test", False), 0x0401: ("Steering angle zero-point", False), 0x0402: ("Torque sensor calibration", True),
    }, obd=False, memory="obd_partial"),

    "bcm": _tpl("Body Control Module", {
        0x0100: ("Door ajar", lambda t: u8(0x00), "bit0 FL bit1 FR bit2 RL bit3 RR bit4 trunk bit5 hood"),
        0x0101: ("Lock status", lambda t: u8(0x0F), "bit per door, 1 = locked"),
        0x0102: ("Exterior lights", lambda t: u8(0x00), "bit0 park bit1 low bit2 high bit3 fog bit4 DRL bit5 hazard"),
        0x0103: ("Battery voltage", lambda t: u16(13900 + 80 * math.sin(t * 2)), "mV u16"),
        0x0104: ("Ambient light sensor", lambda t: u8(180), "0-255"),
        0x0105: ("Wiper state", lambda t: u8(0), "0 off 1 int 2 low 3 high"),
        0x0106: ("Key / ignition position", lambda t: u8(2), "0 off 1 acc 2 on 3 start"),
        0x0107: ("Interior temperature", lambda t: u8(24 + 40), "°C = A-40"),
    }, {
        0x0200: ("Auto-lock speed", u8(20), "km/h (0 = off)"),
        0x0201: ("Daytime running lights", b"\x01", "0/1"),
        0x0202: ("Auto headlight sensitivity", b"\x02", "0-4"),
        0x0203: ("Unlock mode", b"\x00", "0 driver first, 1 all doors"),
        0x0204: ("Hazard flash on lock", b"\x01", "0/1"),
        0x0205: ("Headlight-off delay", u8(30), "s"),
    }, {
        0x0300: "Door lock actuators", 0x0301: "Horn", 0x0302: "Hazard lamps", 0x0303: "Dome lamp", 0x0304: "Rear defogger",
    }, {
        0xFF00: ("ECU self-test", False), 0x0601: ("Wiper park position calibration", False), 0x0602: ("Power window initialisation", False),
    }, obd=False, memory="obd"),

    "cluster": _tpl("Instrument Cluster", {
        0x0100: ("Odometer", lambda t: u24(48213), "km u24 (write-protected)"),
        0x0101: ("Fuel level", lambda t: u8(70), "%"),
        0x0102: ("Displayed speed", lambda t: u8(speed(t)), "km/h"),
        0x0103: ("Warning lamps", lambda t: u8(0x00), "bit0 MIL bit1 ABS bit2 SRS bit3 oil bit4 charge bit5 TPMS"),
        0x0104: ("Outside temperature", lambda t: u8(22 + 40), "°C = A-40"),
        0x0105: ("Trip A", lambda t: u16(1234), "km/10 u16"),
        0x0106: ("Backlight level", lambda t: u8(5), "0-7"),
    }, {
        0x0200: ("Units", b"\x00", "0 metric 1 imperial"),
        0x0201: ("Language", b"\x01", "1 EN 2 FR 3 ES 4 DE"),
        0x0202: ("Service interval", u16(10000), "km u16"),
    }, {
        0x0300: "Lamp test (all telltales)", 0x0301: "Gauge drive",
    }, {
        0xFF00: ("ECU self-test", False), 0x0701: ("Gauge sweep", False), 0x0702: ("Service reminder reset", False),
    }, obd=False, memory="bench"),

    "hvac": _tpl("Climate Control", {
        0x0100: ("Set temperature L / R", lambda t: u8(22 * 2) + u8(22 * 2), "°C = A/2 each"),
        0x0101: ("Blower level", lambda t: u8(3), "0-7"),
        0x0102: ("Evaporator temperature", lambda t: u8(wobble(t, 4, 1, 8) + 40), "°C = A-40"),
        0x0103: ("Refrigerant pressure", lambda t: u16(wobble(t, 980, 40, 5)), "kPa u16"),
        0x0104: ("Mode / recirculation", lambda t: u8(0x12), "hi-nibble mode (1 face 2 bi 3 foot 4 def), bit0 recirc"),
        0x0105: ("Cabin temperature", lambda t: u8(24 + 40), "°C = A-40"),
        0x0106: ("Sun load", lambda t: u8(120), "0-255"),
        0x0107: ("Compressor clutch", lambda t: u8(1), "0/1"),
    }, {
        0x0200: ("Temperature offset", b"\x00", "°C signed"),
        0x0201: ("Auto recirculation", b"\x01", "0/1"),
    }, {
        0x0300: "Blower motor", 0x0301: "Compressor clutch", 0x0302: "Blend door actuator", 0x0303: "Mode door actuator",
    }, {
        0xFF00: ("ECU self-test", False), 0x0801: ("Actuator (door) calibration", False),
    }, obd=False, memory="obd"),

    "gateway": _tpl("Central Gateway", {
        0x0100: ("Bus status", lambda t: u8(0x07), "bit0 HS-CAN bit1 MS-CAN bit2 LIN, 1 = active"),
        0x0101: ("Frames routed", lambda t: u32(t * 950), "count u32"),
        0x0102: ("Network state", lambda t: u8(1), "0 sleep 1 awake"),
        0x0103: ("Bus-off counters HS / MS", lambda t: u8(0) + u8(0), "count each"),
    }, {}, {}, {}, obd=False, security=False, sessions=(0x01, 0x03), memory="bench"),

    "radar": _tpl("Forward Radar / ADAS", {
        0x0100: ("Nearest target range / rate", lambda t: u16(wobble(t, 42, 8, 5) * 10) + i16(wobble(t, 0, 1.5, 4) * 100), "m = u16/10, m/s = i16/100"),
        0x0101: ("Alignment angle", lambda t: i16(3), "° = i16/10"),
        0x0102: ("Blockage / weather status", lambda t: u8(0), "0 ok 1 blocked 2 misaligned"),
        0x0103: ("Tracked target count", lambda t: u8(2), "count"),
        0x0104: ("Feature status", lambda t: u8(0x07), "bit0 ACC bit1 PCS bit2 FCW enabled"),
    }, {
        0x0200: ("Forward warning sensitivity", b"\x01", "0 far 1 mid 2 near"),
        0x0201: ("ACC follow distance default", b"\x02", "1-3"),
    }, {}, {
        0xFF00: ("ECU self-test", False), 0x0501: ("Radar aiming / calibration", True),
    }, obd=False, memory="obd_partial"),

    "camera": _tpl("Forward Camera / Lane", {
        0x0100: ("Lane offset left / right", lambda t: i16(wobble(t, 165, 10, 5)) + i16(wobble(t, -170, 10, 5)), "cm = i16 each"),
        0x0101: ("Lane confidence", lambda t: u8(92), "%"),
        0x0102: ("Calibration status", lambda t: u8(1), "0 none 1 ok 2 needed"),
        0x0103: ("Recognised speed sign", lambda t: u8(50), "km/h"),
        0x0104: ("Feature status", lambda t: u8(0x03), "bit0 LKA bit1 LDW bit2 AHB"),
    }, {
        0x0200: ("Lane departure warning sensitivity", b"\x01", "0-2"),
    }, {}, {
        0xFF00: ("ECU self-test", False), 0x0501: ("Camera calibration (target)", True),
    }, obd=False, memory="obd_partial"),

    "immo": _tpl("Immobiliser / Smart Key", {
        0x0100: ("Registered keys", lambda t: u8(2), "count"),
        0x0101: ("Immobiliser state", lambda t: u8(0x01), "bit0 authorised, bit1 learning mode"),
        0x0102: ("Key slot in use", lambda t: u8(1), "1-based"),
    }, {}, {}, {
        0x0601: ("Key registration", True),
    }, obd=False, sessions=(0x01,), memory="bench"),

    "sonar": _tpl("Parking Sonar", {
        0x0100: ("Distances FL FR RL RR", lambda t: b"".join(u8(v) for v in (120, 150, 90, 200)), "cm each"),
        0x0101: ("Sensor status", lambda t: u8(0x00), "bit per sensor, 1 = fault"),
        0x0102: ("System enabled", lambda t: u8(1), "0/1"),
    }, {
        0x0200: ("Detection sensitivity", b"\x01", "0-2"),
        0x0201: ("Buzzer volume", b"\x02", "0-3"),
    }, {
        0x0300: "Buzzer",
    }, {
        0xFF00: ("ECU self-test", False),
    }, obd=False, memory="obd"),
}

# OBD-II mode 01 PIDs answered by emissions modules (values from live_pid)
ENGINE_PIDS = [0x01, 0x04, 0x05, 0x0C, 0x0D, 0x0F, 0x11, 0x1F, 0x2F]
TRANS_PIDS = [0x05, 0x0D]


def live_pid(pid, t):
    if pid == 0x0C:
        return u16(rpm(t) * 4)
    if pid == 0x0D:
        return u8(speed(t))
    if pid == 0x05:
        return u8(coolant(t) + 40)
    if pid == 0x04:
        return u8(pct(t) * 255 / 100)
    if pid == 0x11:
        return u8(pct(t, 14, 6, 3) * 255 / 100)
    if pid == 0x0F:
        return u8(28 + 40)
    if pid == 0x1F:
        return u16(t)
    if pid == 0x2F:
        return u8(0.7 * 255)
    if pid == 0x01:
        return bytes([0x00, 0x07, 0xE5, 0x00])
    return u8(0)


# ---- the vehicle model ------------------------------------------------------

def ecu(tpl, name, category, req, resp, supplier, part, sw, hw, serial,
        dtcs=None, active=None, calid=None, cvn=None, obd_pids=None, mfg=(2019, 11, 14)):
    T = TEMPLATES[tpl]
    active = set(active or [])
    coding = {did: bytes(v[1]) for did, v in T["coding"].items()}
    coding[0xF198] = b"TESTER00"
    return {
        "tpl": tpl, "name": name, "category": category, "req": req, "resp": resp,
        "supplier": supplier, "part": part, "sw": sw, "hw": hw, "serial": serial,
        "calid": calid or sw, "cvn": cvn, "mfg": mfg, "vin": None,
        "obd_pids": obd_pids if obd_pids is not None else (ENGINE_PIDS if tpl == "ecm" else TRANS_PIDS if tpl == "tcm" else []),
        "coding": coding,
        "state": {
            "session": 0x01, "last_rx": 0.0, "unlocked": False, "seed": None, "bad_keys": 0,
            "dtcs": [{"code": c, "active": (c in active), "present": True, "occ": 3 if c in active else 1} for c in (dtcs or [])],
            "cleared_at": None, "resets": 0, "writes": 0,
        },
    }


def build_corolla():
    VIN = make_vin("JTDEPRAE", "L", "J012345")  # 2020 Toyota Corolla LE (NHTSA: ZRE212L, 2ZR-FAE)
    ecus = [
        ecu("ecm", "Engine Control Module (ECM)", "powertrain", 0x7E0, 0x7E8,
            "DENSO", "89661-02P70", "8966102P70A0", "156600-1234", "DENSO2019A1",
            dtcs=["P0300", "P0171", "P0420"], active=["P0171"], cvn="1A2B3C4D"),
        ecu("tcm", "CVT Control ECU", "transmission", 0x7E1, 0x7E9,
            "AISIN", "89530-02D10", "8953002D10", "AS-556600", "AISIN2019B",
            dtcs=["P0700", "P0746"], active=["P0746"]),
        ecu("abs", "Skid Control ECU (ABS / VSC / TRAC)", "chassis", 0x7B0, 0x7B8,
            "ADVICS", "44050-02R60", "4405002R60", "ADV-778800", "ADVICS19C",
            dtcs=["C1201", "C1241"]),
        ecu("srs", "Airbag Sensor Assembly (SRS)", "safety", 0x780, 0x788,
            "DENSO", "89170-02V00", "8917002V00", "156700-9988", "DENSO19S",
            dtcs=["B0100"]),
        ecu("eps", "Power Steering ECU (EPS)", "chassis", 0x7A6, 0x7AE,
            "JTEKT", "89650-02U40", "8965002U40", "JTK-334455", "JTEKT19E",
            dtcs=["C1511"]),
        ecu("bcm", "Main Body ECU", "body", 0x720, 0x728,
            "DENSO", "89220-02B10", "8922002B10", "156800-2211", "DENSO19B",
            dtcs=["B2799"]),
        ecu("cluster", "Combination Meter", "infotainment", 0x7C4, 0x7CC,
            "DENSO", "83800-02X90", "8380002X90", "156900-7766", "DENSO19M",
            dtcs=[]),
        ecu("hvac", "Air Conditioning Amplifier", "hvac", 0x7C0, 0x7C8,
            "DENSO", "88650-02C30", "8865002C30", "157000-4433", "DENSO19H",
            dtcs=["B1421"]),
        ecu("gateway", "Central Gateway ECU (CGW)", "network", 0x750, 0x758,
            "TOYOTA", "89100-02A00", "8910002A00", "157100-0099", "TCGW19N",
            dtcs=[]),
        ecu("radar", "Forward Recognition (TSS millimetre-wave radar)", "safety", 0x7D0, 0x7D8,
            "DENSO", "88210-02090", "8821002090", "157200-5512", "DENSO19R",
            dtcs=["U0129"]),
        ecu("immo", "Certification ECU (Smart Key)", "body", 0x751, 0x759,
            "TOKAI-RIKA", "89784-02010", "8978402010", "TR-990011", "TOKAI19I",
            dtcs=[]),
        ecu("sonar", "Clearance Warning ECU (sonar)", "body", 0x7B6, 0x7BE,
            "DENSO", "89340-02400", "8934002400", "157300-1177", "DENSO19P",
            dtcs=["C1AB2"]),
    ]
    for e in ecus:
        e["vin"] = VIN
    return {
        "name": "2020 Toyota Corolla LE", "vin": VIN,
        "broadcast": [(0x1C4, 20, "engine"), (0x0B4, 50, "speed"), (0x224, 100, "brake"), (0x3B7, 500, "body")],
        "ecus": ecus,
    }


def build_f150():
    """2018 Ford F-150 SuperCrew 4x4 2.7 EcoBoost (NHTSA decode of this VIN) — REAL
    FEPS diagnostic addresses, Ford part-number scheme (J=2018, L3=F-150)."""
    VIN = make_vin("1FTEW1EP", "J", "FA12345")
    ecus = [
        ecu("ecm", "PCM — Powertrain Control Module (2.7 EcoBoost)", "powertrain", 0x7E0, 0x7E8,
            "Continental", "JL3A-12A650-BKC", "JL3A-14C204-AKB", "JL3A-12B684", "FD18PCM650",
            dtcs=["P0299", "P0016"], active=["P0299"], cvn="7F3A91C2"),
        ecu("tcm", "TCM — 10R80 10-speed", "transmission", 0x7E1, 0x7E9,
            "Ford", "JL3P-7A100-AB", "JL3P-7H040-BC", "JL3P-7B012", "FD18TCM100",
            dtcs=["P0711"]),
        ecu("abs", "ABS — Anti-lock Brake Module", "chassis", 0x760, 0x768,
            "Continental", "JL3T-2C405-AF", "JL3T-2C219-AC", "JL3T-2B373", "FD18ABS405",
            dtcs=["C0031"]),
        ecu("srs", "RCM — Restraints Control Module", "safety", 0x737, 0x73F,
            "Autoliv", "JL3T-14B321-AE", "JL3T-14C097-AB", "JL3T-14C060", "FD18RCM321",
            dtcs=["B1193"]),
        ecu("eps", "PSCM — Power Steering Control Module", "chassis", 0x730, 0x738,
            "Nexteer", "JL3T-3D070-AD", "JL3T-3F809-AB", "JL3T-3F840", "FD18EPS070",
            dtcs=[]),
        ecu("cluster", "IPC — Instrument Panel Cluster", "infotainment", 0x720, 0x728,
            "Visteon", "JL3T-10849-AKB", "JL3T-14C026-AA", "JL3T-10D889", "FD18IPC849",
            dtcs=["U0100"]),
        ecu("gateway", "GWM — Gateway Module", "network", 0x716, 0x71E,
            "Continental", "JL3T-14G371-AC", "JL3T-14H015-AA", "JL3T-14H075", "FD18GWM371",
            dtcs=[]),
        ecu("camera", "IPMA — Image Processing Module (lane camera)", "safety", 0x706, 0x70E,
            "Bosch", "JL3T-19H406-AF", "JL3T-19H407-AB", "JL3T-19G490", "FD18CMR406",
            dtcs=["B11E4"]),
        ecu("bcm", "BCM — Body Control Module", "body", 0x726, 0x72E,
            "Ford", "JL3T-15604-CHE", "JL3T-14B476-AAE", "JL3T-14A068", "FD18BCM604",
            dtcs=["B1D14"]),
    ]
    for e in ecus:
        e["vin"] = VIN
    return {
        "name": "2018 Ford F-150 SuperCrew", "vin": VIN,
        "broadcast": [(0x204, 10, "engine"), (0x415, 20, "speed"), (0x216, 50, "brake"), (0x3B3, 500, "body")],
        "ecus": ecus,
    }


VEHICLES = {"corolla": build_corolla, "f150": build_f150}


# ---- the generic OBD/UDS responder ------------------------------------------
ALWAYS_GATED = {
    0x23: 0x31,   # ReadMemoryByAddress -> requestOutOfRange (present but locked)
    0x34: 0x33,   # RequestDownload (flash) -> securityAccessDenied
    0x35: 0x33,   # RequestUpload
    0x36: 0x24,   # TransferData -> requestSequenceError
    0x28: 0x22,   # CommunicationControl
    0x3D: 0x33,   # WriteMemoryByAddress
}


def dtc_bytes(code):
    letter = {"P": 0, "C": 1, "B": 2, "U": 3}.get(code[0].upper(), 0)
    n = int(code[1:], 16)
    return bytes([(letter << 6) | ((n >> 8) & 0x3F), n & 0xFF])


def dtc_bytes_to_code(b3):
    letter = "PCBU"[(b3[0] >> 6) & 0x3]
    n = ((b3[0] & 0x3F) << 8) | b3[1]
    return f"{letter}{n:04X}"


def _present_dtcs(e):
    st = e["state"]
    if st["cleared_at"] is not None and _tick() - st["cleared_at"] >= DTC_RESET_AFTER:
        for d in st["dtcs"]:
            if d["active"]:
                d["present"] = True
                d["occ"] += 1
        st["cleared_at"] = None
    return [d for d in st["dtcs"] if d["present"]]


def _dtc_status(d):
    return 0x2F if d["active"] else 0x08


def _s3_check(e):
    st = e["state"]
    now = _tick()
    if st["session"] != 0x01 and st["last_rx"] and now - st["last_rx"] > S3_TIMEOUT:
        st["session"] = 0x01
        st["unlocked"] = False
        st["seed"] = None
    st["last_rx"] = now


def _seed_for(e):
    st = e["state"]
    base = (e["req"] * 7919 + st["resets"] * 131 + st["writes"] * 17 + int(_tick() * 10)) & 0xFFFFFFFF
    return struct.pack(">I", base | 0x01010101)


def key_for_seed(seed):
    """The documented TEST security algorithm: key = bitwise NOT of the seed."""
    return bytes((~b) & 0xFF for b in seed)


def ident_value(e, did):
    """The identification block 22 F18x/F19x — what a real ECU carries."""
    T = TEMPLATES[e["tpl"]]
    y, m, d = e["mfg"]
    d2 = d + 5 if d < 25 else d
    table = {
        0xF180: "BOOT-" + e["sw"][:10], 0xF181: e["sw"], 0xF182: e["sw"] + "-DATA",
        0xF186: bytes([e["state"]["session"]]),
        0xF187: e["part"], 0xF188: e["sw"], 0xF189: e["sw"][-6:], 0xF18A: e["supplier"],
        0xF18B: bcd_date(y, m, d), 0xF18C: e["serial"], 0xF190: e["vin"], 0xF191: e["hw"],
        0xF192: e["hw"] + "-S", 0xF193: "01", 0xF194: e["sw"], 0xF195: e["sw"][-4:] + ".1",
        0xF197: T["system"], 0xF199: bcd_date(y, m, d2), 0xF19D: bcd_date(y, m, d2),
    }
    v = table.get(did)
    if v is None:
        return None
    return ascii_bytes(v) if isinstance(v, str) else v


def respond(e, data):
    """Compute one ECU's response bytes to a request, or None to stay silent."""
    if not data:
        return None
    _s3_check(e)
    T = TEMPLATES[e["tpl"]]
    st = e["state"]
    sid = data[0]
    in_ext = st["session"] != 0x01
    t = _tick()

    if sid == 0x3E:
        return bytes([0x7E, 0x00])

    if sid == 0x10 and len(data) >= 2:
        sub = data[1] & 0x7F
        if sub in T["sessions"]:
            if sub == 0x01:
                st["unlocked"] = False
                st["seed"] = None
            st["session"] = sub
            return bytes([0x50, sub, 0x00, 0x32, 0x01, 0xF4])
        return bytes([0x7F, 0x10, 0x12])

    if sid == 0x11 and len(data) >= 2:
        if not in_ext:
            return bytes([0x7F, 0x11, 0x7F])
        sub = data[1] & 0x7F
        if sub not in (0x01, 0x02, 0x03):
            return bytes([0x7F, 0x11, 0x12])
        st["resets"] += 1
        st["session"] = 0x01
        st["unlocked"] = False
        st["seed"] = None
        return bytes([0x51, sub])

    # ReadDataByIdentifier
    if sid == 0x22 and len(data) >= 3:
        did = (data[1] << 8) | data[2]
        hdr = bytes([0x62, data[1], data[2]])
        iv = ident_value(e, did)
        if iv is not None:
            return hdr + iv
        if did in e["coding"]:
            return hdr + bytes(e["coding"][did])
        if did in T["data"]:
            return hdr + T["data"][did][1](t)
        if 0xF400 <= did <= 0xF4FF and T["obd"]:
            pid = did & 0xFF
            if pid == 0x00:
                return hdr + supported_pid_bitmask(e["obd_pids"])
            if pid in e["obd_pids"]:
                return hdr + live_pid(pid, t)
        return bytes([0x7F, 0x22, 0x31])

    # WriteDataByIdentifier — coding: extended session + security
    if sid == 0x2E and len(data) >= 4:
        did = (data[1] << 8) | data[2]
        if not in_ext:
            return bytes([0x7F, 0x2E, 0x7F])
        if did not in e["coding"]:
            return bytes([0x7F, 0x2E, 0x31])   # identification / measurement DIDs are read-only
        if not st["unlocked"]:
            return bytes([0x7F, 0x2E, 0x33])
        e["coding"][did] = bytes(data[3:])
        st["writes"] += 1
        return bytes([0x6E, data[1], data[2]])

    # SecurityAccess
    if sid == 0x27 and len(data) >= 2:
        if not T["security"]:
            return bytes([0x7F, 0x27, 0x11])
        sub = data[1]
        if not in_ext:
            return bytes([0x7F, 0x27, 0x7F])
        if st["bad_keys"] >= MAX_KEY_ATTEMPTS:
            return bytes([0x7F, 0x27, 0x36])
        if sub == 0x01:
            if st["unlocked"]:
                return bytes([0x67, 0x01, 0x00, 0x00, 0x00, 0x00])
            st["seed"] = _seed_for(e)
            return bytes([0x67, 0x01]) + st["seed"]
        if sub == 0x02:
            if st["seed"] is None:
                return bytes([0x7F, 0x27, 0x24])
            if bytes(data[2:6]) == key_for_seed(st["seed"]):
                st["unlocked"] = True
                st["seed"] = None
                st["bad_keys"] = 0
                return bytes([0x67, 0x02])
            st["bad_keys"] += 1
            st["seed"] = None
            return bytes([0x7F, 0x27, 0x35])
        return bytes([0x7F, 0x27, 0x12])

    # ReadDTCInformation
    if sid == 0x19 and len(data) >= 2:
        sub = data[1]
        present = _present_dtcs(e)
        if sub == 0x01:   # number of DTCs by status mask
            return bytes([0x59, 0x01, 0xFF, 0x01]) + u16(len(present))
        if sub == 0x02:   # DTCs by status mask
            out = bytes([0x59, 0x02, 0xFF])
            for d in present:
                out += dtc_bytes(d["code"]) + bytes([0x00, _dtc_status(d)])
            return out
        if sub == 0x04 and len(data) >= 6:   # snapshot record: the first 3 measurement DIDs at the time of fault
            code = dtc_bytes_to_code(data[2:5])
            d = next((x for x in present if x["code"] == code), None)
            if not d:
                return bytes([0x7F, 0x19, 0x31])
            out = bytes([0x59, 0x04]) + bytes(data[2:5]) + bytes([_dtc_status(d), 0x01])
            dids = list(T["data"].keys())[:3]
            out += bytes([len(dids)])
            for did in dids:
                out += u16(did) + T["data"][did][1](t * 0.37)   # a frozen-looking sample
            return out
        if sub == 0x06 and len(data) >= 6:   # extended data: occurrence + aging counters
            code = dtc_bytes_to_code(data[2:5])
            d = next((x for x in present if x["code"] == code), None)
            if not d:
                return bytes([0x7F, 0x19, 0x31])
            return bytes([0x59, 0x06]) + bytes(data[2:5]) + bytes([_dtc_status(d), 0x01, d["occ"] & 0xFF, 0x00 if d["active"] else 0x28])
        if sub == 0x0A:   # supported DTCs
            out = bytes([0x59, 0x0A, 0xFF])
            for d in st["dtcs"]:
                out += dtc_bytes(d["code"]) + bytes([0x00, _dtc_status(d) if d["present"] else 0x00])
            return out
        return bytes([0x7F, 0x19, 0x12])

    if sid == 0x14:
        if not in_ext:
            return bytes([0x7F, 0x14, 0x7F])
        for d in st["dtcs"]:
            d["present"] = False
        st["cleared_at"] = _tick()
        return bytes([0x54])

    # RoutineControl
    if sid == 0x31 and len(data) >= 4:
        sub = data[1]
        rid = (data[2] << 8) | data[3]
        if not in_ext:
            return bytes([0x7F, 0x31, 0x7F])
        if rid not in T["routines"]:
            return bytes([0x7F, 0x31, 0x31])
        if T["routines"][rid][1] and not st["unlocked"]:
            return bytes([0x7F, 0x31, 0x33])
        if sub in (0x01, 0x02, 0x03):
            return bytes([0x71, sub, data[2], data[3], 0x00])
        return bytes([0x7F, 0x31, 0x12])

    # InputOutputControlByIdentifier
    if sid == 0x2F and len(data) >= 4:
        did = (data[1] << 8) | data[2]
        if not in_ext:
            return bytes([0x7F, 0x2F, 0x7F])
        if did not in T["io"]:
            return bytes([0x7F, 0x2F, 0x31])
        if not st["unlocked"]:
            return bytes([0x7F, 0x2F, 0x33])
        return bytes([0x6F, data[1], data[2], data[3]]) + (bytes(data[4:5]) if len(data) > 4 else b"")

    # ---- OBD-II (emissions modules only) ----
    if T["obd"]:
        if sid == 0x01 and len(data) >= 2:
            pid = data[1]
            if pid == 0x00:
                return bytes([0x41, 0x00]) + supported_pid_bitmask(e["obd_pids"])
            if pid in e["obd_pids"]:
                return bytes([0x41, pid]) + live_pid(pid, t)
            return None
        if sid == 0x02 and len(data) >= 3:   # freeze frame 0
            pid = data[1]
            if pid in e["obd_pids"] and _present_dtcs(e):
                return bytes([0x42, pid, data[2]]) + live_pid(pid, t * 0.37)
            return None
        if sid in (0x03, 0x07, 0x0A):
            present = _present_dtcs(e)
            if sid == 0x07:
                present = [d for d in present if d["active"]]
            elif sid == 0x0A:
                present = []
            out = bytes([sid + 0x40, len(present)])
            for d in present:
                out += dtc_bytes(d["code"])
            return out
        if sid == 0x04:
            for d in st["dtcs"]:
                d["present"] = False
            st["cleared_at"] = _tick()
            return bytes([0x44])
        if sid == 0x09 and len(data) >= 2:
            if data[1] == 0x02:
                return bytes([0x49, 0x02, 0x01]) + ascii_bytes(e["vin"], 17)
            if data[1] == 0x04:
                return bytes([0x49, 0x04, 0x01]) + ascii_bytes(e["calid"], 16)
            if data[1] == 0x06 and e.get("cvn"):
                return bytes([0x49, 0x06, 0x01]) + bytes.fromhex(e["cvn"])
            if data[1] == 0x0A:
                return bytes([0x49, 0x0A, 0x01]) + ascii_bytes(T["system"][:20], 20)
            if data[1] == 0x00:
                return bytes([0x49, 0x00, 0x55, 0x40, 0x00, 0x00])
            return None
    elif sid in (0x01, 0x02, 0x03, 0x04, 0x07, 0x09, 0x0A):
        return None   # non-emissions modules stay silent to J1979 (like real ones)

    if sid == 0x21 and len(data) >= 2:   # KWP ReadDataByLocalId — not used by these makers
        return bytes([0x7F, 0x21, 0x11])

    if sid in ALWAYS_GATED:
        return bytes([0x7F, sid, ALWAYS_GATED[sid]])

    return bytes([0x7F, sid, 0x11])


# ---- ISO-TP server per ECU + broadcast loop ---------------------------------

CAN_EFF_FLAG = 0x80000000


def _can_id(i):
    """29-bit ("extended") ids carry the EFF flag on the wire, as in the daemon."""
    return i | CAN_EFF_FLAG if i > 0x7FF else i


def _isotp_bind(iface, rx_id, tx_id):
    s = socket.socket(AF_CAN, socket.SOCK_DGRAM, CAN_ISOTP)
    try:
        opts = struct.pack("=IIBBBB", CAN_ISOTP_TX_PADDING | CAN_ISOTP_RX_PADDING, 0, 0, 0x00, 0x00, 0)
        s.setsockopt(SOL_CAN_ISOTP, CAN_ISOTP_OPTS, opts)
    except OSError:
        pass
    s.settimeout(0.5)
    s.bind((iface, _can_id(rx_id), _can_id(tx_id)))
    return s


def serve_ecu(iface, e, responder=None):
    responder = responder or respond
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
            resp = responder(e, bytes(req))
            if resp:
                sock.send(resp)
        except Exception as ex:
            print(f"[vv] {e['name']} error: {ex}", flush=True)
    try:
        sock.close()
    except Exception:
        pass


def broadcast_loop(iface, frames):
    try:
        raw = socket.socket(PF_CAN, socket.SOCK_RAW, CAN_RAW)
        raw.bind((iface,))
    except OSError as ex:
        print(f"[vv] broadcast disabled: {ex}", flush=True)
        return
    period = {cid: ms / 1000.0 for (cid, ms, _) in frames}
    last = {cid: 0.0 for (cid, _, _) in frames}
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
    ctr = int(now * 50) & 0xFF
    if kind == "engine":
        r = int(rpm(now)) * 4
        return bytes([(r >> 8) & 0xFF, r & 0xFF, 0x20, ctr, 0x00, 0x00, 0x00, 0x00])
    if kind == "speed":
        spd = int(speed(now))
        return bytes([0x00, spd, spd, ctr, 0x00, 0x00, 0x00, 0x00])
    if kind == "brake":
        return bytes([0x00, 0x00, ctr, 0x00, 0x00, 0x00, 0x00, 0x00])
    return bytes([ctr, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])


def run(iface, vehicle_key):
    v = VEHICLES[vehicle_key]()
    print(f"[vv] Virtual Vehicle: {v['name']}  VIN {v['vin']}  on {iface}  ({len(v['ecus'])} ECUs)", flush=True)
    for e in v["ecus"]:
        threading.Thread(target=serve_ecu, args=(iface, e), daemon=True).start()
    threading.Thread(target=broadcast_loop, args=(iface, v["broadcast"]), daemon=True).start()
    try:
        while RUNNING.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        RUNNING.clear()
    print("[vv] stopped", flush=True)


# ---- replay: a vehicle rebuilt from a recording --------------------------------
# The daemon's recorder logs every ISO-TP exchange with a car as JSONL ("x" lines:
# tx, rx, req, resp) plus bus-monitor snapshots ("bus" lines). load_replay() turns
# one such file into ECUs — one per (request id, response id) pair that answered —
# that reply to each request with what the car replied:
#   • keyed by the diagnostic session the request was made in (the same 22 xxxx can
#     answer differently in the extended session), falling back to any session;
#   • a request recorded several times cycles through its recorded answers in
#     order, so live values move the way they moved on the car;
#   • a request the car never saw gets silence (a timeout), not an invented reply.
# Broadcast traffic is replayed from the last bus snapshot (last bytes, real rates).

REPLAY_MAX_ANSWERS = 64      # per request, per session
REPLAY_MAX_FPS = 1500        # total broadcast frames per second


def load_replay(path):
    ecus, bus, used = {}, {}, {}
    label, vin, lines, bad = "", "", 0, 0
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                bad += 1          # the torn last line of a session still being written
                continue
            lines += 1
            kind = r.get("type")
            if kind == "session":
                label = r.get("label") or r.get("id") or label
            elif kind == "bus":
                if r.get("frames"):
                    bus[r.get("iface")] = r["frames"]
            elif kind == "x":
                try:
                    tx, rx = int(r["tx"], 16), int(r["rx"], 16)
                except (KeyError, ValueError, TypeError):
                    continue
                req = str(r.get("req") or "").lower()
                resp = str(r.get("resp") or "").lower()
                if not req:
                    continue
                e = ecus.get((tx, rx))
                if e is None:
                    e = ecus[(tx, rx)] = {
                        "name": f"replay {tx:X}->{rx:X}", "req": tx, "resp": rx, "table": {}, "any": {},
                        "silent": set(), "asked": 0, "_sess": 0x01, "_last": 0.0, "cursor": {},
                        "state": {"session": 0x01, "last_rx": 0.0},
                    }
                t = float(r.get("t") or 0.0)
                if e["_sess"] != 0x01 and e["_last"] and t - e["_last"] > S3_TIMEOUT:
                    e["_sess"] = 0x01      # the car's own S3 timer dropped it back to default
                e["_last"] = t
                e["asked"] += 1
                used[r.get("iface")] = used.get(r.get("iface"), 0) + 1
                if not resp:
                    e["silent"].add(req)
                    continue
                for table, key in ((e["table"], (e["_sess"], req)), (e["any"], req)):
                    seq = table.setdefault(key, [])
                    if len(seq) < REPLAY_MAX_ANSWERS:
                        seq.append(resp)
                if req[:2] == "10" and resp[:2] == "50" and len(resp) >= 4:
                    e["_sess"] = int(resp[2:4], 16) & 0x7F
                elif req[:2] == "11" and resp[:2] == "51":
                    e["_sess"] = 0x01
                if not vin and (resp.startswith("490201") or resp.startswith("62f190")):
                    txt = "".join(chr(b) for b in bytes.fromhex(resp[6:]) if 0x20 < b < 0x7F)
                    if len(txt) >= 11:
                        vin = txt[:17]
    answering = {k: e for k, e in ecus.items() if e["any"]}
    main_iface = max(used, key=used.get) if used else None
    frames = bus.get(main_iface) or next(iter(bus.values()), [])
    diag_ids = {i for e in answering.values() for i in (e["req"], e["resp"])}
    broadcast = []
    for fr in frames:
        try:
            text = str(fr["id"])
            cid = int(text, 16)
            data = bytes.fromhex(str(fr.get("bytes", "")).replace(" ", ""))[:8]
            hz = float(fr.get("hz") or 0)
        except (KeyError, ValueError, TypeError):
            continue
        if cid in diag_ids or hz <= 0:
            continue
        broadcast.append((cid | CAN_EFF_FLAG if len(text) > 3 else cid, min(hz, 100.0), data))
    total = sum(hz for _, hz, _ in broadcast)
    if total > REPLAY_MAX_FPS:
        broadcast = [(c, hz * REPLAY_MAX_FPS / total, d) for (c, hz, d) in broadcast]
    return {"name": f"replay of {label or path}", "vin": vin, "ecus": list(answering.values()), "silent_only": len(ecus) - len(answering),
            "broadcast": broadcast, "lines": lines, "bad_lines": bad, "iface": main_iface}


def replay_respond(e, data):
    """Answer one request from the recording, or None (silence) if the car never answered it."""
    st = e["state"]
    now = _tick()
    if st["session"] != 0x01 and st["last_rx"] and now - st["last_rx"] > S3_TIMEOUT:
        st["session"] = 0x01
    st["last_rx"] = now
    req = bytes(data).hex()
    key = (st["session"], req)
    seq = e["table"].get(key)
    if not seq:
        key = ("any", req)
        seq = e["any"].get(req)
    if not seq:
        return None
    i = e["cursor"].get(key, 0)
    e["cursor"][key] = i + 1
    resp = bytes.fromhex(seq[i % len(seq)])
    if req[:2] == "10" and resp[:1] == b"\x50" and len(resp) >= 2:
        st["session"] = resp[1] & 0x7F
    elif req[:2] == "11" and resp[:1] == b"\x51":
        st["session"] = 0x01
    return resp


def replay_broadcast_loop(iface, frames):
    try:
        raw = socket.socket(PF_CAN, socket.SOCK_RAW, CAN_RAW)
        raw.bind((iface,))
    except OSError as ex:
        print(f"[vv] broadcast disabled: {ex}", flush=True)
        return
    items = [(struct.pack("=IB3x8s", cid, len(data), data.ljust(8, b"\x00")), 1.0 / hz) for (cid, hz, data) in frames]
    due = [_tick() + i * 0.0007 for i in range(len(items))]
    while RUNNING.is_set():
        now = _tick()
        for i, (pkt, period) in enumerate(items):
            if now >= due[i]:
                due[i] = now + period
                try:
                    raw.send(pkt)
                except OSError:
                    pass
        time.sleep(0.002)


def replay_info(path):
    v = load_replay(path)
    print(f"# {v['name']} — VIN {v['vin'] or 'not read'} — {len(v['ecus'])} answering address pair(s), "
          f"{v['silent_only']} that never answered, {len(v['broadcast'])} broadcast id(s), {v['lines']} line(s)"
          + (f", {v['bad_lines']} unreadable" if v["bad_lines"] else ""))
    for e in sorted(v["ecus"], key=lambda x: x["req"]):
        answers = sum(len(s) for s in e["any"].values())
        sessions = sorted({k[0] for k in e["table"]})
        print(f"  {e['req']:X}->{e['resp']:X}  {len(e['any'])} distinct request(s), {answers} answer(s) kept, {e['asked']} asked, "
              f"{len(e['silent'])} unanswered, session(s) {' '.join(f'{s:02X}' for s in sessions)}")
    return 0 if v["ecus"] else 1


def run_replay(iface, path):
    try:
        v = load_replay(path)
    except OSError as ex:
        print(f"[vv] cannot read the recording: {ex}", flush=True)
        return 1
    if not v["ecus"]:
        print(f"[vv] nothing to replay in {path}: no exchange got an answer", flush=True)
        return 1
    print(f"[vv] Virtual Vehicle: {v['name']}  VIN {v['vin'] or '?'}  on {iface}  ({len(v['ecus'])} address pairs, "
          f"{len(v['broadcast'])} broadcast ids)", flush=True)
    for e in v["ecus"]:
        threading.Thread(target=serve_ecu, args=(iface, e, replay_respond), daemon=True).start()
    if v["broadcast"]:
        threading.Thread(target=replay_broadcast_loop, args=(iface, v["broadcast"]), daemon=True).start()
    try:
        while RUNNING.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        RUNNING.clear()
    print("[vv] stopped", flush=True)
    return 0


# ---- ground truth ------------------------------------------------------------

def describe(vehicle_key):
    """Print what each module REALLY holds — the answer key for scoring the AI mapper."""
    v = VEHICLES[vehicle_key]()
    print(f"# {v['name']} — VIN {v['vin']} — {len(v['ecus'])} modules")
    for e in v["ecus"]:
        T = TEMPLATES[e["tpl"]]
        print(f"\n## {e['req']:03X}→{e['resp']:03X}  {e['name']}  [{e['category']} / template {e['tpl']}]")
        print(f"   part {e['part']} · supplier {e['supplier']} · sw {e['sw']} · hw {e['hw']} · serial {e['serial']} · system \"{T['system']}\"")
        print(f"   sessions {sorted(hex(s) for s in T['sessions'])} · security {'yes (key = NOT seed)' if T['security'] else 'NO (27 unsupported)'} · OBD {'yes' if T['obd'] else 'no'} · memory read: {T['memory']}")
        print("   identification: F180 F181 F182 F186 F187 F188 F189 F18A F18B F18C F190 F191 F192 F193 F194 F195 F197 F198(w) F199 F19D")
        for did, (label, _, dec) in T["data"].items():
            print(f"   22 {did:04X}  {label:38s} {dec}")
        for did, (label, dflt, dec) in T["coding"].items():
            print(f"   2E {did:04X}  {label:38s} default {dflt.hex()} · {dec}   [security]")
        for did, label in T["io"].items():
            print(f"   2F {did:04X}  {label}   [security]")
        for rid, (label, sec) in T["routines"].items():
            print(f"   31 01 {rid:04X}  {label}{'   [security]' if sec else ''}")
        if T["obd"]:
            print(f"   OBD 01 PIDs {' '.join(f'{p:02X}' for p in e['obd_pids'])} · 09 02/04/06/0A · 03/07/0A · 22 F4xx mirror")
        dt = ", ".join(f"{d['code']}{' (active)' if d['active'] else ''}" for d in e["state"]["dtcs"]) or "none"
        print(f"   DTCs: {dt} · 19 01/02/04/06/0A")


IDENT_DIDS = [0xF180, 0xF181, 0xF182, 0xF186, 0xF187, 0xF188, 0xF189, 0xF18A, 0xF18B, 0xF18C, 0xF190,
              0xF191, 0xF192, 0xF193, 0xF194, 0xF195, 0xF197, 0xF198, 0xF199, 0xF19D]


def describe_json(vehicle_key):
    """The same answer key as describe(), as one JSON object — what the calibration bench
    scores the AI mapper against (pnpm vehicle bench)."""
    v = VEHICLES[vehicle_key]()
    mods = []
    for e in v["ecus"]:
        T = TEMPLATES[e["tpl"]]
        mods.append({
            "req": f"{e['req']:03X}", "resp": f"{e['resp']:03X}", "name": e["name"], "category": e["category"], "template": e["tpl"],
            "part": e["part"], "supplier": e["supplier"], "sw": e["sw"], "hw": e["hw"], "serial": e["serial"], "system": T["system"],
            "sessions": sorted(f"{s:02X}" for s in T["sessions"]), "security": bool(T["security"]), "obd": bool(T["obd"]),
            "identification": [f"{d:04X}" for d in IDENT_DIDS],
            "data": [{"did": f"{did:04X}", "label": label, "decode": dec} for did, (label, _, dec) in T["data"].items()],
            "coding": [{"did": f"{did:04X}", "label": label} for did, (label, _d, _dec) in T["coding"].items()],
            "io": [{"did": f"{did:04X}", "label": label} for did, label in T["io"].items()],
            "routines": [{"rid": f"{rid:04X}", "label": label, "security": bool(sec)} for rid, (label, sec) in T["routines"].items()],
            "obd_pids": [f"{p:02X}" for p in e.get("obd_pids", [])] if T["obd"] else [],
            "dtcs": [d["code"] for d in e["state"]["dtcs"]],
        })
    return {"vehicle": vehicle_key, "name": v["name"], "vin": v["vin"], "modules": mods}


# ---- self-test (no CAN needed) ----------------------------------------------

def selftest():
    global DTC_RESET_AFTER
    fails = 0

    def check(label, cond):
        nonlocal fails
        print(("PASS  " if cond else "FAIL  ") + label)
        if not cond:
            fails += 1

    for key in VEHICLES:
        v = VEHICLES[key]()
        ecm = v["ecus"][0]
        print(f"--- {v['name']} ({key}) VIN {v['vin']}")
        check("VIN check digit valid", vin_check_char(v["vin"]) == v["vin"][8])
        r = respond(ecm, bytes([0x09, 0x02]))
        check("OBD 09 02 -> VIN", r[:3] == bytes([0x49, 0x02, 0x01]) and r[3:].rstrip(b"\x00").decode() == v["vin"])
        check("OBD 09 04 -> CALID", respond(ecm, bytes([0x09, 0x04]))[:3] == bytes([0x49, 0x04, 0x01]))
        r = respond(ecm, bytes([0x22, 0xF1, 0x90]))
        check("UDS 22 F190 -> VIN", r[:3] == bytes([0x62, 0xF1, 0x90]) and v["vin"].encode() in r)
        check("UDS 22 F187 -> part no", ecm["part"].encode() in respond(ecm, bytes([0x22, 0xF1, 0x87])))
        check("UDS 22 F197 -> system name", b"Engine Control" in respond(ecm, bytes([0x22, 0xF1, 0x97])))
        check("UDS 22 F186 -> active session", respond(ecm, bytes([0x22, 0xF1, 0x86])) == bytes([0x62, 0xF1, 0x86, 0x01]))
        check("UDS 22 0100 -> engine speed u16", len(respond(ecm, bytes([0x22, 0x01, 0x00]))) == 5)
        check("UDS 22 0200 -> coding readable", respond(ecm, bytes([0x22, 0x02, 0x00])) == bytes([0x62, 0x02, 0x00]) + u16(7000))
        check("UDS 22 F40C -> OBD mirror rpm", respond(ecm, bytes([0x22, 0xF4, 0x0C]))[:3] == bytes([0x62, 0xF4, 0x0C]))
        check("UDS 22 unknown -> 7F 31", respond(ecm, bytes([0x22, 0x0A, 0xAA])) == bytes([0x7F, 0x22, 0x31]))
        n = len(_present_dtcs(ecm))
        r = respond(ecm, bytes([0x19, 0x02, 0xFF]))
        check("UDS 19 02 -> DTCs (4 bytes each)", r[:2] == bytes([0x59, 0x02]) and len(r) == 3 + 4 * n and n > 0)
        check("UDS 19 01 -> count", respond(ecm, bytes([0x19, 0x01, 0xFF])) == bytes([0x59, 0x01, 0xFF, 0x01]) + u16(n))
        first = r[3:6]
        snap = respond(ecm, bytes([0x19, 0x04]) + first + bytes([0x01]))
        check("UDS 19 04 -> snapshot with 3 DIDs", snap[:2] == bytes([0x59, 0x04]) and snap[7] == 3)
        ext = respond(ecm, bytes([0x19, 0x06]) + first + bytes([0x01]))
        check("UDS 19 06 -> extended data", ext[:2] == bytes([0x59, 0x06]) and len(ext) == 9)
        check("OBD 01 00 -> supported bitmask", len(respond(ecm, bytes([0x01, 0x00]))) == 6)
        check("OBD 01 0C -> RPM", len(respond(ecm, bytes([0x01, 0x0C]))) == 4)
        check("14 in default session -> 7F 7F", respond(ecm, bytes([0x14, 0xFF, 0xFF, 0xFF])) == bytes([0x7F, 0x14, 0x7F]))
        check("27 01 in default session -> 7F 7F", respond(ecm, bytes([0x27, 0x01])) == bytes([0x7F, 0x27, 0x7F]))
        check("UDS 10 03 -> extended session", respond(ecm, bytes([0x10, 0x03]))[:2] == bytes([0x50, 0x03]))
        check("2E without security -> 7F 33", respond(ecm, bytes([0x2E, 0xF1, 0x98, 0x41])) == bytes([0x7F, 0x2E, 0x33]))
        check("2E on measurement DID -> 7F 31 (read-only)", respond(ecm, bytes([0x2E, 0x01, 0x00, 0x41])) == bytes([0x7F, 0x2E, 0x31]))
        r = respond(ecm, bytes([0x27, 0x01]))
        check("27 01 -> seed", r[:2] == bytes([0x67, 0x01]) and len(r) == 6 and r[2:] != b"\x00\x00\x00\x00")
        check("27 02 wrong key -> 7F 35", respond(ecm, bytes([0x27, 0x02, 0, 0, 0, 0])) == bytes([0x7F, 0x27, 0x35]))
        r = respond(ecm, bytes([0x27, 0x01])); seed = r[2:]
        check("27 02 right key -> 67 02", respond(ecm, bytes([0x27, 0x02]) + key_for_seed(seed)) == bytes([0x67, 0x02]))
        check("2E 0200 rev limiter after unlock -> 6E", respond(ecm, bytes([0x2E, 0x02, 0x00]) + u16(6500)) == bytes([0x6E, 0x02, 0x00]))
        check("22 0200 reads written value", respond(ecm, bytes([0x22, 0x02, 0x00])) == bytes([0x62, 0x02, 0x00]) + u16(6500))
        check("2F 0300 fuel pump after unlock -> 6F", respond(ecm, bytes([0x2F, 0x03, 0x00, 0x03, 0x01]))[:1] == bytes([0x6F]))
        check("31 01 FF00 self-test -> 71", respond(ecm, bytes([0x31, 0x01, 0xFF, 0x00]))[:2] == bytes([0x71, 0x01]))
        check("31 01 unknown -> 7F 31", respond(ecm, bytes([0x31, 0x01, 0x12, 0x34])) == bytes([0x7F, 0x31, 0x31]))
        check("14 FFFFFF -> 54", respond(ecm, bytes([0x14, 0xFF, 0xFF, 0xFF])) == bytes([0x54]))
        check("19 02 after clear -> empty", respond(ecm, bytes([0x19, 0x02, 0xFF])) == bytes([0x59, 0x02, 0xFF]))
        saved = DTC_RESET_AFTER; DTC_RESET_AFTER = 0.0
        r = respond(ecm, bytes([0x19, 0x02, 0xFF]))
        active_n = sum(1 for d in ecm["state"]["dtcs"] if d["active"])
        check("active DTCs re-set after clear", len(r) == 3 + 4 * active_n and active_n > 0)
        DTC_RESET_AFTER = saved
        check("11 01 -> 51 01", respond(ecm, bytes([0x11, 0x01])) == bytes([0x51, 0x01]))
        check("after reset: 2E -> 7F 7F (default session)", respond(ecm, bytes([0x2E, 0xF1, 0x98, 0x41])) == bytes([0x7F, 0x2E, 0x7F]))
        check("UDS 23 -> gated (out of range)", respond(ecm, bytes([0x23, 0x00])) == bytes([0x7F, 0x23, 0x31]))
        check("UDS 34 -> gated (security)", respond(ecm, bytes([0x34, 0x00])) == bytes([0x7F, 0x34, 0x33]))
        srs = next(e for e in v["ecus"] if e["tpl"] == "srs")
        respond(srs, bytes([0x10, 0x03]))
        check("SRS: 27 -> serviceNotSupported (no security)", respond(srs, bytes([0x27, 0x01])) == bytes([0x7F, 0x27, 0x11]))
        check("SRS: OBD 01 00 silent (non-emissions)", respond(srs, bytes([0x01, 0x00])) is None)
        check("SRS: 22 0101 squib resistances 8 bytes", len(respond(srs, bytes([0x22, 0x01, 0x01]))) == 11)
        bcm = next(e for e in v["ecus"] if e["tpl"] == "bcm")
        check("BCM: 22 0200 auto-lock coding", respond(bcm, bytes([0x22, 0x02, 0x00])) == bytes([0x62, 0x02, 0x00, 20]))
        check(f"all {len(v['ecus'])} ECUs answer 3E00", all(respond(e, bytes([0x3E, 0x00])) == bytes([0x7E, 0x00]) for e in v["ecus"]))
        check("every ECU has part + supplier + template", all(e["part"] and e["supplier"] and e["tpl"] in TEMPLATES for e in v["ecus"]))
        check("no two ECUs share a request id", len({e["req"] for e in v["ecus"]}) == len(v["ecus"]))
        check("all templates have >=3 measurement DIDs", all(len(TEMPLATES[e["tpl"]]["data"]) >= 3 for e in v["ecus"]))

    # replay: a recording in, the same answers out
    import os
    import tempfile
    print("--- replay of a recording")
    rec = [
        {"type": "session", "id": "t", "label": "selftest car"},
        {"type": "x", "t": 100.0, "iface": "can0", "tx": "7E0", "rx": "7E8", "req": "0902", "resp": "490201" + b"JTDEPRAE0LJ012345".hex()},
        {"type": "x", "t": 100.1, "iface": "can0", "tx": "7E0", "rx": "7E8", "req": "220100", "resp": "7f2231"},
        {"type": "x", "t": 100.2, "iface": "can0", "tx": "7E0", "rx": "7E8", "req": "1003", "resp": "5003003201f4"},
        {"type": "x", "t": 100.3, "iface": "can0", "tx": "7E0", "rx": "7E8", "req": "220100", "resp": "6201000bb8"},
        {"type": "x", "t": 100.4, "iface": "can0", "tx": "7E0", "rx": "7E8", "req": "220100", "resp": "6201000bc0"},
        {"type": "x", "t": 100.5, "iface": "can0", "tx": "7E0", "rx": "7E8", "req": "2e0200ff", "resp": "", "err": "TimeoutError"},
        {"type": "x", "t": 101.0, "iface": "can0", "tx": "7C0", "rx": "7C8", "req": "3e00", "resp": "", "err": "TimeoutError"},
        {"type": "x", "t": 102.0, "iface": "can0", "tx": "18DA10F1", "rx": "18DAF110", "req": "3e00", "resp": "7e00"},
        {"type": "bus", "iface": "can0", "window_ms": 700, "frames": [
            {"id": "1C4", "dlc": 8, "bytes": "0B E0 20 11 00 00 00 00", "hz": 50.0},
            {"id": "7E8", "dlc": 8, "bytes": "02 7E 00 00 00 00 00 00", "hz": 1.4}]},
    ]
    fd, tmp = tempfile.mkstemp(suffix=".jsonl")
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(json.dumps(r) for r in rec) + '\n{"type":"x","t":103,"tx":"7E0"')   # + a torn last line
    try:
        v = load_replay(tmp)
        check("replay: 2 answering pairs, 1 silent-only, VIN found", len(v["ecus"]) == 2 and v["silent_only"] == 1 and v["vin"] == "JTDEPRAE0LJ012345")
        check("replay: torn last line skipped", v["bad_lines"] == 1)
        check("replay: diagnostic id kept out of the broadcast", [c for c, _, _ in v["broadcast"]] == [0x1C4])
        e = next(x for x in v["ecus"] if x["req"] == 0x7E0)
        check("replay: default session -> the default-session answer", replay_respond(e, bytes.fromhex("220100")) == bytes.fromhex("7f2231"))
        check("replay: 10 03 accepted", replay_respond(e, bytes.fromhex("1003"))[:2] == bytes([0x50, 0x03]))
        a, b, c = (replay_respond(e, bytes.fromhex("220100")) for _ in range(3))
        check("replay: extended session cycles the recorded samples", (a, b, c) == (bytes.fromhex("6201000bb8"), bytes.fromhex("6201000bc0"), bytes.fromhex("6201000bb8")))
        check("replay: a request the car never answered -> silence", replay_respond(e, bytes.fromhex("2e0200ff")) is None)
        check("replay: a request never recorded -> silence", replay_respond(e, bytes.fromhex("22f187")) is None)
        check("replay: 29-bit pair kept", any(x["req"] == 0x18DA10F1 for x in v["ecus"]) and _can_id(0x18DA10F1) & CAN_EFF_FLAG)
    finally:
        os.remove(tmp)

    print(f"\n=== {'ALL PASS' if fails == 0 else str(fails) + ' FAILED'} · {len(VEHICLES)} vehicles · {len(TEMPLATES)} module templates ===")
    return 0 if fails == 0 else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iface", default="can1")
    ap.add_argument("--vehicle", default="corolla", choices=list(VEHICLES))
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--describe", metavar="VEHICLE", choices=list(VEHICLES))
    ap.add_argument("--describe-json", metavar="VEHICLE", choices=list(VEHICLES), help="the answer key as JSON (calibration bench)")
    ap.add_argument("--replay", metavar="FILE", help="serve what a recorded car answered (a daemon recording, .jsonl)")
    ap.add_argument("--replay-info", metavar="FILE", help="print what a recording holds and exit (no CAN needed)")
    args = ap.parse_args()
    if args.replay_info:
        return replay_info(args.replay_info)
    if args.replay:
        return run_replay(args.iface, args.replay)
    if args.list:
        for k in VEHICLES:
            v = VEHICLES[k]()
            print(f"{k}: {v['name']} — {len(v['ecus'])} ECUs, VIN {v['vin']}")
        return 0
    if args.describe:
        describe(args.describe)
        return 0
    if args.describe_json:
        print(json.dumps(describe_json(args.describe_json)))
        return 0
    if args.selftest:
        return selftest()
    return run(args.iface, args.vehicle)


if __name__ == "__main__":
    sys.exit(main())
