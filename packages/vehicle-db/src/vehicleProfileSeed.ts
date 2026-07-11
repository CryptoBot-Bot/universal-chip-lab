/**
 * Seed vehicle profiles — ship in the build, travel with publishes.
 *
 * Flagship vehicle #1: 2020 Toyota Corolla (TSS 2.0). Chosen because it is one of
 * the most thoroughly reverse-engineered platforms on the open internet
 * (comma.ai `opendbc` Toyota DBCs) and it answers the fully-public SAE J1979
 * OBD-II PID set — so the simulator that emulates it is unencumbered. Addresses
 * for ECM (7E0/7E8, universal OBD) and the CVT TCM (7E1/7E9, from our bench work)
 * are known; the rest are seeded as known-present modules with 3D locations and
 * left for AI/bench mapping to enrich — which is the whole point of the growing DB.
 */

import type { VehicleProfile } from "./vehicleProfile.schema.js";
import { PIDS } from "./obdPids.js";
import { BRAND_SEED_PROFILES } from "./vehicleProfileSeedBrands.js";

const NOW = "2026-07-08T00:00:00.000Z";
const STD_PIDS = PIDS.map((p) => p.pid);

const corolla2020: VehicleProfile = {
  id: "2020-toyota-corolla",
  year: 2020,
  make: "Toyota",
  model: "Corolla",
  trim: "SE / LE (TSS 2.0)",
  bodyType: "sedan",
  market: "US",
  wmi: ["JTD", "2T1", "5YF"],
  buses: [
    { id: "hs-can", label: "HS-CAN (powertrain/chassis)", protocol: "CAN", bitrate: 500000, obdPins: "6/14" },
  ],
  modules: [
    { id: "ecm", label: "Engine Control Module", category: "powertrain", bus: "hs-can", location: "engine",
      addressing: { request: "7E0", response: "7E8" }, busKnowledgeId: "obd2_powertrain_7e8" },
    { id: "tcm", label: "CVT Transaxle Control", category: "transmission", bus: "hs-can", location: "engine",
      addressing: { request: "7E1", response: "7E9" } },
    { id: "abs", label: "Skid Control (ABS / VSC / TRAC)", category: "chassis", bus: "hs-can", location: "underbody",
      addressing: { request: "7B0", response: "7B8" } },
    { id: "srs", label: "Airbag (SRS)", category: "safety", bus: "hs-can", location: "cabin_front" },
    { id: "bcm", label: "Main Body ECU", category: "body", bus: "hs-can", location: "dash" },
    { id: "meter", label: "Combination Meter", category: "infotainment", bus: "hs-can", location: "dash" },
    { id: "hvac", label: "A/C Amplifier", category: "hvac", bus: "hs-can", location: "dash" },
    { id: "fcm", label: "Forward Recognition (TSS radar/camera)", category: "safety", bus: "hs-can", location: "front_left",
      addressing: { request: "7D0", response: "7D8" } },
    { id: "eps", label: "Electric Power Steering", category: "chassis", bus: "hs-can", location: "front_right",
      addressing: { request: "7A6", response: "7AE" } },
    { id: "gateway", label: "Central Gateway (CGW)", category: "network", bus: "hs-can", location: "dash",
      addressing: { request: "750", response: "758" } },
    { id: "cert", label: "Smart Key / Certification (immo)", category: "body", bus: "hs-can", location: "dash",
      addressing: { request: "751", response: "759" } },
    { id: "park", label: "Parking Assist (Clearance Sonar)", category: "body", bus: "hs-can", location: "rear_left",
      addressing: { request: "7B6", response: "7BE" } },
  ],
  supportedPids: STD_PIDS,
  capabilities: [
    { id: "live-data", label: "Live engine data (RPM, speed, coolant…)", category: "diagnostic", risk: "read",
      bus: "hs-can", module: "ecm", sequence: ["01 0C", "01 0D", "01 05", "01 11"], note: "Standard J1979 mode 01." },
    { id: "read-dtcs", label: "Read stored DTCs", category: "diagnostic", risk: "read",
      bus: "hs-can", module: "ecm", sequence: ["03"], note: "OBD-II mode 03." },
    { id: "read-vin", label: "Read VIN", category: "diagnostic", risk: "read",
      bus: "hs-can", module: "ecm", sequence: ["09 02"] },
    { id: "tcm-live", label: "Read CVT live block", category: "transmission", risk: "read",
      bus: "hs-can", module: "tcm", sequence: ["10 81", "21 F0"], note: "KWP-style hybrid read (from bench TCM work)." },
    { id: "clear-dtcs", label: "Clear DTCs", category: "diagnostic", risk: "write",
      bus: "hs-can", module: "ecm", sequence: ["04"], note: "WRITE — gated by the Cloning Ceremony write gate." },
  ],
  notes: "Flagship seed vehicle. ECM/TCM addresses verified; body/chassis modules seeded by location, addresses pending AI/bench mapping.",
  provenance: { source: "seed", confidence: 0.9, createdAt: NOW },
};

export const SEED_VEHICLE_PROFILES: VehicleProfile[] = [corolla2020, ...BRAND_SEED_PROFILES];
