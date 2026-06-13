/**
 * Per-user app settings, stored in the OS user-data dir. The Anthropic API key
 * is encrypted at rest with Electron's safeStorage (DPAPI on Windows, Keychain
 * on macOS, libsecret on Linux). Each user supplies their OWN key — we never
 * ship one. An ANTHROPIC_API_KEY environment variable still wins (for dev/.env).
 */
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

const FILE = "settings.json";

interface StoredSettings {
  // base64 of the safeStorage-encrypted key (or base64 plaintext if encryption
  // isn't available on this OS — flagged so the UI can warn).
  anthropicApiKeyEnc?: string;
  anthropicApiKeyPlain?: boolean;
}

export type KeySource = "env" | "stored" | "none";

export interface KeyStatus {
  hasKey: boolean;
  source: KeySource;
  masked: string | null;
  encryptionAvailable: boolean;
  storedUnencrypted: boolean;
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), FILE);
}

function read(): StoredSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as StoredSettings;
  } catch {
    return {};
  }
}

function write(s: StoredSettings): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), "utf8");
}

function mask(k: string): string {
  if (k.length <= 10) return "••••";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/** The effective key: env var first (dev/.env), then the stored encrypted key. */
export function getApiKey(): string | null {
  const env = process.env.ANTHROPIC_API_KEY;
  if (env && env.trim()) return env.trim();

  const s = read();
  if (!s.anthropicApiKeyEnc) return null;
  try {
    const buf = Buffer.from(s.anthropicApiKeyEnc, "base64");
    if (s.anthropicApiKeyPlain || !safeStorage.isEncryptionAvailable()) {
      return buf.toString("utf8") || null;
    }
    return safeStorage.decryptString(buf) || null;
  } catch {
    return null;
  }
}

export function setApiKey(key: string): void {
  const trimmed = key.trim();
  const s = read();
  if (!trimmed) {
    delete s.anthropicApiKeyEnc;
    delete s.anthropicApiKeyPlain;
  } else if (safeStorage.isEncryptionAvailable()) {
    s.anthropicApiKeyEnc = safeStorage.encryptString(trimmed).toString("base64");
    delete s.anthropicApiKeyPlain;
  } else {
    // Last resort if the OS keychain is unavailable — still better than nothing,
    // but flag it so the UI can tell the user it isn't encrypted.
    s.anthropicApiKeyEnc = Buffer.from(trimmed, "utf8").toString("base64");
    s.anthropicApiKeyPlain = true;
  }
  write(s);
}

export function clearApiKey(): void {
  const s = read();
  delete s.anthropicApiKeyEnc;
  delete s.anthropicApiKeyPlain;
  write(s);
}

export function getKeyStatus(): KeyStatus {
  const encryptionAvailable = safeStorage.isEncryptionAvailable();
  const env = process.env.ANTHROPIC_API_KEY;
  if (env && env.trim()) {
    return { hasKey: true, source: "env", masked: mask(env.trim()), encryptionAvailable, storedUnencrypted: false };
  }
  const s = read();
  const key = getApiKey();
  if (key) {
    return {
      hasKey: true,
      source: "stored",
      masked: mask(key),
      encryptionAvailable,
      storedUnencrypted: s.anthropicApiKeyPlain === true,
    };
  }
  return { hasKey: false, source: "none", masked: null, encryptionAvailable, storedUnencrypted: false };
}
