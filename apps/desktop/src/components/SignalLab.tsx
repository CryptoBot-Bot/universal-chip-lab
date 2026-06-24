import { useEffect, useRef, useState } from "react";

import { Obd, type CanFrame } from "../lib/obd";

/**
 * Signal Lab — reverse-engineer raw CAN broadcast frames.
 *
 * Polls the bus, groups frames by id, and shows each id's bytes live with the
 * ones that just changed highlighted — so when you move the shifter / rev the
 * engine, the byte that lights up is your signal. Click a byte to define a named
 * signal (offset, length, endianness, scale, offset, unit); definitions persist
 * and decode live. This is how you build a Nissan signal map from scratch.
 */
interface IdRow {
  id: number;
  data: number[];
  changedAt: number[]; // per-byte timestamp of last change (for fade highlight)
  count: number;
  firstMs: number;
  lastMs: number;
}

interface Signal {
  id: number;
  start: number;
  len: 1 | 2;
  be: boolean; // big-endian (first byte is high)
  scale: number;
  offset: number;
  unit: string;
  name: string;
}

const POLL_MS = 350;
const HOT_MS = 1500; // how long a changed byte stays highlighted
const STORE_KEY = "obd.signals.v1";

function loadSignals(): Signal[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Signal[]) : [];
  } catch {
    return [];
  }
}

