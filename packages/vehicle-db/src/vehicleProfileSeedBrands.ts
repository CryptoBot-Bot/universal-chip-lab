/**
 * Additional gold vehicles — one flagship per major make, so the AI mapper can be
 * calibrated against varied architectures (different addressing schemes, suppliers
 * and part-number formats), not just Toyota.
 *
 * Fidelity note: every module carries its REAL supplier and brand-correct
 * part-number FORMAT (BMW 2-2-1-3-3 grouped, Mercedes "A NNN NNN NN NN", VAG
 * "NNN NNN NNN", Ford "AANA-NNNNA-AA", Honda "NNNNN-XXX-XNN", Nissan "NNNNN-XXXXX")
 * and the correct transmission type (CVT vs torque-converter/DSG). Diagnostic
 * response ids are exact where publicly standardized (e.g. Ford FEPS) and
 * representative where a make does not publish them — enough to exercise the
 * mapper's evidence-first reasoning. Suppliers/part prefixes reflect real
 * system→vendor pairings (ZF/Bosch/Continental/JATCO/Nissin/Nexteer/…).
 */

import type { VehicleProfile, VehicleModule, VehicleSystemCategory, ModuleLocation } from "./vehicleProfile.schema.js";
import { PIDS } from "./obdPids.js";

const NOW = "2026-07-08T00:00:00.000Z";
const STD_PIDS = PIDS.map((p) => p.pid);

function mod(
  id: string, label: string, category: VehicleSystemCategory, location: ModuleLocation,
  req: string, resp: string, supplier: string, partNo: string, sw: string, hw: string, serial: string,
): VehicleModule {
  return {
    id, label, category, bus: "hs-can", location,
    addressing: { request: req, response: resp },
    identity: { supplier, partNo, sw, hw, serial },
  };
}

const STD_CAPS = (module = "ecm") => [
  { id: "live-data", label: "Live engine data (RPM, speed, coolant…)", category: "diagnostic" as const, risk: "read" as const, bus: "hs-can", module, sequence: ["01 0C", "01 0D", "01 05"] },
  { id: "read-dtcs", label: "Read/clear DTCs", category: "diagnostic" as const, risk: "read" as const, bus: "hs-can", module, sequence: ["19 02 FF"] },
  { id: "read-vin", label: "Read VIN & part numbers", category: "diagnostic" as const, risk: "read" as const, bus: "hs-can", module, sequence: ["22 F1 90", "22 F1 87"] },
];

// ── BMW 340i (F30) — Bosch DME / ZF 8HP / DSC / KAFAS ────────────────────────
const bmw340i: VehicleProfile = {
  id: "2016-bmw-340i", year: 2016, make: "BMW", model: "340i", trim: "M Sport (F30)",
  bodyType: "sedan", market: "US", wmi: ["WBA"],
  buses: [{ id: "hs-can", label: "PT-CAN (powertrain) 500k", protocol: "CAN", bitrate: 500000, obdPins: "6/14" }],
  modules: [
    mod("ecm", "DME — Digital Motor Electronics (B58)", "powertrain", "engine", "7E0", "7E8", "Bosch", "13 62 8 654 921", "0261S18345", "8654921", "BG16DME512"),
    mod("tcm-at", "EGS — 8HP Automatic (ZF)", "transmission", "engine", "7E1", "7E9", "ZF", "24 60 8 645 712", "EGS8.60.3", "8645712", "ZF16EGS771"),
    mod("abs", "DSC — Dynamic Stability Control", "chassis", "underbody", "6A0", "6A8", "Bosch", "34 51 6 894 330", "DSC10.2.4", "6894330", "BS16DSC330"),
    mod("srs", "ACSM — Airbag / Crash Safety", "safety", "cabin_front", "6C0", "6C8", "Continental", "65 77 9 345 118", "ACSM3.4", "9345118", "CN16ACSM11"),
    mod("eps", "EPS — Electric Power Steering", "chassis", "front_right", "6B0", "6B8", "ZF", "32 10 6 887 442", "EPS-F30-21", "6887442", "ZF16EPS442"),
    mod("meter", "KOMBI — Instrument Cluster", "infotainment", "dash", "620", "628", "Continental VDO", "62 11 9 348 771", "KOMBI-6.11", "9348771", "VDO16KMB77"),
    mod("gateway", "ZGW — Central Gateway", "network", "dash", "660", "668", "Bosch", "61 35 9 372 010", "ZGW-14.03", "9372010", "BS16ZGW010"),
    mod("fcm", "KAFAS — Camera / ACC Radar", "safety", "front_left", "670", "678", "Continental", "66 51 9 388 220", "KAFAS-2.1", "9388220", "CN16KFS220"),
  ],
  supportedPids: STD_PIDS, capabilities: STD_CAPS(),
  notes: "BMW F30 UDS over PT-CAN. Powertrain on legislated 7E0/7E8·7E1/7E9; body/chassis on BMW 0x6xx range (representative).",
  provenance: { source: "seed", confidence: 0.8, createdAt: NOW },
};

