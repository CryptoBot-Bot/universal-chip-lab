import { useMemo, useState } from "react";

/**
 * A paginated, editable hex + ASCII view. Renders one 512-byte page at a time
 * (32 rows of 16 bytes) so even a 64 KB EEPROM stays responsive. Both columns
 * are editable: type hex in the hex cells, or type characters directly in the
 * ASCII cells (Delete/Backspace blanks a byte to 0xFF). Edits are reported via
 * `onEdit`; the parent owns the buffer and the dirty set.
 */
const ROW = 16;
const PAGE_ROWS = 32;
const PAGE = ROW * PAGE_ROWS; // 512 bytes/page

export interface HexEditorProps {
  bytes: Uint8Array;
  dirty: Map<number, number>;
  onEdit: (offset: number, value: number) => void;
}

const dirtyStyle = (on: boolean): React.CSSProperties => ({
  background: on ? "var(--warn, #b8860b)" : "transparent",
  color: on ? "#000" : "inherit",
  border: "1px solid var(--line, #333)",
  borderRadius: 3,
  padding: "1px 0",
  textAlign: "center",
});

export function HexEditor({ bytes, dirty, onEdit }: HexEditorProps) {
  const pageCount = Math.max(1, Math.ceil(bytes.length / PAGE));
  const [page, setPage] = useState(0);
  const [jump, setJump] = useState("");

  const clampedPage = Math.min(page, pageCount - 1);
  const start = clampedPage * PAGE;
  const end = Math.min(start + PAGE, bytes.length);

  const rows = useMemo(() => {
    const out: number[] = [];
    for (let off = start; off < end; off += ROW) out.push(off);
    return out;
  }, [start, end]);

  function gotoOffset(raw: string) {
    const v = raw.trim().toLowerCase();
    const n = v.startsWith("0x") ? parseInt(v.slice(2), 16) : /^[0-9]+$/.test(v) ? parseInt(v, 10) : parseInt(v, 16);
    if (Number.isFinite(n) && n >= 0 && n < bytes.length) setPage(Math.floor(n / PAGE));
  }

  return (
    <div>
      <div className="row gap-8" style={{ alignItems: "center", marginBottom: 8 }}>
        <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={clampedPage === 0}>‹ prev</button>
        <span className="tiny dim mono">
          0x{start.toString(16).padStart(6, "0")}–0x{(end - 1).toString(16).padStart(6, "0")} · page {clampedPage + 1}/{pageCount}
        </span>
        <button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={clampedPage >= pageCount - 1}>next ›</button>
        <input
          type="text"
          placeholder="jump to 0x…"
          value={jump}
          onChange={(e) => setJump(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") gotoOffset(jump); }}
          style={{ width: 120, marginLeft: "auto" }}
        />
        <button onClick={() => gotoOffset(jump)}>Go</button>
      </div>

      <div className="mono tiny" style={{ overflowX: "auto" }}>
        {rows.map((off) => {
          const slice = bytes.subarray(off, Math.min(off + ROW, bytes.length));
          return (
            <div key={off} style={{ display: "flex", gap: 10, alignItems: "center", lineHeight: "20px" }}>
              <span className="dim" style={{ flex: "0 0 56px" }}>{off.toString(16).padStart(6, "0")}</span>

              {/* hex cells */}
              <span style={{ display: "flex", gap: 2 }}>
                {Array.from(slice).map((b, i) => {
                  const abs = off + i;
                  return (
                    <input
                      key={abs}
                      value={b.toString(16).padStart(2, "0")}
                      maxLength={2}
                      spellCheck={false}
                      onChange={(e) => {
                        const hv = e.target.value.replace(/[^0-9a-fA-F]/g, "");
                        if (hv.length === 0) return;
                        onEdit(abs, parseInt(hv, 16) & 0xff);
                      }}
                      style={{ ...dirtyStyle(dirty.has(abs)), width: 22, textTransform: "uppercase" }}
                    />
                  );
                })}
              </span>

              {/* ASCII cells (editable) */}
              <span style={{ display: "flex", gap: 1 }}>
                {Array.from(slice).map((b, i) => {
                  const abs = off + i;
                  const printable = b >= 32 && b < 127;
                  return (
                    <input
                      key={abs}
                      value={printable ? String.fromCharCode(b) : "·"}
                      spellCheck={false}
                      onChange={(e) => {
                        const ch = e.target.value.replace("·", "").slice(-1);
                        if (ch) onEdit(abs, ch.charCodeAt(0) & 0xff);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Backspace" || e.key === "Delete") {
                          e.preventDefault();
                          onEdit(abs, 0xff); // blank
                        }
                      }}
                      style={{ ...dirtyStyle(dirty.has(abs)), width: 11, fontFamily: "inherit" }}
                    />
                  );
                })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
