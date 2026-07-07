import type { BusModuleKnowledge } from "./busKnowledge.schema.js";

/**
 * Seed bus knowledge — ships inside the package, so it travels with every
 * published build. Every operator gets this baseline the first time they open
 * the app; the AI mapper and disk store grow it from there, and "Bake into app"
 * folds learned records back in here for the next release.
 *
 * Keep these HONEST: only what has actually been observed on a real bus, with
 * provenance to match. The bench TCM below is the first module we cracked
 * end-to-end (KWP2000 on 7E1/7E9, 2026-07-07).
 */
export const SEED_BUS_MODULES: BusModuleKnowledge[] = [
  {
    id: "kwp_tcm_7e9_bench",
    label: "Transmission control (TCM) — KWP2000",
    category: "TCU",
    appliesTo: "Bench TCM cracked 2026-07-07 — KWP2000 on 7E1/7E9",
    protocol: "kwp2000",
    addressing: { request: "7E1", response: "7E9" },
    fingerprint: {
      responseId: "7E9",
      broadcastIds: [],
      signature: "21 F0 → 61 F0 31 58 4A 33 41 … (fixed hardware/part id block)",
    },
    sessions: [
      { request: "10 81", name: "Standard diagnostic session", response: "50 81", note: "Safe default. DTC read (19 02) works here; most 21 ids need C0/85." },
      { request: "10 C0", name: "Manufacturer session (C0)", response: "50 C0", note: "The rich data session — unlocks measurement/snapshot blocks (21 02/13/16-1B) and identity (21 82/83/FE/FF)." },
      { request: "10 85", name: "Session 85 (extended/dev)", response: "50 85", note: "Unlocks the hardware-id blocks 21 F0/FC and serials 21 F1/FD. Likely programming-capable — read only unless intended." },
      { request: "10 86", name: "Session 86", response: "50 86", note: "Exposes part-number blocks 21 FE/FF." },
    ],
    services: [
      { sid: "10", name: "StartDiagnosticSession", supported: true, note: "Accepts sub-functions 81/C0/85/86; rejects UDS 01/03 (7F1012)." },
      { sid: "21", name: "ReadDataByLocalIdentifier (KWP)", supported: true, note: "The main read path. Session-gated — the same id returns different blocks per session." },
      { sid: "19", name: "ReadDTCInformation (subfn 02)", supported: true, note: "Hybrid: 19 02 FF returns stored DTCs (59 02 …) in sessions 81 and C0. Rejected (7F1911) in 85." },
      { sid: "22", name: "ReadDataByIdentifier (UDS)", supported: false, nrc: "11", note: "Not this dialect — 22 F190 VIN does not exist here." },
      { sid: "18", name: "ReadDTCByStatus (KWP)", supported: false, nrc: "11" },
      { sid: "13", name: "ReadDTCByStatus (13)", supported: false, nrc: "11" },
      { sid: "17", name: "ReadStatusOfDTC (17)", supported: false, nrc: "11" },
      { sid: "1A", name: "ReadEcuIdentification (KWP)", supported: false, nrc: "11" },
      { sid: "3E", name: "TesterPresent", supported: false, nrc: "12", note: "3E00 sub-function rejected; keep session alive by re-sending 10 XX." },
    ],
    dataIdentifiers: [
      { request: "21 F0", name: "Hardware identifier A", session: "10 85",
        sampleResponse: "61 F0 31 58 4A 33 41 83 41 06 04 00 01 00 00 00 00 13 00 00 00 13 00 00 00 80",
        decoded: "ASCII '1XJ3A…' then counters — the primary hardware-id block (also at 21 FC)." },
      { request: "21 FE", name: "Part number", session: "10 85",
        sampleResponse: "61 FE 32 36 58 30 45 85 41 06 04 00 01 00 63 20 14 50 00 00 14 50 00 00 00 80",
        decoded: "ASCII '26X0E…' — the module part/hardware number. Use this to source a correct donor." },
      { request: "21 83", name: "Part / broadcast code", session: "10 C0",
        sampleResponse: "61 83 32 36 58 30 45 85 41 06 04 00 01 14 50 00 00 00 80 FF",
        decoded: "ASCII '26X0E…' — matches 21 FE. Identity/broadcast code." },
      { request: "21 FF", name: "Flash / calibration checksum markers", session: "10 C0",
        sampleResponse: "61 FF 00 00 00 00 00 00 46 30 30 30 30 46 30 30 30 30 01 16 01 13 00 00 5C DF D5",
        decoded: "ASCII 'F0000F0000' region markers + a checksum word — calibration block signature." },
      { request: "21 82", name: "Supplier code", session: "10 C0",
        sampleResponse: "61 82 53 43 00 FF E8 FF …",
        decoded: "ASCII 'SC' — supplier/manufacturer code." },
      { request: "21 02", name: "Live measurement block", session: "10 C0",
        sampleResponse: "61 02 0B 65 54 00 47 AA 6F 00 02 A4 FD FC FE 7B 01 1A FE 7A 01 74 FE 83 01 1C 08 5D 1D 37 00 F3 1C DB 06 FD 06 FF FF FF FF",
        decoded: "Live sensor/actuator block (temps, pressures, solenoid currents) — changes with state." },
      { request: "21 13", name: "Snapshot / freeze-frame block", session: "10 C0",
        decoded: "Large fixed-layout status/freeze block (also 21 16/17/18/19/1A/1B)." },
      { request: "21 FD", name: "ECU serial / counters", session: "10 85",
        sampleResponse: "61 FD 00 00 00 00 00 00 46 30 30 30 30 46 30 30 30 30 00 07 08 01 10 24 5C A6 AE",
        decoded: "Serial/counter block ('F0000F0000' + a rolling value)." },
    ],
    capabilities: [
      {
        title: "Read stored fault codes (DTCs)",
        how: "Open the standard session and read DTC information subfunction 02 with an all-status mask. Returns 59 02 followed by 4-byte records (3-byte code + status).",
        commands: ["10 81", "19 02 FF"],
        risk: "read",
        note: "Confirmed: returned P2807/P0775/P2713/P0740/P0745/U0100 on the bench module.",
      },
      {
        title: "Read part & hardware numbers",
        how: "Enter session 85 and read the identity blocks — the part number (21 FE, '26X0E…') and hardware id (21 F0, '1XJ3A…'). These are what you match when sourcing a donor.",
        commands: ["10 85", "21 FE", "21 F0", "21 FC"],
        risk: "read",
      },
      {
        title: "Read live measurement data",
        how: "Enter the manufacturer session and read block 02 — a live block of transmission temps, pressures and solenoid currents that changes with state.",
        commands: ["10 C0", "21 02"],
        risk: "read",
      },
      {
        title: "Full identity + snapshot dump",
        how: "Enter each session and read its confirmed identity/snapshot ids to fingerprint the module completely.",
        commands: ["10 C0", "21 00", "21 82", "21 83", "21 FE", "21 FF", "10 85", "21 F0", "21 FC", "21 FD"],
        risk: "read",
        note: "Read-only enumeration. No writes, no clears.",
      },
    ],
    notes:
      "First module cracked end-to-end with the MCP2515 reader (2539 transmits, txFail=0, tec=0). Hybrid dialect: KWP 0x21 local-id reads gated per session PLUS UDS 0x19 02 DTC read. The same 21 id returns different blocks depending on the active session (81/C0/85/86). Part number reads as ASCII '26X0E…', hardware id as '1XJ3A…'. VIN service (09/22 F190) absent. These are diagnostic/identity reads, not a raw memory image — the byte-exact clone still needs the memory front-door.",
    provenance: {
      source: "bench_observed",
      confidence: "medium",
      createdAt: "2026-07-07T00:00:00.000Z",
      observedOn: "2026-07-07",
    },
  },
  {
    id: "obd2_powertrain_7e8",
    label: "OBD-II powertrain (generic)",
    category: "ECU",
    appliesTo: "Any OBD-II-compliant ECM/PCM answering the legislated modes",
    protocol: "obd2",
    addressing: { request: "7E0", response: "7E8" },
    fingerprint: { responseId: "7E8", broadcastIds: [] },
    sessions: [],
    services: [
      { sid: "01", name: "Show current data (live PIDs)", supported: true, note: "01 00 returns the supported-PID bitmask." },
      { sid: "03", name: "Show stored DTCs", supported: true },
      { sid: "09", name: "Vehicle information (VIN etc.)", supported: true, note: "09 02 = VIN." },
    ],
    dataIdentifiers: [
      { request: "01 00", name: "Supported PIDs [01–20]", sampleResponse: "", decoded: "Bitmask of which mode-01 PIDs the ECU supports." },
      { request: "01 0C", name: "Engine RPM", decoded: "((A*256)+B)/4 rpm." },
      { request: "01 0D", name: "Vehicle speed", decoded: "A km/h." },
      { request: "09 02", name: "VIN", decoded: "17-char ASCII across a multi-frame ISO-TP response." },
    ],
    capabilities: [
      {
        title: "Read live engine data",
        how: "Standard OBD-II mode 01. Send the PID you want to the powertrain request id.",
        commands: ["01 0C", "01 0D", "01 05"],
        risk: "read",
      },
      {
        title: "Read the VIN",
        how: "Mode 09 PID 02 — the ECU answers with the 17-character VIN over ISO-TP.",
        commands: ["09 02"],
        risk: "read",
      },
      {
        title: "Read & clear stored trouble codes",
        how: "Mode 03 lists stored DTCs. (Clearing, mode 04, is a write — kept out of the read-only path.)",
        commands: ["03"],
        risk: "read",
      },
    ],
    notes: "Reference entry for the legislated OBD-II services every compliant powertrain module answers. Not module-specific.",
    provenance: {
      source: "seed",
      confidence: "high",
      createdAt: "2026-07-07T00:00:00.000Z",
    },
  },
];