// ── Mercedes-Benz C300 (W205) — Bosch ME / 9G VGS / DISTRONIC ────────────────
const mbC300: VehicleProfile = {
  id: "2017-mercedes-benz-c300", year: 2017, make: "Mercedes-Benz", model: "C300", trim: "4MATIC (W205)",
  bodyType: "sedan", market: "US", wmi: ["WDD"],
  buses: [{ id: "hs-can", label: "HS-CAN (drivetrain) 500k", protocol: "CAN", bitrate: 500000, obdPins: "6/14" }],
  modules: [
    mod("ecm", "ME — Engine Control (M274 Turbo)", "powertrain", "engine", "7E0", "7E8", "Bosch", "A 274 902 15 00", "ME17.7.5", "A2749020100", "MB17ME1500"),
    mod("tcm-at", "VGS — 9G-Tronic Mechatronics", "transmission", "engine", "7E1", "7E9", "Continental", "A 725 901 05 00", "VGS4-9G", "A7259010100", "MB17VGS460"),
    mod("abs", "ESP — Electronic Stability Program", "chassis", "underbody", "7A0", "7A8", "Bosch", "A 000 901 68 05", "ESP9.60", "A0009016800", "MB17ESP805"),
    mod("srs", "SRS — Supplemental Restraints", "safety", "cabin_front", "780", "788", "Continental", "A 205 901 12 00", "SRS-W205", "A2059011200", "MB17SRS200"),
    mod("eps", "EPS — Electric Power Steering", "chassis", "front_right", "7A2", "7AA", "Bosch", "A 099 460 11 00", "EPS-3.2", "A0994601100", "MB17EPS100"),
    mod("meter", "IC — Instrument Cluster", "infotainment", "dash", "760", "768", "Continental VDO", "A 205 900 84 09", "IC-W205", "A2059008400", "MB17IC0409"),
    mod("gateway", "CGW — Central Gateway", "network", "dash", "770", "778", "Continental", "A 213 900 33 00", "CGW-5.1", "A2139003300", "MB17CGW300"),
    mod("fcm", "DISTRONIC — Forward Radar", "safety", "front_left", "730", "738", "Bosch", "A 000 905 76 00", "DTR-radar-4", "A0009057600", "MB17RDR600"),
  ],
  supportedPids: STD_PIDS, capabilities: STD_CAPS(),
  notes: "Mercedes W205 UDS. Part numbers use the MB 'A NNN NNN NN NN' scheme; 9G VGS mechatronics supplied by Continental.",
  provenance: { source: "seed", confidence: 0.8, createdAt: NOW },
};

