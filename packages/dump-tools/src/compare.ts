import { sha256 } from "./hash.js";

export interface CompareResult {
  sameSize: boolean;
  sameHash: boolean;
  firstDifferingOffset: number;
  totalDifferingBytes: number;
  sizeA: number;
  sizeB: number;
  hashA: string;
  hashB: string;
}

export function compareDumps(a: Buffer | Uint8Array, b: Buffer | Uint8Array): CompareResult {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b);

  const sameSize = ba.length === bb.length;
  const hashA = sha256(ba);
  const hashB = sha256(bb);
  const sameHash = hashA === hashB;

  let firstDiff = -1;
  let totalDiff = 0;
  const limit = Math.min(ba.length, bb.length);
  for (let i = 0; i < limit; i++) {
    if (ba[i] !== bb[i]) {
      if (firstDiff === -1) firstDiff = i;
      totalDiff++;
    }
  }
  if (ba.length !== bb.length) {
    totalDiff += Math.abs(ba.length - bb.length);
    if (firstDiff === -1) firstDiff = limit;
  }

  return {
    sameSize,
    sameHash,
    firstDifferingOffset: firstDiff,
    totalDifferingBytes: totalDiff,
    sizeA: ba.length,
    sizeB: bb.length,
    hashA,
    hashB,
  };
}
