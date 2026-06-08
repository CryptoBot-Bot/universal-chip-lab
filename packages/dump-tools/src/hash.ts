import { createHash } from "node:crypto";

export function sha256(data: Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return createHash("sha256").update(buf).digest("hex");
}

export function md5(data: Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return createHash("md5").update(buf).digest("hex");
}
