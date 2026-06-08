export interface HexPreviewOptions {
  /** Bytes per row. Defaults to 16. */
  width?: number;
  /** Start offset (byte index) — defaults to 0. */
  offset?: number;
  /** Max bytes to render — defaults to 512. */
  length?: number;
  /** Show ASCII gutter on the right — defaults to true. */
  ascii?: boolean;
}

export interface HexPreviewRow {
  offset: number;
  hex: string[];
  ascii: string;
}

export interface HexPreview {
  offset: number;
  length: number;
  totalSize: number;
  rows: HexPreviewRow[];
}

const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;

export function hexPreview(
  data: Buffer | Uint8Array,
  options: HexPreviewOptions = {},
): HexPreview {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const width = options.width ?? 16;
  const offset = Math.max(0, options.offset ?? 0);
  const requested = options.length ?? 512;
  const end = Math.min(buf.length, offset + requested);

  const rows: HexPreviewRow[] = [];
  for (let row = offset; row < end; row += width) {
    const rowEnd = Math.min(end, row + width);
    const hex: string[] = [];
    let ascii = "";
    for (let i = row; i < rowEnd; i++) {
      const b = buf[i]!;
      hex.push(b.toString(16).padStart(2, "0"));
      ascii +=
        b >= PRINTABLE_MIN && b <= PRINTABLE_MAX ? String.fromCharCode(b) : ".";
    }
    rows.push({ offset: row, hex, ascii });
  }

  return {
    offset,
    length: end - offset,
    totalSize: buf.length,
    rows,
  };
}

export function formatHexPreview(preview: HexPreview, width = 16): string {
  return preview.rows
    .map((row) => {
      const hex = row.hex.join(" ").padEnd(width * 3 - 1, " ");
      return `${row.offset.toString(16).padStart(8, "0")}  ${hex}  |${row.ascii}|`;
    })
    .join("\n");
}
