import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from "react";

import { Api, type PiDeviceInfo, type SuperDeviceStatus } from "./api";

/**
 * ONE SuperDevice connection for the whole app.
 *
 * Connect to a Pi anywhere (Pi Devices, Vehicle Cockpit, Bench Master) and every
 * tab sees the same live link instantly — no per-tab "connecting from offline"
 * dance. The provider:
 *   - polls the active device in the background (device info + bus status),
 *   - holds the occupancy claim for this PC and heart-beats it so the device
 *     stays "ours" while the app runs (claims expire 2 min after the app dies),
 *   - remembers the last device and resumes the session on app start.
 */

export type SdLink = "idle" | "connecting" | "online" | "error";

export interface SdConnectResult { ok: boolean; error?: string; occupiedBy?: string }

interface SdContext {
  /** Active (or last-used) host, e.g. "192.168.1.67:8080". "" if never connected. */
  host: string;
  link: SdLink;
  info: PiDeviceInfo | null;
  status: SuperDeviceStatus | null;
  error: string | null;
  /** This PC's name — what the claim system calls us. */
  owner: string;
  /** True when the device's claim is held by THIS PC. */
  claimedByMe: boolean;
  connect: (host: string, opts?: { force?: boolean }) => Promise<SdConnectResult>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
}

const HOST_KEY = "superdevice.active.host";
const Ctx = createContext<SdContext | null>(null);

export function SuperDeviceProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState(() => localStorage.getItem(HOST_KEY) || "");
  const [link, setLink] = useState<SdLink>("idle");
  const [info, setInfo] = useState<PiDeviceInfo | null>(null);
  const [status, setStatus] = useState<SuperDeviceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState("");

  const hostRef = useRef(host); hostRef.current = host;
  const linkRef = useRef(link); linkRef.current = link;
  const ownerRef = useRef(owner); ownerRef.current = owner;

  const refresh = useCallback(async () => {
    const h = hostRef.current;
    if (!h || linkRef.current === "idle" || linkRef.current === "connecting") return;
    try {
      const [i, s] = await Promise.all([
        Api.superDevice.get<PiDeviceInfo>(h, "/api/device"),
        Api.superDevice.status(h),
      ]);
      setInfo(i); setStatus(s); setError(null); setLink("online");
      // heartbeat: renew our claim before its TTL runs out
      if (i.claim && i.claim.owner === ownerRef.current && i.claim.expires_in < 90) {
        Api.devices.claim(h).catch(() => { /* renewed next round */ });
      }
    } catch (err) {
      setLink("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const connect = useCallback(async (h: string, opts?: { force?: boolean }): Promise<SdConnectResult> => {
    const target = h.includes(":") ? h : `${h}:8080`;
    setHost(target); hostRef.current = target;
    localStorage.setItem(HOST_KEY, target);
    setLink("connecting"); setError(null);
    // claim first so occupancy is honest across PCs; tolerate old firmware (404)
    try {
      const r = await Api.devices.claim(target, opts?.force);
      if (!r.ok && r.occupied_by) {
        const msg = `In use by ${r.occupied_by}`;
        setLink("error"); setError(msg);
        return { ok: false, error: msg, occupiedBy: r.occupied_by };
      }
    } catch { /* pre-claim firmware — connect without a claim */ }
    try {
      const [i, s] = await Promise.all([
        Api.superDevice.get<PiDeviceInfo>(target, "/api/device"),
        Api.superDevice.status(target),
      ]);
      setInfo(i); setStatus(s); setLink("online"); setError(null);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLink("error"); setError(msg);
      return { ok: false, error: msg };
    }
  }, []);

  const disconnect = useCallback(async () => {
    const h = hostRef.current;
    setLink("idle"); setInfo(null); setStatus(null); setError(null);
    if (h) await Api.devices.release(h).catch(() => { /* offline or pre-claim firmware */ });
  }, []);

  // who are we (claim owner name), then resume the last session quietly
  useEffect(() => {
    let stop = false;
    Api.devices.list()
      .then((r) => { if (!stop) { setOwner(r.owner); ownerRef.current = r.owner; } })
      .catch(() => { /* registry unavailable */ });
    if (hostRef.current) {
      void connect(hostRef.current).catch(() => { /* device away — stay idle */ })
        .then((r) => { if (r && !r.ok && !r.occupiedBy) setLink("idle"); });
    }
    const iv = setInterval(() => void refresh(), 5000);
    return () => { stop = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const claimedByMe = !!(info?.claim && owner && info.claim.owner === owner);

  return (
    <Ctx.Provider value={{ host, link, info, status, error, owner, claimedByMe, connect, disconnect, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSuperDevice(): SdContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSuperDevice must be used inside <SuperDeviceProvider>");
  return ctx;
}
