/**
 * Offline VIN decoder (ISO 3779 / SAE) — no network required.
 *
 * Extracts the identity we key the vehicle library on: Year / Make (+ country,
 * region, a body-type hint, and check-digit validity). It is intentionally
 * dependency-free and browser+node safe so it can run in the renderer (quick
 * decode as you type) and in the electron main (on connect).
 *
 * It does NOT resolve the exact trim/model — that needs a manufacturer database
 * (e.g. NHTSA vPIC online). We decode what the VIN itself encodes deterministically,
 * and leave `model` for the library match / online enrichment to fill.
 */

export type BodyTypeHint =
  | "sedan" | "suv" | "truck" | "van" | "minivan" | "hatchback" | "coupe" | "wagon" | "unknown";

export interface VinDecode {
  vin: string;
  valid: boolean;              // structurally valid (length + charset)
  checkDigitValid: boolean;    // North-America check digit (pos 9) passes
  wmi: string;                 // positions 1-3
  vds: string;                 // positions 4-8
  vis: string;                 // positions 10-17
  region: string;              // continent from char 1
  country: string;             // country from char 1 (best effort)
  make: string | null;         // from WMI table
  year: number | null;         // from position 10 (+ pos-7 era heuristic)
  bodyTypeHint: BodyTypeHint;  // rough guess to preselect a 3D mesh
  notes: string[];
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/; // no I, O, Q

// Position-10 year cycle. Letters cover 1980-2000 and 2010-2030; digits 2001-2009.
const YEAR_LETTERS = "ABCDEFGHJKLMNPRSTVWXY"; // 21 letters, I/O/Q/U/Z excluded

// Char-1 → region / country (best effort; ranges per SAE).
function regionCountry(c: string): { region: string; country: string } {
  if ("ABCDEFGH".includes(c)) return { region: "Africa", country: "Africa" };
  if ("JKLMNPR".includes(c)) return { region: "Asia", country: asiaCountry(c) };
  if ("STUVWXYZ".includes(c)) return { region: "Europe", country: euroCountry(c) };
  if ("12345".includes(c)) return { region: "North America", country: c === "2" ? "Canada" : c === "3" ? "Mexico" : "USA" };
  if ("6789".includes(c)) return { region: "Oceania / S. America", country: "Oceania/S.America" };
  return { region: "Unknown", country: "Unknown" };
}
function asiaCountry(c: string): string {
  return { J: "Japan", K: "Korea", L: "China", M: "India/Indonesia", N: "Turkey", P: "Malaysia", R: "Taiwan/UAE" }[c] ?? "Asia";
}
function euroCountry(c: string): string {
  if ("S".includes(c)) return "UK";
  if ("V".includes(c)) return "France/Spain/Austria";
  if ("W".includes(c)) return "Germany";
  if ("Y".includes(c)) return "Sweden/Finland";
  if ("Z".includes(c)) return "Italy";
  if ("T".includes(c)) return "Switzerland/Czech/Hungary";
  if ("U".includes(c)) return "Romania/Denmark";
  if ("X".includes(c)) return "Russia";
  return "Europe";
}

// WMI (first 3, fall back to first 2) → make. Curated common set; extend freely.
const WMI_MAKE: Record<string, string> = {
  // Toyota / Lexus
  JTD: "Toyota", JTM: "Toyota", JTE: "Toyota", JTN: "Toyota", JTL: "Lexus",
  "2T1": "Toyota", "4T1": "Toyota", "5TD": "Toyota", "5TF": "Toyota", "1NX": "Toyota",
  JT2: "Toyota", JT3: "Toyota", JT4: "Toyota", JT6: "Lexus", JT8: "Lexus",
  // Honda / Acura
  "1HG": "Honda", "2HG": "Honda", "3HG": "Honda", JHM: "Honda", "19X": "Honda",
  "5FN": "Honda", "5J6": "Honda", "2HK": "Honda", "1HF": "Honda", JH4: "Acura", "19U": "Acura",
  // Ford
  "1FA": "Ford", "1FT": "Ford", "1FM": "Ford", "1FD": "Ford", "2FM": "Ford", "3FA": "Ford", "1FC": "Ford",
  // GM (Chevrolet / GMC / Cadillac / Buick)
  "1G1": "Chevrolet", "1GC": "Chevrolet", "3GC": "Chevrolet", "1GT": "GMC", "1GK": "GMC",
  "1G6": "Cadillac", "1G4": "Buick", "2G1": "Chevrolet", "KL1": "Chevrolet",
  // Nissan / Infiniti
  "1N4": "Nissan", "1N6": "Nissan", JN1: "Nissan", JN8: "Nissan", "3N1": "Nissan", "5N1": "Nissan", JNK: "Infiniti", JNR: "Infiniti",
  // VW / Audi / Porsche
  WVW: "Volkswagen", "1VW": "Volkswagen", "3VW": "Volkswagen", "WV1": "Volkswagen", "WV2": "Volkswagen",
  WAU: "Audi", WA1: "Audi", TRU: "Audi", WP0: "Porsche", WP1: "Porsche",
  // BMW / Mercedes
  WBA: "BMW", WBS: "BMW", WBY: "BMW", "4US": "BMW", "5UX": "BMW", "5UM": "BMW",
  WDB: "Mercedes-Benz", WDD: "Mercedes-Benz", WDC: "Mercedes-Benz", "4JG": "Mercedes-Benz", WMX: "Mercedes-Benz",
  // Hyundai / Kia
  KMH: "Hyundai", KM8: "Hyundai", "5NP": "Hyundai", "5NM": "Hyundai", KND: "Kia", KNA: "Kia", KND9: "Kia", "3KP": "Kia",
  // Subaru / Mazda
  JF1: "Subaru", JF2: "Subaru", "4S3": "Subaru", "4S4": "Subaru", JM1: "Mazda", JM3: "Mazda", "3MZ": "Mazda", "4F2": "Mazda",
  // Jeep / Ram / Chrysler / Dodge
  "1C4": "Jeep", "1J4": "Jeep", "1C6": "Ram", "3C6": "Ram", "2C3": "Chrysler", "1C3": "Chrysler", "1B3": "Dodge", "2B3": "Dodge",
  // Tesla
  "5YJ": "Tesla", "7SA": "Tesla", LRW: "Tesla",
  // Jaguar / Land Rover / Volvo
  SAJ: "Jaguar", SAL: "Land Rover", YV1: "Volvo", YV4: "Volvo",
};

const WMI_BODY: Record<string, BodyTypeHint> = {
  // very rough division-code hints; the library/AI refines this
  "1FT": "truck", "1GC": "truck", "3GC": "truck", "1GT": "truck", "1C6": "truck", "3C6": "truck", "1FD": "truck",
  "1FM": "suv", "1GK": "suv", "5TD": "suv", "5TF": "suv", "1C4": "suv", "1J4": "suv", "JN8": "suv", "5N1": "suv", "KM8": "suv", "JF2": "suv",
  "5FN": "minivan",
};

function transliterate(c: string): number {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  const map: Record<string, number> = {
    A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
    J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
    S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  };
  return map[c] ?? 0;
}

const CHECK_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** The check character (position 9) a valid North-America VIN must carry. */
function computeCheckChar(vin: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += transliterate(vin[i]) * CHECK_WEIGHTS[i];
  const rem = sum % 11;
  return rem === 10 ? "X" : String(rem);
}

function checkDigitOk(vin: string): boolean {
  return vin[8] === computeCheckChar(vin);
}

/** Position-10 code for a model year (inverse of decodeYear; 2010–2030 alpha era). */
function yearCodeFor(year: number): string {
  if (year >= 2010 && year <= 2030) return YEAR_LETTERS[year - 2010];
  if (year >= 1980 && year <= 2000) return YEAR_LETTERS[year - 1980];
  if (year >= 2001 && year <= 2009) return String(year - 2000);
  return "L"; // 2020 fallback
}

/**
 * Build a structurally-valid, decodable sample VIN (legal charset + correct check
 * digit + real WMI/year) — used by the simulator so a scan carries a VIN that
 * decodeVin() actually resolves, exactly like a real scanner would read off a car.
 */
export function buildSampleVin(wmiRaw: string, year: number, serial = "012345"): string {
  const clean = (s: string) => s.toUpperCase().replace(/[IOQ]/g, "X").replace(/[^A-HJ-NPR-Z0-9]/g, "X");
  const wmi = clean(`${wmiRaw}XXX`).slice(0, 3);
  const vds = "EPRAE";                       // positions 4-8; pos-7 alpha marks the 2010+ era
  const yc = yearCodeFor(year);              // position 10
  const tail = `J${clean(`${serial}000000`).slice(0, 6)}`; // plant + 6-char serial (pos 11-17)
  const placeholder = `${wmi}${vds}0${yc}${tail}`;         // pos-9 weight is 0, so any placeholder works
  return `${wmi}${vds}${computeCheckChar(placeholder)}${yc}${tail}`;
}

function decodeYear(yearCode: string, pos7: string): number | null {
  const isAlphaEra = /[A-Z]/i.test(pos7); // pos 7 alpha ⇒ 2010+ cycle (heuristic)
  if (/[0-9]/.test(yearCode)) {
    const d = Number(yearCode);
    if (d < 1 || d > 9) return null;
    return (isAlphaEra ? 2031 : 2001) + (d - 1);
  }
  const idx = YEAR_LETTERS.indexOf(yearCode.toUpperCase());
  if (idx < 0) return null;
  return (isAlphaEra ? 2010 : 1980) + idx;
}

export function decodeVin(raw: string): VinDecode {
  const vin = (raw || "").trim().toUpperCase();
  const notes: string[] = [];
  const valid = VIN_RE.test(vin);

  const wmi = vin.slice(0, 3);
  const vds = vin.slice(3, 8);
  const vis = vin.slice(9, 17);

  const { region, country } = valid ? regionCountry(vin[0]) : { region: "Unknown", country: "Unknown" };
  const make = valid ? (WMI_MAKE[wmi] ?? WMI_MAKE[wmi.slice(0, 2)] ?? null) : null;
  if (valid && !make) notes.push(`WMI "${wmi}" not in table — add it to WMI_MAKE to name this maker.`);

  const year = valid ? decodeYear(vin[9], vin[6]) : null;
  const checkDigitValid = valid ? checkDigitOk(vin) : false;
  if (valid && !checkDigitValid) notes.push("Check digit (pos 9) failed — may be a non-NA VIN or a typo.");

  const bodyTypeHint: BodyTypeHint = (valid && WMI_BODY[wmi]) || "unknown";

  return { vin, valid, checkDigitValid, wmi, vds, vis, region, country, make, year, bodyTypeHint, notes };
}

/** Library key: normalized "YEAR MAKE MODEL" (model optional until known). */
export function ymmKey(year: number | null, make: string | null, model: string | null): string {
  return [year ?? "?", (make ?? "?").toUpperCase(), (model ?? "").toUpperCase()].join("|").replace(/\|+$/, "");
}
