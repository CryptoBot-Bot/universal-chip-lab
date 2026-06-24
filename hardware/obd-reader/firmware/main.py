"""
OBD-Reader v1  -  Car-powered CAN / battery telemetry firmware (RP2040 / MicroPython)
Part of the Universal Chip Lab project.

This is the *deployable* firmware for the OBD-II reader you soldered (see
../BUILD.md). It powers itself from the car's 12 V via the LM2596 buck, measures
battery voltage through the R1/R2 divider on GP28, and speaks the SAME tiny ASCII
"command -> OK/ERR" protocol as PicoForge over USB, so the Universal Chip Lab
desktop app drives it with no extra plumbing. You can also poke it by hand in any
serial monitor: type PING then HELP.

  ┌─ Why command/reply (not a free-running printer)?
  │  The desktop app's serial layer sends one line and waits for a line that
  │  starts with OK/ERR. So we answer on demand (the app polls BATT ~1/sec for a
  │  live read-out) instead of spamming the port. Same model as picoforge/main.py.
  └─

Serial protocol (one command per line; replies start with OK or ERR):
    PING            -> OK OBD-Reader v1
    HELP            -> command list
    INFO            -> calibration + thresholds + CAN status
    BATT            -> OK <ms>,<volts>,<state>,<vmin>,<vmax>   (one battery sample)
    CAL <ratio>     -> set the divider ratio (default 5.7); echoes it back
    RESET           -> clear the vmin/vmax session min & max
    CANINIT [<bps>] -> bring up the CAN bus (default 500000); see CAN note below
    CANDUMP         -> recent CAN frames as  id#hexdata  tokens (newest last)
    SIM <scenario>  -> bench simulator: feed FAKE data so the desktop app can be
                       polished with no car. scenario = OFF | IGNITION | WEAK |
                       IDLE | DRIVE. While on, BATT and CANDUMP return synthesized
                       values (a real engine-start voltage climb + OBD-II frames).
                       Always clearly a SIMULATION — never confuse it with a car.

Hardware (see ../BUILD.md for the full solder guide):
    GP28 / ADC2   battery-sense divider  R1=47k (top) / R2=10k (bottom), ratio 5.7
    GP25          onboard LED            heartbeat (~2 Hz)
    GP5  / GP4    HS-CAN TX / RX  -> SN65HVD230 -> OBD 6 / 14   (500 kbit/s)
    GP7  / GP6    MS-CAN TX / RX  -> SN65HVD230 -> OBD 3 / 11   (125 kbit/s)
    GP8  / GP9    K-line TX / RX  -> L9637D     -> OBD 7        (not soldered yet)

CAN note: the RP2040 has NO hardware CAN controller. Real CAN needs the `can2040`
PIO driver, which stock MicroPython does not ship. CANINIT/CANDUMP below detect
whether a `can2040`-style module is importable and, if not, return an honest ERR
telling you which firmware to flash — the rest of the device (battery telemetry,
the protocol, the app dashboard) works today regardless. Battery telemetry is
what proves your bench: feed 12 V, watch BATT track it; in the car it climbs from
~12.6 V (ignition) to ~14.4 V once the alternator spins.
"""
import sys
import select
import time
from machine import ADC, Pin

FIRMWARE = "OBD-Reader v1"

# ---- Calibration (battery-sense divider) -----------------------------------
# Divider ratio = (R1 + R2) / R2 = (47000 + 10000) / 10000 = 5.7
# Bench-calibrate once: feed a known 12.00 V, read BATT, nudge RATIO until the
# printed volts match your multimeter (absorbs resistor tolerance). VREF is the
# Pico's 3V3 rail (measure it — it's rarely exactly 3.300).
VREF = 3.3
ADC_MAX = 65535

# ---- Thresholds (12 V lead-acid) -------------------------------------------
V_LOW = 11.8        # below this: weak / discharged battery
V_CHARGING = 13.2   # at/above this: alternator is running