function decodeSignal(sig: Signal, data: number[]): number | null {
  if (sig.start + sig.len > data.length) return null;
  const raw =
    sig.len === 1
      ? data[sig.start]
      : sig.be
        ? data[sig.start] * 256 + data[sig.start + 1]
        : data[sig.start + 1] * 256 + data[sig.start];
  return raw * sig.scale + sig.offset;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
const hex3 = (n: number) => n.toString(16).toUpperCase().padStart(3, "0");

export function SignalLab({ port }: { port: string }) {
  const [running, setRunning] = useState(false);
  const agg = useRef<Map<number, IdRow>>(new Map());
  const [, setVersion] = useState(0);
  const busy = useRef(false);

  const [signals, setSignals] = useState<Signal[]>(loadSignals);
  const [form, setForm] = useState<Signal>({ id: 0, start: 0, len: 1, be: true, scale: 1, offset: 0, unit: "", name: "" });

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const frames: CanFrame[] = await Obd.canDump(port);
        const now = Date.now();
        for (const f of frames) {
          const bytes: number[] = [];
          for (let i = 0; i + 1 < f.data.length; i += 2) bytes.push(parseInt(f.data.slice(i, i + 2), 16));
          const row = agg.current.get(f.id);
          if (!row) {
            agg.current.set(f.id, { id: f.id, data: bytes, changedAt: bytes.map(() => 0), count: 1, firstMs: now, lastMs: now });
          } else {
            for (let i = 0; i < bytes.length; i++) {
              if (bytes[i] !== row.data[i]) row.changedAt[i] = now;
            }
            row.data = bytes;
            row.count++;
            row.lastMs = now;
          }
        }
        if (!cancelled) setVersion((v) => v + 1);
      } catch {
        /* best-effort */
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [running, port]);

  function persist(next: Signal[]) {
    setSignals(next);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  function addSignal() {
    if (!form.name.trim()) return;
    persist([...signals, { ...form, name: form.name.trim() }]);
  }

  function removeSignal(i: number) {
    persist(signals.filter((_, idx) => idx !== i));
  }

  function clearCapture() {
    agg.current = new Map();
    setVersion((v) => v + 1);
  }

  const rows = [...agg.current.values()].sort((a, b) => a.id - b.id);
  const now = Date.now();
  const latestFor = (id: number) => agg.current.get(id)?.data ?? [];

  return (
    <div className="card mt-16">
      <div className="row spread">
        <h3>Signal Lab <span className="tiny dim">— reverse-engineer raw frames</span></h3>
        <div className="row" style={{ gap: 8 }}>
          <button className="tiny" onClick={clearCapture}>Clear</button>
          <button className={running ? "primary" : ""} onClick={() => setRunning((r) => !r)}>
            {running ? "Stop" : "Start capture"}
          </button>
        </div>
      </div>
      <p className="tiny dim mt-8">
        Start capture, then change something on the vehicle (shift gear, blip throttle). The byte that <span style={{ color: "var(--warn)" }}>highlights</span> when
        you do is your signal — click it to define and name it.
      </p>

      {/* live per-id table */}
      {rows.length > 0 && (
        <div className="mono tiny mt-12" style={{ maxHeight: "30vh", overflow: "auto" }}>
          <div className="row" style={{ gap: 12, opacity: 0.6 }}>
            <span style={{ minWidth: 36 }}>ID</span>
            <span style={{ minWidth: 44 }}>Hz</span>
            <span>bytes (click to define)</span>
          </div>
          {rows.map((r) => {
            const dtSec = (r.lastMs - r.firstMs) / 1000;
            const hz = dtSec > 0.5 ? (r.count / dtSec).toFixed(0) : "—";
            return (
              <div key={r.id} className="row" style={{ gap: 12, marginTop: 4, alignItems: "baseline" }}>
                <span style={{ minWidth: 36, fontWeight: 700 }}>{hex3(r.id)}</span>
                <span style={{ minWidth: 44, opacity: 0.7 }}>{hz}</span>
                <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {r.data.map((b, i) => {
                    const hot = now - r.changedAt[i] < HOT_MS;
                    return (
                      <button
                        key={i}
                        onClick={() => setForm((f) => ({ ...f, id: r.id, start: i }))}
                        title={`id ${hex3(r.id)} byte ${i}`}
                        style={{
                          padding: "1px 4px",
                          fontFamily: "var(--mono)",
                          background: hot ? "var(--warn)" : "var(--bg-3)",
                          color: hot ? "var(--bg-0)" : "var(--fg-0)",
                          border: form.id === r.id && form.start === i ? "1px solid var(--accent)" : "1px solid transparent",
                        }}
                      >
                        {hex2(b)}
                      </button>
                    );
                  })}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {running && rows.length === 0 && <p className="tiny dim mt-12">Listening… no frames yet.</p>}

      {/* define a signal */}
      <div className="card compact mt-12">
        <div className="tiny dim">Define signal {form.id ? `· id ${hex3(form.id)} @ byte ${form.start}` : "· click a byte above"}</div>
        <div className="row wrap mt-8" style={{ gap: 6, alignItems: "center" }}>
          <input type="text" placeholder="name (e.g. Gear)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: 130 }} />
          <select value={form.len} onChange={(e) => setForm({ ...form, len: Number(e.target.value) === 2 ? 2 : 1 })}>
            <option value={1}>1 byte</option>
            <option value={2}>2 bytes</option>
          </select>
          {form.len === 2 && (
            <select value={form.be ? "be" : "le"} onChange={(e) => setForm({ ...form, be: e.target.value === "be" })}>
              <option value="be">big-endian</option>
              <option value="le">little-endian</option>
            </select>
          )}
          <span className="tiny dim">×</span>
          <input type="number" step="any" value={form.scale} onChange={(e) => setForm({ ...form, scale: Number(e.target.value) })} style={{ width: 70 }} title="scale" />
          <span className="tiny dim">+</span>
          <input type="number" step="any" value={form.offset} onChange={(e) => setForm({ ...form, offset: Number(e.target.value) })} style={{ width: 60 }} title="offset" />
          <input type="text" placeholder="unit" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} style={{ width: 60 }} />
          <button className="tiny primary" onClick={addSignal} disabled={!form.name.trim() || !form.id}>Add</button>
        </div>
        <p className="tiny dim mt-8">value = raw × scale + offset. (e.g. RPM often ×0.25; temperature −40 offset.)</p>
      </div>

      {/* decoded signals, live */}
      {signals.length > 0 && (
        <div className="grid cols-2 mt-12" style={{ gap: 8 }}>
          {signals.map((s, i) => {
            const v = decodeSignal(s, latestFor(s.id));
            return (
              <div key={i} className="card compact" style={{ padding: "8px 12px" }}>
                <div className="row spread">
                  <span className="tiny dim">{s.name} <span className="mono">· {hex3(s.id)}[{s.start}{s.len === 2 ? `..${s.start + 1}` : ""}]</span></span>
                  <button className="tiny" onClick={() => removeSignal(i)} title="remove">✕</button>
                </div>
                <div className="mono" style={{ fontSize: 20, fontWeight: 700 }}>
                  {v === null ? "—" : Number.isInteger(v) ? v : v.toFixed(2)}
                  {s.unit && <span className="dim" style={{ fontSize: 13 }}> {s.unit}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
