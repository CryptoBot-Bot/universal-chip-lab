import type { ReactNode } from "react";

import type { PiDeviceInfo, SuperDeviceIface, SuperDeviceStatus } from "../../lib/api";

/**
 * Shared bits of the Pi Devices page (B1 look): the shapes the device daemon
 * returns beyond the typed ones in lib/api.ts, availability, formatters, icons.
 */

/** /api/device — newer daemons also report the write-gate mode here. */
export type DeviceInfo = PiDeviceInfo & { write_gate?: string };
/** /api/status — the daemon lists a virtual bus (vcan0) separately from the two hardware channels. */
export type DeviceStatus = SuperDeviceStatus & { virtual?: SuperDeviceIface[] };

/** GET /api/write-gate (display only — nothing on this page can arm or enable writes). */
export interface WriteGate {
  mode: "read-only" | "disarmed" | "armed";
  writes_enabled?: boolean;
  armed?: boolean;
  seconds_left?: number;
  scope?: { iface: string | null; tx: string | null } | null;
  owner?: string;
  reason?: string;
  writes_since_boot?: number;
  refused_since_boot?: number;
}

/** GET /api/version — what daemon build is running. */
export interface DaemonVersion {
  daemon_sha256?: string;
  started?: number;
  uptime_s?: number;
  pid?: number;
  python?: string;
  port?: number;
  features?: string[];
}

/** GET /api/rec/list — the on-Pi ISO-TP recordings. */
export interface RecSession {
  id: string;
  bytes: number;
  lines: number;
  exchanges: number;
  active: boolean;
  label?: string;
  note?: string;
  auto?: boolean;
  sim?: string | null;
  mtime?: number;
  error?: string;
}
export interface RecList { sessions: RecSession[]; dir?: string }

/** GET /api/rec/status — is the recorder writing right now. */
export interface RecStatus {
  recording: boolean;
  session: { id: string; bytes?: number; lines_this_run?: number } | null;
  free_mb: number | null;
  error: string | null;
}

export type Phase = "checking" | "online" | "offline";
export interface LiveState {
  phase: Phase;
  info?: DeviceInfo;
  status?: DeviceStatus;
  error?: string;
}

export type Availability = "available" | "mine" | "occupied" | "offline" | "checking";

export function availability(live: LiveState | undefined, owner: string): Availability {
  if (!live || live.phase === "checking") return "checking";
  if (live.phase === "offline") return "offline";
  const claim = live.info?.claim;
  if (!claim) return "available";
  return claim.owner === owner ? "mine" : "occupied";
}

/** The status chip on a device card / settings header. */
export function availabilityChip(avail: Availability, live: LiveState | undefined): { label: string; cls: string } {
  switch (avail) {
    case "checking": return { label: "Checking…", cls: "unread" };
    case "offline": return { label: "Offline", cls: "unread" };
    case "available": return { label: "Online", cls: "clean" };
    case "mine": return { label: "Online · this PC", cls: "info" };
    case "occupied": return { label: `In use · ${live?.info?.claim?.owner ?? "another PC"}`, cls: "warn" };
  }
}

export function deviceName(d: { nickname?: string; hostname?: string; host: string }, info?: PiDeviceInfo): string {
  return d.nickname || info?.hostname || d.hostname || d.host;
}

/** "up 2 days, 3 hours, 10 minutes" → "2 d 3 h"; "desk simulator, up 12 min" → "12 m". */
export function shortUptime(s?: string | null): string | null {
  if (!s) return null;
  const units: [RegExp, string][] = [
    [/(\d+)\s*years?/, "y"], [/(\d+)\s*weeks?/, "w"], [/(\d+)\s*days?/, "d"],
    [/(\d+)\s*hours?/, "h"], [/(\d+)\s*min(?:ute)?s?/, "m"],
  ];
  const parts: string[] = [];
  for (const [re, u] of units) {
    const m = re.exec(s);
    if (m) parts.push(`${m[1]} ${u}`);
  }
  return parts.length ? parts.slice(0, 2).join(" ") : s.replace(/^up\s+/, "");
}

/** 21345 s → "5 h 55 m". */
export function shortDuration(seconds?: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} m`;
  return `${m} m`;
}

export function fmtBytes(n?: number | null): string {
  if (n == null) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The daemon answered "no such endpoint" (an older daemon, or the desk simulator). */
export function isNotFound(err: unknown): boolean {
  return /HTTP 404/.test(errText(err));
}

export const GATE_LABEL: Record<string, string> = {
  "read-only": "Read-only",
  disarmed: "Writes enabled · not armed",
  armed: "Armed",
};

export function BatteryBar({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, percent));
  const color = p > 50 ? "var(--ual-clean-ink)" : p > 20 ? "var(--ual-prot-ink)" : "var(--ual-fault)";
  return (
    <span className="dv-batt">
      <span className="dv-batt-frame" aria-hidden="true">
        <span className="dv-batt-fill" style={{ width: `${Math.max(4, p)}%`, background: color }} />
      </span>
      <b>{p}%</b>
    </span>
  );
}

/** Small inline stroke icons (no emoji). */
export function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
export const ICON = {
  scan: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  close: <><path d="M6 6l12 12M18 6L6 18" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 20v-4h-4" /></>,
  wifi: <><path d="M2 8.5a15 15 0 0 1 20 0" /><path d="M5 12a10 10 0 0 1 14 0" /><path d="M8.5 15.5a5 5 0 0 1 7 0" /><circle cx="12" cy="19" r="1" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  check: <><path d="M5 12l4 4 10-10" /></>,
};