// ── Audi A4 (B9) — Bosch MED / S-tronic DL382 / MQB gateway ──────────────────
const audiA4: VehicleProfile = {
  id: "2018-audi-a4", year: 2018, make: "Audi", model: "A4", trim: "2.0T quattro (B9)",
  bodyType: "sedan", market: "US", wmi: ["WAU"],
  buses: [{ id: "hs-can", label: "Powertrain CAN 500k", protocol: "CAN", bitrate: 500000, obdPins: "6/14" }],
  modules: [
    mod("ecm", "Engine Control J623 (EA888)", "powertrain", "engine", "7E0", "7E8", "Bosch", "8W0 907 551 K", "MED17.1.62", "8W0907551", "AU18ECU551"),
    mod("tcm-at", "Transmission J217 — S-tronic DL382", "transmission", "engine", "7E1", "7E9", "BorgWarner", "0D5 927 750 AB", "S-tronic-7", "0D5927750", "AU18TCU750"),
    mod("abs", "ABS/ESP J104 (MK100)", "chassis", "underbody", "713", "77D", "Bosch", "8W0 614 517 R", "ESP-MK100", "8W0614517", "AU18ABS517"),
    mod("srs", "Airbag J234", "safety", "cabin_front", "715", "77F", "Autoliv", "8W0 959 655 D", "airbag-VW-9", "8W0959655", "AU18SRS655"),
    mod("eps", "Power Steering J500 (APA)", "chassis", "front_right", "712", "77C", "ZF", "8W0 909 144 F", "EPS-APA", "8W0909144", "AU18EPS144"),
    mod("meter", "Instrument Cluster J285 (Virtual Cockpit)", "infotainment", "dash", "714", "77E", "Continental", "8W0 920 870 B", "VC-MMI", "8W0920870", "AU18IPC870"),
    mod("gateway", "Gateway J533", "network", "dash", "710", "77A", "Continental", "5Q0 907 530 T", "GW-J533", "5Q0907530", "AU18GWJ530"),
    mod("fcm", "ACC Radar J428", "safety", "front_left", "767", "7D1", "Bosch", "4M0 907 561 C", "ACC-MRR", "4M0907561", "AU18RDR561"),
  ],
  supportedPids: STD_PIDS, capabilities: STD_CAPS(),
  notes: "VAG UDS: non-powertrain modules use request 0x7xx with a +0x6A response offset (0x713→0x77D). S-tronic is a dual-clutch (BorgWarner).",
  provenance: { source: "seed", confidence: 0.8, createdAt: NOW },
};

// ── Volkswagen Golf (MQB) — Continental Simos / DSG DQ250 ────────────────────
const vwGolf: VehicleProfile = {
  id: "2018-volkswagen-golf", year: 2018, make: "Volkswagen", model: "Golf", trim: "1.8T SE (MQB)",
  bodyType: "hatchback", market: "US", wmi: ["3VW", "WVW"],
  buses: [{ id: "hs-can", label: "Powertrain CAN 500k", protocol: "CAN", bitrate: 500000, obdPins: "6/14" }],
  modules: [
    mod("ecm", "Engine Control J623 (EA888 1.8T)", "powertrain", "engine", "7E0", "7E8", "Continental", "06K 906 026 BB", "Simos18.1", "06K906026", "VW18ECU026"),
    mod("tcm-at", "Transmission J743 — DSG DQ250", "transmission", "engine", "7E1", "7E9", "Continental", "02E 927 770 AD", "DSG-DQ250", "02E927770", "VW18DSG770"),
    mod("abs", "ABS/ESC J104 (MK100 / ATE)", "chassis", "underbody", "713", "77D", "Continental", "5Q0 907 379 P", "ESC-MK100", "5Q0907379", "VW18ABS379"),
    mod("srs", "Airbag J234", "safety", "cabin_front", "715", "77F", "Autoliv", "5Q0 959 655 K", "airbag-MQB", "5Q0959655", "VW18SRS655"),
    mod("eps", "Power Steering J500", "chassis", "front_right", "712", "77C", "ZF", "5Q0 909 144 AB", "EPS-MQB", "5Q0909144", "VW18EPS144"),
    mod("meter", "Instrument Cluster J285", "infotainment", "dash", "714", "77E", "Continental VDO", "5G1 920 750 B", "KOMBI-MQB", "5G1920750", "VW18IPC750"),
    mod("gateway", "Gateway J533", "network", "dash", "710", "77A", "Continental", "5Q0 907 530 AH", "GW-J533", "5Q0907530", "VW18GWJ530"),
    mod("fcm", "Front Assist Radar J428", "safety", "front_left", "767", "7D1", "Continental", "5Q0 907 572 J", "ACC-Front", "5Q0907572", "VW18RDR572"),
  ],
  supportedPids: STD_PIDS, capabilities: STD_CAPS(),
  notes: "Shares the VAG MQB UDS scheme with the A4 (+0x6A response offset). Transmission is a DQ250 wet dual-clutch (DSG).",
  provenance: { source: "seed", confidence: 0.8, createdAt: NOW },
};

