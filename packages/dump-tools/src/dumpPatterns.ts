export interface DumpPatternReport {
  allFF: boolean;
  all00: boolean;
  uniqueBytes: number;
  /** Index of the first byte that differs from byte[0]; -1 if dump is fully uniform. */
  firstDifferingByteIndex: number;
}

export function analysePatterns(data: Buffer | Uint8Array): DumpPatternReport {
  if (data.length === 0) {
    return { allFF: false, all00: false, uniqueBytes: 0, firstDifferingByteIndex: -1 };
  }
  const first = data[0]!;
  const seen = new Uint8Array(256);
  let firstDiff = -1;
  let unique = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    if (seen[b] === 0) {
      seen[b] = 1;
      unique++;
    }
    if (firstDiff === -1 && b !== first) firstDiff = i;
  }
  return {
    allFF: first === 0xff && firstDiff === -1,
    all00: first === 0x00 && firstDiff === -1,
    uniqueBytes: unique,
    firstDifferingByteIndex: firstDiff,
  };
}
