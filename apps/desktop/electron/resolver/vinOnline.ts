import fs from "node:fs/promises";
import path from "node:path";

import type { OnlineVinDecode } from "@ecu/vehicle-db";
import { bodyTypeFromClass } from "@ecu/vehicle-db";

/**
 * Online VIN decode via the free NHTSA vPIC API (no key, no quota for
 * reasonable use). This is the FIRST identification step: it names the
 * year/make/model/trim/engine/plant from the manufacturer's own VIN tables.
 * Results are cached per VIN on disk so a car seen once decodes offline
 * forever after. Never throws on network failure — returns ok:false.
 */

const VPIC = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended";
const TIMEOUT_MS = 9000;

interface VpicRow { [k: string]: string }

async function readCache(file: string): Promise<Record<string, OnlineVinDecode>> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, OnlineVinDecode>; } catch { return {}; }
}
async function writeCache(file: string, cache: Record<string, OnlineVinDecode>): Promise<void> {
  try { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(cache, null, 2)); } catch { /* cache is best-effort */ }
}

function s(v: string | undefined): string | undefined { const t = (v ?? "").trim(); return t && t !== "Not Applicable" ? t : undefined; }

export function mapVpicRow(vin: string, r: VpicRow, now: string): OnlineVinDecode {
  const make = s(r.Make) ?? "";
  const model = s(r.Model) ?? "";
  const yearN = Number(s(r.ModelYear));
  const disp = s(r.DisplacementL);
  const cyl = s(r.EngineCylinders);
  const engineBits = [
    disp ? `${Number(disp).toFixed(1)}L` : null,
    cyl ? `${cyl}-cyl` : null,
    s(r.EngineModel) ?? null,
    s(r.Turbo) === "Yes" ? "turbo" : null,
    s(r.ElectrificationLevel) ?? null,
  ].filter(Boolean);
  return {
    source: "nhtsa", vin, ok: !!make && !!model,
    errorCode: s(r.ErrorCode), errorText: s(r.ErrorText),
    year: Number.isFinite(yearN) && yearN > 1900 ? yearN : null,
    make, model,
    trim: s(r.Trim), series: s(r.Series),
    bodyClass: s(r.BodyClass), bodyType: bodyTypeFromClass(s(r.BodyClass)),
    vehicleType: s(r.VehicleType), driveType: s(r.DriveType),
    engine: engineBits.length ? engineBits.join(" ") : undefined,
    engineModel: s(r.EngineModel), displacementL: disp, cylinders: cyl, horsepower: s(r.EngineHP),
    fuel: s(r.FuelTypePrimary), transmission: [s(r.TransmissionStyle), s(r.TransmissionSpeeds) ? `${s(r.TransmissionSpeeds)}-speed` : undefined].filter(Boolean).join(" ") || undefined,
    doors: s(r.Doors), plantCountry: s(r.PlantCountry), plantCity: s(r.PlantCity),
    manufacturer: s(r.Manufacturer), gvwr: s(r.GVWR),
    fetchedAt: now,
  };
}

export async function decodeVinOnline(vinRaw: string, cacheFile: string): Promise<OnlineVinDecode> {
  const vin = (vinRaw || "").trim().toUpperCase();
  const now = new Date().toISOString();
  const cache = await readCache(cacheFile);
  if (cache[vin]?.ok) return cache[vin];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${VPIC}/${encodeURIComponent(vin)}?format=json`, { signal: controller.signal });
    if (!res.ok) return { source: "nhtsa", vin, ok: false, errorText: `NHTSA HTTP ${res.status}`, year: null, make: "", model: "", bodyType: null, fetchedAt: now };
    const body = (await res.json()) as { Results?: VpicRow[] };
    const row = body.Results?.[0];
    if (!row) return { source: "nhtsa", vin, ok: false, errorText: "NHTSA returned no result", year: null, make: "", model: "", bodyType: null, fetchedAt: now };
    const out = mapVpicRow(vin, row, now);
    if (out.ok) { cache[vin] = out; await writeCache(cacheFile, cache); }
    return out;
  } catch (e) {
    return { source: "nhtsa", vin, ok: false, errorText: `NHTSA unreachable — ${(e as Error).name === "AbortError" ? "timed out" : (e as Error).message}`, year: null, make: "", model: "", bodyType: null, fetchedAt: now };
  } finally { clearTimeout(timer); }
}
