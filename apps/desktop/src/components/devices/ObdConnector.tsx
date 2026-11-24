/**
 * The OBD-II (SAE J1962) connector, front view, pins 1–8 on top and 9–16 below,
 * showing which pins actually reach the Pi. Pins 6/14 → can0 is the wiring that
 * read the 2015 Sprinter end to end; pin 7 (K-line) has no transceiver yet.
 */

type PinKind = "can" | "kline" | "";
interface Pin { n: number; label: string; kind: PinKind; title?: string }

const OEM = "Manufacturer discretionary (no standard use)";

const PINS: Pin[] = [
  { n: 1, label: "OEM use", kind: "", title: OEM },
  { n: 2, label: "J1850 +", kind: "", title: "SAE J1850 bus + (not wired to the Pi)" },
  { n: 3, label: "MS-CAN H", kind: "", title: "Medium-speed CAN high on Ford/Mazda and some others" },
  { n: 4, label: "Chassis GND", kind: "" },
  { n: 5, label: "Signal GND", kind: "" },
  { n: 6, label: "CAN H · can0", kind: "can", title: "ISO 15765 CAN high, wired to the Pi's can0" },
  { n: 7, label: "K-line — not wired yet", kind: "kline", title: "ISO 9141 / KWP2000 K-line — no K-line transceiver on the Pi yet" },
  { n: 8, label: "OEM use", kind: "", title: OEM },
  { n: 9, label: "OEM use", kind: "", title: OEM },
  { n: 10, label: "J1850 −", kind: "", title: "SAE J1850 PWM bus − (not wired to the Pi)" },
  { n: 11, label: "MS-CAN L", kind: "", title: "Medium-speed CAN low on Ford/Mazda and some others" },
  { n: 12, label: "OEM use", kind: "", title: OEM },
  { n: 13, label: "OEM use", kind: "", title: OEM },
  { n: 14, label: "CAN L · can0", kind: "can", title: "ISO 15765 CAN low, wired to the Pi's can0" },
  { n: 15, label: "L-line", kind: "", title: "ISO 9141 L-line (not wired to the Pi)" },
  { n: 16, label: "+12 V", kind: "", title: "Battery positive (unswitched)" },
];

export function ObdConnector({ deviceName }: { deviceName?: string | null }) {
  return (
    <section className="ual-card pad dv-obd" aria-labelledby="dv-obd-title">
      <div className="dv-obd-head">
        <h2 className="ual-h2" id="dv-obd-title">OBD-II connector</h2>
        <span className="ual-muted">{deviceName ? `which pins reach ${deviceName}` : "which pins reach the Pi"}</span>
      </div>
      <ol className="ual-pins" aria-label="OBD-II connector pins 1 to 16">
        {PINS.map((p) => (
          <li key={p.n} className={`ual-pin ${p.kind}`} title={p.title}>
            <span className="n">{p.n}</span>
            <span className="l">{p.label}</span>
          </li>
        ))}
      </ol>
      <div className="dv-legend">
        <span><i className="dv-swatch can" aria-hidden="true" />wired to can0 — proven on the 2015 Sprinter</span>
        <span><i className="dv-swatch kline" aria-hidden="true" />K-line — not wired yet (the Mini needs it)</span>
      </div>
    </section>
  );
}
