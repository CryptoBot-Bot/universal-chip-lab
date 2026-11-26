import { useEffect, useState } from "react";

import type { DtcMeaning } from "@ecu/vehicle-db";

import { Api } from "./api";

/** Public meanings of fault codes (OBDex), asked once per code and kept for the session. */
const known = new Map<string, DtcMeaning>();

export function useDtcMeanings(codes: string[]): Map<string, DtcMeaning> {
  const key = [...new Set(codes.map((c) => c.toUpperCase().slice(0, 5)))].sort().join(",");
  const [, bump] = useState(0);
  useEffect(() => {
    const want = key ? key.split(",").filter((c) => !known.has(c)) : [];
    if (!want.length) return;
    let stop = false;
    Api.knowledge.dtcs({ codes: want })
      .then((list) => { for (const m of list) known.set(m.code, m); if (!stop) bump((n) => n + 1); })
      .catch(() => { /* no knowledge base yet, or an older main process */ });
    return () => { stop = true; };
  }, [key]);
  return known;
}

/** What to show for a code: the module's own text, else the public meaning, else why there is none. */
export function dtcText(code: string, own: string | undefined, meanings: Map<string, DtcMeaning>): { text: string; title?: string; muted: boolean } {
  if (own) return { text: own, muted: false };
  const m = meanings.get(code.toUpperCase().slice(0, 5));
  if (m?.title) return { text: m.title, title: `${m.description ?? ""}\n\nPublic meaning from OBDex (CC0). The maker may use the code more precisely.`.trim(), muted: false };
  if (m?.makerSpecific) return { text: "Maker-specific code — no public meaning", muted: true };
  return { text: "No description on file", muted: true };
}
