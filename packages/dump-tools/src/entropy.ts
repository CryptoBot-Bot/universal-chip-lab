/**
 * Shannon entropy in bits/byte, normalised to [0, 1] by dividing by 8.
 *
 * 0.0 → fully uniform data (all the same byte).
 * ~1.0 → close to random / compressed data.
 *
 * A real EEPROM dump of a working module is typically 0.4–0.85 — values much
 * lower than that often indicate a failed or partial read.
 */
export function shannonEntropyNormalised(data: Buffer | Uint8Array): number {
  if (data.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) {
    counts[data[i]!]++;
  }
  let entropy = 0;
  const len = data.length;
  for (let i = 0; i < 256; i++) {
    const c = counts[i]!;
    if (c === 0) continue;
    const p = c / len;
    entropy -= p * Math.log2(p);
  }
  return entropy / 8;
}