// ── Ford F-150 (P552) — 3.5 EcoBoost / 10R80 — REAL FEPS addresses ───────────
const fordF150: VehicleProfile = {
  id: "2018-ford-f-150", year: 2018, make: "Ford", model: "F-150", trim: "XLT 3.5 EcoBoost",
  bodyType: "truck", market: "US", wmi: ["1FT"],
  buses: [{ id: "hs-can", label: "HS-CAN 500k", protocol: "CAN", bitrate: 500000, obdPins: "6/14" }],
  modules: [
    mod("ecm", "PCM — Powertrain Control (3.5 EcoBoost)", "powertrain", "engine", "7E0", "7E8", "Continental", "JL3A-12A650-BKC", "PCM-EB35", "JL3A-12B684", "FD18PCM650"),
    mod("tcm-at", "TCM — 10R80 10-speed Automatic", "transmission", "engine", "7E1", "7E9", "Ford", "JL3P-7A100-AB", "10R80-TCM", "JL3P-7B012", "FD18TCM100"),
    mod("abs", "ABS — Anti-lock Brake Module", "chassis", "underbody", "760", "768", "Continental", "JL3T-2C405-AF", "ABS-EB", "JL3T-2B373", "FD18ABS405"),
    mod("srs", "RCM — Restraints Control Module", "safety", "cabin_front", "737", "73F", "Autoliv", "JL3T-14B321-AE", "RCM-F150", "JL3T-14C060", "FD18RCM321"),
    mod("eps", "PSCM — Power Steering Control", "chassis", "front_right", "730", "738", "Nexteer", "JL3T-3D070-AD", "EPAS-3.1", "JL3T-3F840", "FD18EPS070"),
    mod("meter", "IPC — Instrument Cluster", "infotainment", "dash", "720", "728", "Visteon", "JL3T-10849-AKB", "IPC-F150", "JL3T-10D889", "FD18IPC849"),
    mod("gateway", "GWM — Gateway Module", "network", "dash", "716", "71E", "Continental", "JL3T-14G371-AC", "GWM-2.4", "JL3T-14H075", "FD18GWM371"),
    mod("fcm", "CMR — Camera / Lane-keep", "safety", "front_left", "706", "70E", "Bosch", "JL3T-19H406-AF", "CMR-lane", "JL3T-19G490", "FD18CMR406"),
  ],
  supportedPids: STD_PIDS, capabilities: STD_CAPS(),
  notes: "Ford FEPS addressing is exact (PCM 7E8, ABS 768, RCM 73F, PSCM 738, IPC 728, GWM 71E). Ford 'AANA-NNNNA-AA' part scheme.",
  provenance: { source: "seed", confidence: 0.85, createdAt: NOW },
};

