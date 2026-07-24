/**
 * JobCount link — the encrypted tunnel from the Chip Lab into a repair shop's
 * JobCount tenant. We pair exactly like the JobCount softphone: redeem a
 * 6-digit code for a long-lived device token, scoped to one shop. The token is
 * stored encrypted at rest (safeStorage / OS keychain) and presented as a
 * Bearer on every call. Once linked, an OBD VIN read pushes the vehicle into
 * that shop's garage.
 *
 * Server-side counterpart: routes/phoneDevices.js in the JobCount repo
 * (`/phone-pair/redeem`, `/phone-device/info`, `/phone-device/vehicles`).
 */
import { app, safeStorage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = "jobcount.json";

interface StoredLink {
  serverUrl?: string;          // e.g. "https://jobcount.org" or "http://localhost:4000"
  deviceId?: string;
  shopId?: string;
  shopName?: string;
  tokenEnc?: string;           // base64 of safeStorage-encrypted device token
  tokenPlain?: boolean;        // true if the OS had no keychain (stored b64 plaintext)
  pairedAt?: string;
}

export interface JobCountStatus {
  linked: boolean;
  serverUrl: string | null;
  shopId: string | null;
  shopName: string | null;
  deviceId: string | null;
  encryptionAvailable: boolean;
  storedUnencrypted: boolean;
}

export interface PushVehicleInput {
  vin?: string;
  year?: number | null;
  make?: string;
  model?: string;
  mileage?: number;
  customerName?: string;
  customerPhone?: string;
  notes?: string;
}

function filePath(): string {
  return path.join(app.getPath("userData"), FILE);
}
function read(): StoredLink {
  try { return JSON.parse(fs.readFileSync(filePath(), "utf8")) as StoredLink; } catch { return {}; }
}
function write(s: StoredLink): void {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(s, null, 2), "utf8");
}

function encToken(token: string): { tokenEnc: string; tokenPlain?: boolean } {
  if (safeStorage.isEncryptionAvailable()) {
    return { tokenEnc: safeStorage.encryptString(token).toString("base64") };
  }
  return { tokenEnc: Buffer.from(token, "utf8").toString("base64"), tokenPlain: true };
}
function decToken(s: StoredLink): string | null {
  if (!s.tokenEnc) return null;
  try {
    const buf = Buffer.from(s.tokenEnc, "base64");
    if (s.tokenPlain || !safeStorage.isEncryptionAvailable()) return buf.toString("utf8") || null;
    return safeStorage.decryptString(buf) || null;
  } catch { return null; }
}

/** Normalise a user-typed server to an origin, defaulting to https. */
function normaliseServer(raw: string): string {
  let s = (raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) {
    // localhost / 127.* / a bare :port default to http, everything else https
    s = /^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|\[?::1)/i.test(s) ? `http://${s}` : `https://${s}`;
  }
  return s;
}

async function api<T>(serverUrl: string, pathq: string, init: RequestInit, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Present browser-like headers: a JobCount deployment behind Cloudflare
    // (Bot Fight Mode) 403s the default Node/undici user-agent, so a device
    // request would never reach the app. These make us look like a normal
    // browser client — the endpoints are still bearer/pairing-code authed.
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      ...(init.headers as Record<string, string> | undefined),
    };
    const res = await fetch(`${serverUrl}${pathq}`, { ...init, headers, signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const msg = (body as { error?: string })?.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return body as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error(`JobCount timed out (${serverUrl})`);
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

export function getStatus(): JobCountStatus {
  const s = read();
  const token = decToken(s);
  return {
    linked: !!(token && s.serverUrl),
    serverUrl: s.serverUrl ?? null,
    shopId: s.shopId ?? null,
    shopName: s.shopName ?? null,
    deviceId: s.deviceId ?? null,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    storedUnencrypted: s.tokenPlain === true,
  };
}

/** Redeem a 6-digit pairing code from the shop's JobCount manager UI. */
export async function pair(serverRaw: string, code: string, appVersion: string): Promise<JobCountStatus> {
  const serverUrl = normaliseServer(serverRaw);
  if (!serverUrl) throw new Error("Enter the JobCount server address.");
  if (!/^\d{6}$/.test(String(code || "").trim())) throw new Error("Pairing code must be 6 digits.");

  const resp = await api<{
    ok: boolean; deviceId: string; deviceToken: string; serverUrl?: string;
    shop: { id: string; name: string };
  }>(serverUrl, "/phone-pair/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: String(code).trim(),
      deviceType: "chiplab",
      label: `Chip Lab · ${os.hostname()}`,
      hostname: os.hostname(),
      platform: process.platform,
      appVersion,
    }),
  });

  const { tokenEnc, tokenPlain } = encToken(resp.deviceToken);
  write({
    // trust the server's canonical URL if it returned one (handles ngrok/public)
    serverUrl: normaliseServer(resp.serverUrl || serverUrl),
    deviceId: resp.deviceId,
    shopId: resp.shop.id,
    shopName: resp.shop.name,
    tokenEnc,
    tokenPlain,
    pairedAt: new Date().toISOString(),
  });
  return getStatus();
}

/** Forget the link on this PC. (To fully revoke, the manager removes the device in JobCount.) */
export function unpair(): JobCountStatus {
  try { fs.rmSync(filePath()); } catch { /* already gone */ }
  return getStatus();
}

/** Confirm the stored token still works; returns the shop name from the server. */
export async function verify(): Promise<{ ok: boolean; shopName?: string; deviceType?: string; error?: string }> {
  const s = read();
  const token = decToken(s);
  if (!token || !s.serverUrl) return { ok: false, error: "not linked" };
  try {
    const info = await api<{ ok: boolean; shop: { name: string }; device: { deviceType?: string } }>(
      s.serverUrl, "/phone-device/info", { headers: { Authorization: `Bearer ${token}` } },
    );
    // refresh cached shop name in case it changed
    if (info.shop?.name && info.shop.name !== s.shopName) write({ ...s, shopName: info.shop.name });
    return { ok: true, shopName: info.shop?.name, deviceType: info.device?.deviceType };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Push a vehicle into the linked shop's garage. Idempotent server-side on {shop,vin}. */
export async function pushVehicle(v: PushVehicleInput): Promise<{ ok: boolean; created: boolean; vehicle: { id: string; vin: string; year: number | null; make: string; model: string }; error?: string }> {
  const s = read();
  const token = decToken(s);
  if (!token || !s.serverUrl) throw new Error("Not linked to a JobCount shop.");
  return api(s.serverUrl, "/phone-device/vehicles", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(v),
  });
}

/** List the linked shop's garage (for a read-only view in the Chip Lab). */
export async function listGarage(q?: string): Promise<{ ok: boolean; count: number; vehicles: unknown[] }> {
  const s = read();
  const token = decToken(s);
  if (!token || !s.serverUrl) throw new Error("Not linked to a JobCount shop.");
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return api(s.serverUrl, `/phone-device/vehicles${qs}`, { headers: { Authorization: `Bearer ${token}` } });
}

/** Is a link configured? (cheap check for the VIN-read auto-push path) */
export function isLinked(): boolean {
  const s = read();
  return !!(s.tokenEnc && s.serverUrl);
}
