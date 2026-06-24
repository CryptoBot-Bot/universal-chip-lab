import { useState } from "react";

import { Obd } from "../lib/obd";
import { negativeResponse } from "../lib/uds";

/**
 * UDS console — send any ISO-TP/UDS request to any module and read the raw +
 * decoded reply. The power tool for taking diagnostic control of a module you
 * own (sessions, read/write data, routines, security access). Reuses the
 * firmware's ISOTP primitive.
 *
 * Note: Security Access (0x27) returns a seed; the matching key uses an
 * OEM-specific algorithm you must supply for the target module — this console
 * sends/receives the bytes, it does not compute proprietary keys.
 */
interface Entry {
  req: string;
  resp: string;
  note: string;
  ok: boolean;
}

const QUICK: { label: string; bytes: string }[] = [
  { label: "Tester present", bytes: "3E 00" },
  { label: "Default session", bytes: "10 01" },
  { label: "Extended session", bytes: "10 03" },
  { label: "Programming session", bytes: "10 02" },
  { label: "Request seed", bytes: "27 01" },
  { label: "Read VIN", bytes: "22 F1 90" },
  { label: "Read DTCs", bytes: "19 02 FF" },
  { label: "Clear DTCs", bytes: "14 FF FF FF" },
];

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

function parseHex(s: string): number[] {
  const clean = s.replace(/[^0-9a-fA-F]/g, "");
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

export function UdsConsole({ port }: { port: string }) {
  const [addr, setAddr] = useState("7E1"); // TCM physical request id by default
  const [input, setInput] = useState("3E 00");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Entry[]>([]);

  async function send() {
    const bytes = parseHex(input);
    const txid = parseInt(addr.replace(/[^0-9a-fA-F]/g, ""), 16);
    if (!bytes.length || !Number.isFinite(txid)) return;
    setBusy(true);
    const reqStr = `${txid.toString(16).toUpperCase()} ← ${bytes.map(hex2).join(" ")}`;
    try {
      const resp = await Obd.isotp(port, txid, bytes);
      const nrc = negativeResponse(resp);
      setHistory((h) => [
        { req: reqStr, resp: resp.map(hex2).join(" "), note: nrc ? `negative: ${nrc}` : "positive", ok: !nrc },
        ...h,
      ].slice(0, 30));
    } catch (err) {
      setHistory((h) => [{ req: reqStr, resp: "", note: (err as Error).message, ok: false }, ...h].slice(0, 30));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mt-16">
      <h3>UDS console <span className="tiny dim">— send any service to any module</span></h3>
      <p className="tiny dim mt-8">
        Power tool for diagnostic control of a module you own: sessions, read/write data, routines, security access.
        Best used on a live vehicle — transmitting onto an unACKed bench bus can bus-off the controller.
      </p>

      <div className="row wrap mt-12" style={{ gap: 6, alignItems: "center" }}>
        <span className="tiny dim">to id</span>
        <input value={addr} onChange={(e) => setAddr(e.target.value)} style={{ width: 70 }} className="mono" />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="hex request, e.g. 22 F1 90"
          className="mono"
          style={{ flex: 1, minWidth: 160 }}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
        />
        <button className="primary" onClick={send} disabled={busy}>{busy ? "…" : "Send"}</button>
      </div>

      <div className="row wrap mt-8" style={{ gap: 6 }}>
        {QUICK.map((q) => (
          <button key={q.label} className="tiny" onClick={() => setInput(q.bytes)} title={q.bytes}>{q.label}</button>
        ))}
      </div>

      {history.length > 0 && (
        <pre className="mono tiny" style={{ margin: 0, marginTop: 12, maxHeight: "28vh", overflow: "auto" }}>
          {history.map((e, i) => (
            <span key={i}>
              {`▸ ${e.req}\n`}
              <span style={{ color: e.ok ? "var(--accent)" : "var(--warn)" }}>
                {`  ${e.resp ? e.resp + "  " : ""}(${e.note})\n`}
              </span>
            </span>
          ))}
        </pre>
      )}

      <p className="tiny dim mt-8">
        Security Access (Request seed → send key) needs the OEM key algorithm for this specific module — supply it from
        legitimate tooling. This console moves the bytes; it doesn't compute proprietary keys.
      </p>
    </div>
  );
}