// ── Honda Accord (CV) — Keihin PGM-FI / CVT / Honda Sensing ──────────────────
const hondaAccord: VehicleProfile = {
  id: "2018-honda-accord", year: 2018, make: "Honda", model: "Accord", trim: "1.5T Touring",
  bodyType: "sedan", market: "US", wmi: ["1HG"],
  buses: [{ id: "hs-can", label: "F-CAN 500k", protocol: "CAN", bitrate: 500000, obdPins: "6/14" }],
  modules: [
    mod("ecm", "PCM — PGM-FI Engine Control (L15)", "powertrain", "engine", "7E0", "7E8", "Keihin", "37820-6B2-A05", "PGMFI-L15", "37805-6B2", "HN18ECU820"),
    mod("tcm", "CVT-TCM — Continuously Variable", "transmission", "engine", "7E1", "7E9", "Honda", "28100-6C7-A03", "CVT-TCM", "28000-6C7", "HN18TCM100"),
    mod("abs", "VSA — Vehicle Stability Assist", "chassis", "underbody", "760", "768", "Nissin", "57110-TVA-A03", "VSA-9.2", "57115-TVA", "HN18VSA110"),
    mod("srs", "SRS — Supplemental Restraints", "safety", "cabin_front", "770", "778", "Autoliv", "77960-TVA-A11", "SRS-Accord", "77970-TVA", "HN18SRS960"),
    mod("eps", "EPS — Electric Power Steering", "chassis", "front_right", "750", "758", "Showa", "53681-TVA-A01", "EPS-Accord", "53680-TVA", "HN18EPS681"),
    mod("meter", "Gauge — Combination Meter", "infotainment", "dash", "740", "748", "Nippon Seiki", "78100-TVA-A11", "GAUGE-2.1", "78120-TVA", "HN18MTR100"),
    mod("bcm", "MICU — Body Control (B-CAN)", "body", "dash", "720", "728", "Honda", "38809-TVA-A01", "MICU-1.4", "38800-TVA", "HN18BCM809"),
    mod("fcm", "Honda Sensing — Radar", "safety", "front_left", "780", "788", "Bosch", "36802-TVA-A03", "MRR-Sensing", "36160-TVA", "HN18RDR802"),
  ],
  supportedPids: STD_PIDS, capabilities: STD_CAPS(),
  notes: "Honda part prefixes are functional (37820=PGM-FI ECU, 57110=VSA, 77960=SRS, 78100=meter). CVT built in-house.",
  provenance: { source: "seed", confidence: 0.8, createdAt: NOW },
};

// ── Nissan Altima (L34) — Hitachi ECM / JATCO CVT / ProPilot ─────────────────
const nissanAltima: VehicleProfile = {
  id: "2019-nissan-altima", year: 2019, make: "Nissan", model: "Altima", trim: "2.5 SV",
  bodyType: "sedan", market: "US", wmi: ["1N4"],
  buses: [{ id: "hs-can", label: "CAN-C 500k", protocol: "CAN", bitrate: 500000, obdPins: "6/14" }],
  modules: [
    mod("ecm", "ECM — Engine Control (PR25DD)", "powertrain", "engine", "7E0", "7E8", "Hitachi", "23703-6CA0A", "PR25-ECM", "23710-6CA", "NS19ECU703"),
    mod("tcm", "TCM — JATCO CVT8", "transmission", "engine", "7E1", "7E9", "JATCO", "31036-6CA0A", "CVT8-TCM", "31020-6CA", "NS19TCM036"),
    mod("abs", "ABS Actuator & Control", "chassis", "underbody", "740", "748", "Bosch", "47660-6CA0A", "ABS-9.3", "47600-6CA", "NS19ABS660"),
    mod("srs", "Air Bag Diagnosis Sensor Unit", "safety", "cabin_front", "730", "738", "Continental", "98820-6CA0A", "SRS-L34", "98800-6CA", "NS19SRS820"),
    mod("eps", "EPS — Electric Power Steering", "chassis", "front_right", "742", "74A", "JTEKT", "48811-6CA0A", "EPS-Altima", "48810-6CA", "NS19EPS811"),
    mod("meter", "Combination Meter", "infotainment", "dash", "720", "728", "Nippon Seiki", "24810-6CA0A", "METER-L34", "24814-6CA", "NS19MTR810"),
    mod("bcm", "BCM — Body Control Module", "body", "dash", "750", "758", "Nissan", "284B1-6CA0A", "BCM-L34", "284B0-6CA", "NS19BCM4B1"),
    mod("fcm", "ProPilot — Forward Radar", "safety", "front_left", "760", "768", "Bosch", "28438-6CA0A", "PP-radar", "28430-6CA", "NS19RDR438"),
  ],
  supportedPids: STD_PIDS, capabilities: STD_CAPS(),
  notes: "Nissan 'NNNNN-XXXXX' part scheme (23703=ECM, 47660=ABS, 98820=airbag, 284B1=BCM). CVT8 supplied by JATCO.",
  provenance: { source: "seed", confidence: 0.8, createdAt: NOW },
};

export const BRAND_SEED_PROFILES: VehicleProfile[] = [
  bmw340i, mbC300, audiA4, vwGolf, fordF150, hondaAccord, nissanAltima,
];