# ---- Bench simulator --------------------------------------------------------
# Steady target volts per scenario; DRIVE is scripted in sim_voltage() to animate
# a full key-on -> crank -> alternator climb. Lets the desktop app be exercised
# end-to-end with no car. SIM data is always flagged so it's never mistaken real.
SIM_SCENARIOS = {
    "IGNITION": 12.5,   # key on, engine off
    "WEAK": 11.4,       # tired battery -> LOW
    "IDLE": 13.9,       # engine running, charging
    "DRIVE": 14.3,      # cruising (scripted start-up ramp first)
}

# ---- Pin map ---------------------------------------------------------------
ADC_BATT = 2              # GP28 = ADC2 = battery-sense node
HS_CAN_TX, HS_CAN_RX = 5, 4
MS_CAN_TX, MS_CAN_RX = 7, 6
KLINE_TX, KLINE_RX = 8, 9


class ObdReader:
    def __init__(self):
        self.ratio = 5.7
        self.adc = ADC(ADC_BATT)
        try:
            self.hb = Pin("LED", Pin.OUT)     # Pico W onboard LED
        except Exception:
            self.hb = Pin(25, Pin.OUT)        # classic Pico onboard LED

        self.t0 = time.ticks_ms()
        self.vmin = 99.0
        self.vmax = 0.0

        self.can = None        # set by CANINIT once a real CAN driver is present
        self.can_bps = 0

        self.sim = None        # None = off, else a SIM_SCENARIOS key (bench simulator)
        self.sim_t0 = 0
        self.sim_cleared = False  # set by a simulated Mode 04 (clear DTCs)

        self.poll = select.poll()
        self.poll.register(sys.stdin, select.POLLIN)

    # ---------------- bench simulator ----------------
    def sim_voltage(self):
        """Synthesized battery volts for the active SIM scenario. DRIVE scripts a
        key-on -> crank dip -> alternator climb so the app's gauge animates."""
        t = time.ticks_diff(time.ticks_ms(), self.sim_t0) / 1000.0
        base = SIM_SCENARIOS.get(self.sim, 12.5)
        if self.sim == "DRIVE":
            if t < 3:        base = 12.5                  # ignition, engine off
            elif t < 4:      base = 10.2                  # cranking dip
            elif t < 12:     base = 12.6 + (t - 4) * 0.21 # alternator ramps up
            else:            base = 14.3                  # steady charge
        # mild deterministic jitter (no RNG needed) so it reads like real silicon
        jitter = (((time.ticks_ms() // 100) % 7) - 3) * 0.02
        return base + jitter

    def sim_frames(self):
        """A few realistic OBD-II mode-01 response frames (ECU id 0x7E8) whose
        values move over time: engine RPM, vehicle speed, coolant temperature."""
        t = time.ticks_diff(time.ticks_ms(), self.sim_t0) // 1000
        rpm = 800 + (t % 30) * 80            # 800..3120 rpm
        speed = t % 70                       # 0..69 km/h
        coolant_c = min(92, 25 + t)          # warms 25 -> 92 degC
        rv = rpm * 4                          # PID 0x0C scaling: ((A*256)+B)/4
        frames = [
            (0x7E8, bytes([0x04, 0x41, 0x0C, (rv >> 8) & 0xFF, rv & 0xFF])),
            (0x7E8, bytes([0x03, 0x41, 0x0D, speed & 0xFF])),
            (0x7E8, bytes([0x03, 0x41, 0x05, (coolant_c + 40) & 0xFF])),
        ]
        return " ".join("%X#%s" % (i, d.hex()) for i, d in frames)

    # ---------------- battery sense ----------------
    def read_battery(self, samples=16):
        """Median-of-samples ADC read -> battery volts. Median rejects spikes."""
        if self.sim:
            return self.sim_voltage()
        vals = []
        for _ in range(samples):
            vals.append(self.adc.read_u16())
            time.sleep_ms(1)
        vals.sort()
        raw = vals[len(vals) // 2]            # median sample
        v_adc = raw / ADC_MAX * VREF          # volts at GP28
        return v_adc * self.ratio             # scaled back to the battery

    @staticmethod
    def classify(vb):
        if vb < V_LOW:
            return "LOW"
        if vb >= V_CHARGING:
            return "CHARGING"
        return "OK"

    def batt_line(self):
        vb = self.read_battery()
        self.vmin = min(self.vmin, vb)
        self.vmax = max(self.vmax, vb)
        ms = time.ticks_diff(time.ticks_ms(), self.t0)
        return "%d,%.2f,%s,%.2f,%.2f" % (ms, vb, self.classify(vb), self.vmin, self.vmax)

    # ---------------- OBD-II request/response (active diagnostics) ----------------
    # A real scan tool doesn't just sniff the bus — it SENDS a request (Mode + PID)
    # and the ECU answers. obd_query() is that round-trip. In SIM it fabricates
    # believable answers; with real can2040 it'll send the request frame to 0x7DF
    # and ISO-TP-reassemble the 0x7E8 response. Returns the response DATA bytes
    # (everything after the 0x4X service echo): for Mode 01 that's [PID, A, B, ...].
    def _sim_pid(self, pid):
        t = time.ticks_diff(time.ticks_ms(), self.sim_t0) // 1000
        if pid == 0x00: return bytes([0x18, 0x1A, 0x80, 0x03])  # supported 01-20 (+chain)
        if pid == 0x20: return bytes([0x00, 0x02, 0x00, 0x01])  # supported 21-40 (+chain)
        if pid == 0x40: return bytes([0x40, 0x00, 0x00, 0x00])  # supported 41-60
        if pid == 0x04: return bytes([(t * 7 % 100) * 255 // 100])      # engine load %
        if pid == 0x05: return bytes([min(92, 25 + t) + 40])           # coolant degC
        if pid == 0x0C:
            rv = (800 + (t % 30) * 80) * 4
            return bytes([(rv >> 8) & 0xFF, rv & 0xFF])                # RPM
        if pid == 0x0D: return bytes([t % 70])                         # speed km/h
        if pid == 0x0F: return bytes([30 + 40])                        # intake air degC
        if pid == 0x11: return bytes([((t * 3 % 80) + 10) * 255 // 100])  # throttle %
        if pid == 0x1F: return bytes([(t >> 8) & 0xFF, t & 0xFF])      # run time s
        if pid == 0x2F: return bytes([60 * 255 // 100])                # fuel level %
        if pid == 0x42: return bytes([0x37, 0x78])                     # module V = 14.2
        return None  # not supported in sim

    def obd_query(self, mode, pid):
        if not self.sim:
            raise OSError("real OBD-II needs can2040 firmware (sim only for now)")
        if mode == 0x01:
            if pid is None:
                raise OSError("Mode 01 needs a PID")
            v = self._sim_pid(pid)
            if v is None:
                raise OSError("PID 0x%02X not supported" % pid)
            return bytes([pid]) + v
        if mode == 0x03:                                   # stored DTCs
            return b"" if self.sim_cleared else bytes([0x03, 0x01, 0x04, 0x20])  # P0301, P0420
        if mode in (0x07, 0x0A):                           # pending / permanent: none
            return b""
        if mode == 0x09 and pid == 0x02:                   # VIN
            return bytes([0x02, 0x01]) + b"1HGSIM0000PICO123"
        if mode == 0x04:                                   # clear DTCs + MIL
            self.sim_cleared = True
            return b""
        raise OSError("Mode 0x%02X not simulated" % mode)

    # ---------------- CAN (real hardware only) ----------------
    def can_init(self, bps):
        """Try to stand up a CAN bus. Stock MicroPython has no CAN, so this is a
        best-effort import of a can2040-style driver; honest failure otherwise."""
        if self.sim:                  # bench simulator: pretend the bus is up
            self.can = "sim"
            self.can_bps = bps
            return bps
        try:
            import can2040  # provided only by a custom firmware build
        except ImportError:
            raise OSError("CAN needs can2040 firmware (RP2040 has no HW CAN); "
                          "battery telemetry works without it")
        # A real can2040 binding would be initialised here on GP5/GP4.
        self.can = can2040.CAN(tx=HS_CAN_TX, rx=HS_CAN_RX, bitrate=bps)
        self.can_bps = bps
        return bps

    def can_dump(self):
        if not self.can:
            raise OSError("CAN not initialised (run CANINIT) / needs can2040 firmware")
        if self.can == "sim":
            return self.sim_frames()
        frames = []
        for f in self.can.recv_all():           # newest-last
            frames.append("%X#%s" % (f.id, bytes(f.data).hex()))
        return " ".join(frames) if frames else "(no frames)"

    # ------------- serial command handler -------------
    def handle(self, line):
        parts = line.strip().split()
        if not parts:
            return
        cmd = parts[0].upper()
        try:
            if cmd == "PING":
                print("OK " + FIRMWARE)
            elif cmd == "HELP":
                print("OK cmds: PING INFO BATT CAL<ratio> RESET "
                      "CANINIT[<bps>] CANDUMP OBD<mode>[<pid>] "
                      "SIM<OFF|IGNITION|WEAK|IDLE|DRIVE>")
            elif cmd == "INFO":
                cs = ("up @ %d bps" % self.can_bps) if self.can else "off (needs can2040)"
                sm = self.sim if self.sim else "off"
                print("OK ratio=%.3f | low=%.1f charging=%.1f | can=%s | sim=%s | 12V->5.1V->Pico"
                      % (self.ratio, V_LOW, V_CHARGING, cs, sm))
            elif cmd == "SIM":
                arg = (parts[1].upper() if len(parts) > 1 else "OFF")
                if arg == "OFF":
                    self.sim = None
                    if self.can == "sim":   # tear down the fake bus too
                        self.can = None
                        self.can_bps = 0
                    print("OK sim off")
                elif arg in SIM_SCENARIOS:
                    self.sim = arg
                    self.sim_t0 = time.ticks_ms()
                    self.sim_cleared = False   # a fresh scenario re-arms the fake DTCs
                    print("OK sim=%s (SIMULATION - not a real car)" % arg)
                else:
                    print("ERR scenario must be OFF|IGNITION|WEAK|IDLE|DRIVE")
            elif cmd == "BATT":
                print("OK " + self.batt_line())
            elif cmd == "CAL":
                self.ratio = float(parts[1])
                print("OK ratio=%.3f" % self.ratio)
            elif cmd == "RESET":
                self.vmin = 99.0
                self.vmax = 0.0
                print("OK min/max cleared")
            elif cmd == "CANINIT":
                bps = int(parts[1]) if len(parts) > 1 else 500000
                self.can_init(bps)
                print("OK can up @ %d bps" % bps)
            elif cmd == "CANDUMP":
                print("OK " + self.can_dump())
            elif cmd == "OBD":
                mode = int(parts[1], 16)
                pid = int(parts[2], 16) if len(parts) > 2 else None
                data = self.obd_query(mode, pid)
                print("OK " + bytes(data).hex())
            else:
                print("ERR unknown cmd (try HELP)")
        except Exception as e:
            print("ERR " + str(e))

    # ------------- main loop -------------
    def run(self):
        print(FIRMWARE + " ready. Type HELP and press Enter.")
        last_hb = time.ticks_ms()
        while True:
            now = time.ticks_ms()
            if time.ticks_diff(now, last_hb) > 250:
                self.hb.toggle()
                last_hb = now

            if self.poll.poll(0):
                line = sys.stdin.readline()
                if line:
                    self.handle(line)

            time.sleep_ms(10)


ObdReader().run()
