import type { ModuleProfile } from "./moduleProfile.schema.js";

/**
 * Curated module profiles. All entries are marked `status: "documented"` —
 * meaning the chip choices and access paths come from community-documented
 * teardowns and tuning-tool databases, NOT personal bench verification.
 * Bump an entry to `"verified"` once you've personally read the chips listed
 * on a physical PCB.
 */
export const SEED_MODULES: ModuleProfile[] = [
  // ------------------------------------------------ Bench / training ----
  {
    moduleProfileId: "loose_w25q32_spi_flash",
    displayName: "Loose W25Q32 SPI Flash (bench / training)",
    brand: "Other",
    manufacturer: "Winbond / Eon / Zbit / XTX (any 4 MB clone)",
    category: "OTHER",
    partNumberPattern: "W25Q32xx · EN25Q32 · ZB25VQ32 · XT25F32B · MX25L3206E · M25P32",
    yearRange: [2010, 2030],
    applications: [
      "Bench training chip on a SOIC-8 breakout module",
      "Generic 4 MB SPI NOR Flash work",
      "Calibration banks on some Bosch ECUs (paired with other memories — use a proper module profile for full ECU clones)",
    ],
    mcu: {
      family: "n/a — standalone serial flash chip",
      accessMethods: ["soic_clip", "desolder"],
    },
    memories: [
      {
        role: "calibration_flash",
        chipProfileId: "winbond_w25q32",
        accessMethod: "soic_clip",
        note: "Any 3.3 V SPI programmer (CH341A through level shifter, FT232H, Bus Pirate). flashrom auto-detects the actual silicon (Winbond / Eon / Zbit / XTX) via JEDEC ID — the profile label is just a name.",
      },
    ],
    immo: {
      storedIn: "none",
      clonableByteExact: "yes",
      notes: "Standalone training chip — no immo binding. Cloning is byte-exact image transfer.",
    },
    cloneAccessibility: "external_only",
    donorCompatibilityNote: "Donor can be any 4 MB SPI NOR with compatible SPI command set (Winbond W25Q32, Eon EN25Q32, Zbit ZB25VQ32, XTX XT25F32B, Macronix MX25L3206E, ST M25P32). JEDEC IDs differ but the image is identical.",
    knownGotchas: [
      "This is a synthetic bench profile — not a real automotive module.",
      "If you need to clone a real ECU, use the appropriate brand-specific profile so the workflow tracks the right memories and binding info.",
    ],
    status: "documented",
  },
  {
    moduleProfileId: "loose_w25q64_spi_flash",
    displayName: "Loose W25Q64 SPI Flash (bench / training)",
    brand: "Other",
    manufacturer: "Winbond / Macronix / clone",
    category: "OTHER",
    partNumberPattern: "W25Q64xx · EN25Q64 · MX25L6406E · ZB25VQ64",
    yearRange: [2010, 2030],
    applications: [
      "Bench training chip on a SOIC-8 breakout module",
      "Generic 8 MB SPI NOR Flash work",
    ],
    mcu: {
      family: "n/a — standalone serial flash chip",
      accessMethods: ["soic_clip", "desolder"],
    },
    memories: [
      {
        role: "calibration_flash",
        chipProfileId: "winbond_w25q64",
        accessMethod: "soic_clip",
        note: "Any 3.3 V SPI programmer; flashrom auto-detects via JEDEC ID.",
      },
    ],
    immo: {
      storedIn: "none",
      clonableByteExact: "yes",
      notes: "Standalone training chip — no immo binding.",
    },
    cloneAccessibility: "external_only",
    donorCompatibilityNote: "Any 8 MB SPI NOR with standard SPI command set.",
    knownGotchas: [
      "This is a synthetic bench profile — not a real automotive module.",
    ],
    status: "documented",
  },

  // ---------------------------------------------------------------- VAG ----
  {
    moduleProfileId: "vag_bosch_edc15_p_v",
    displayName: "Bosch EDC15P / EDC15V (1.9 TDI PD)",
    brand: "VAG",
    manufacturer: "Bosch",
    category: "ECU",
    ecuCode: "EDC15P/V/VM/C2",
    partNumberPattern: "038 906 019 xx (and many siblings)",
    yearRange: [1998, 2005],
    applications: [
      "Audi A4 B5/B6 1.9 TDI",
      "VW Passat B5 1.9 TDI",
      "VW Golf Mk4 1.9 TDI / PD",
      "Seat Ibiza / Leon TDI",
      "Skoda Octavia Mk1 TDI",
    ],
    mcu: {
      family: "Infineon C167",
      variants: ["SAK-C167CS-LM"],
      accessMethods: ["soic_clip", "obd_kline", "bench_boot"],
    },
    memories: [
      { role: "immo_eeprom",     chipProfileId: "stmicroelectronics_m95040", accessMethod: "soic_clip", note: "VIN + immo secret + adaptations. Usually marked 24LC04 or 95040 — confirm by package." },
      { role: "calibration_flash", chipProfileId: "stmicroelectronics_m25p40", accessMethod: "bench_boot", note: "Main program; reachable via Bosch K-line bootmode for read." },
    ],
    immo: {
      storedIn: "external_eeprom",
      clonableByteExact: "yes",
      notes: "Cloning external 95040 byte-exact into matched donor PCB usually allows the car to start. If cluster is also replaced, may need IMMO 'login' procedure or VAG-COM PIN.",
    },
    cloneAccessibility: "external_only",
    donorCompatibilityNote: "Donor must share the engine code (e.g. ASZ/AJM/AHF) and ideally the same Bosch hardware index. Cross-mapping between 90/100/130/150 PD variants is brittle.",
    knownGotchas: [
      "Some PD150 maps refuse to clone cleanly across hardware revisions.",
      "Immo-OFF files exist publicly — do NOT distribute; out of scope for this app.",
    ],
    status: "documented",
  },
  {
    moduleProfileId: "vag_bosch_edc16u34",
    displayName: "Bosch EDC16U34 / EDC16U31 (2.0 TDI PD-DPF era)",
    brand: "VAG",
    manufacturer: "Bosch",
    category: "ECU",
    ecuCode: "EDC16U34",
    partNumberPattern: "03G 906 016 xx",
    yearRange: [2003, 2009],
    applications: [
      "Audi A4 B7 2.0 TDI",
      "VW Passat B6 2.0 TDI",
      "VW Golf Mk5 2.0 TDI",
      "Seat Altea 2.0 TDI",
      "Skoda Octavia II 2.0 TDI",
    ],
    mcu: {
      family: "Freescale Motorola MPC56x",
      variants: ["MPC562", "MPC563"],
      package: "BGA-272",
      accessMethods: ["soic_clip", "bench_boot", "bdm", "nexus"],
    },
    memories: [
      { role: "immo_eeprom",       chipProfileId: "stmicroelectronics_m95160", accessMethod: "soic_clip" },
      { role: "calibration_flash", chipProfileId: "macronix_mx25l8005",        accessMethod: "soic_clip", note: "MX25L family external program / cal flash on most variants. Same SOIC-8 SPI clip works." },
      { role: "main_program_flash", chipProfileId: "macronix_mx25l3206e",      accessMethod: "soic_clip", note: "Some variants use 4 MB instead of 1 MB. Identify by JEDEC ID first." },
    ],
    immo: {
      storedIn: "external_eeprom",
      clonableByteExact: "yes",
      notes: "95160 holds VIN, immo secret, K-line/CAN sync. Clone + matched donor → car starts. Cluster pairing intact.",
    },
    cloneAccessibility: "external_only",
    donorCompatibilityNote: "Match Bosch hardware index AND software version stamped on the housing. Same 03G 906 016 N as 03G 906 016 K isn't always swappable without re-coding.",
    knownGotchas: [
      "DPF regeneration counters live in 95160 — clone preserves them.",
      "Some EDC16U34 variants exist with internal flash only (no external MX25L). Identify before planning."
    ],
    status: "documented",
  },
  {
    moduleProfileId: "vag_bosch_edc17c46",
    displayName: "Bosch EDC17C46 (2.0/3.0 TDI common-rail)",
    brand: "VAG",
    manufacturer: "Bosch",
    category: "ECU",
    ecuCode: "EDC17C46",
    partNumberPattern: "03L 906 022 xx, 4F 906 056 xx",
    yearRange: [2008, 2016],
    applications: [
      "Audi A4 B8 2.0 TDI",
      "Audi A6 C7 3.0 TDI",
      "VW Passat B7 2.0 TDI",
      "VW Tiguan 2.0 TDI",
      "Skoda Superb 2.0 TDI",
    ],
    mcu: {
      family: "Infineon Tricore",
      variants: ["TC1797"],
      package: "BGA-416",
      accessMethods: ["soic_clip", "bench_boot", "jtag"],
    },
    memories: [
      { role: "immo_eeprom",          chipProfileId: "stmicroelectronics_m95080",   accessMethod: "soic_clip" },
      { role: "mcu_internal_flash",   chipProfileId: "stmicroelectronics_m25p64",  accessMethod: "bench_boot", note: "Most of the program lives INTERNAL to TC1797. External chip listed is a placeholder until we model internal flash properly (Phase F)." },
    ],
    immo: {
      storedIn: "internal_mcu",
      clonableByteExact: "usually",
      notes: "Immo pairing partly in TC1797 internal flash. External 95080 read alone is NOT enough for a working clone — must include internal MCU read via bench boot.",
    },
    cloneAccessibility: "internal_required",
    donorCompatibilityNote: "Donor must match hardware revision + software index exactly. EDC17 is far less forgiving than EDC16.",
    knownGotchas: [
      "Newer EDC17 boxes are increasingly locked — TPROT levels can block bench-boot tools.",
      "Until Phase F (Tricore BSL) ships, this profile is read-only-external in this app.",
    ],
    status: "documented",
  },
  {
    moduleProfileId: "vag_bosch_me75",
    displayName: "Bosch ME7.5 / ME7.1.1 (1.8T 20V gasoline)",
    brand: "VAG",
    manufacturer: "Bosch",
    category: "ECU",
    ecuCode: "ME7.5 / ME7.1.1",
    partNumberPattern: "06A 906 032 xx, 8D0 907 558 xx",
    yearRange: [1998, 2005],
    applications: [
      "Audi A4 B5/B6 1.8T",
      "Audi TT Mk1 1.8T",
      "VW Passat B5 1.8T",
      "VW Golf Mk4 1.8T",
      "Seat Leon 1M 1.8T",
    ],
    mcu: {
      family: "Infineon C167",
      variants: ["SAK-C167CR"],
      accessMethods: ["soic_clip", "obd_kline"],
    },
    memories: [
      { role: "immo_eeprom", chipProfileId: "stmicroelectronics_m95040", accessMethod: "soic_clip", note: "Immo bits at known offsets; 512 bytes total." },
      { role: "calibration_flash", chipProfileId: "stmicroelectronics_m25p40", accessMethod: "obd_kline", note: "Full bin obtainable over K-line with Galletto / WinOLS-style tool." },
    ],
    immo: {
      storedIn: "external_eeprom",
      clonableByteExact: "yes",
      notes: "One of the easiest VAG clones — 95040 byte-exact into matched donor box.",
    },
    cloneAccessibility: "external_only",
    donorCompatibilityNote: "Donor part number ideally identical. Cross-engine swaps (AGU vs AWP) need calibration matching.",
    knownGotchas: [],
    status: "documented",
  },
  {
    moduleProfileId: "vag_cluster_vdo_d70f3",
    displayName: "VDO Instrument Cluster (NEC D70F3xxx)",
    brand: "VAG",
    manufacturer: "Siemens VDO / Continental",
    category: "IC",
    ecuCode: "VDO-NEC",
    partNumberPattern: "3C0 920 xxx, 1K0 920 xxx",
    yearRange: [2003, 2014],
    applications: [
      "VW Golf Mk5 / Mk6",
      "VW Passat B6 / B7",
      "Audi A3 8P",
      "Skoda Octavia II",
    ],
    mcu: {
      family: "NEC V850 (78F / 70F)",
      variants: ["D70F3xxx", "D70F35xx"],
      accessMethods: ["obd_can", "bench_boot"],
    },
    memories: [
      { role: "mileage_eeprom", chipProfileId: "stmicroelectronics_m95320", accessMethod: "soic_clip", note: "External EEPROM holds VIN, immo data, and a mileage shadow. Mileage primary lives in NEC internal flash." },
    ],
    immo: {
      storedIn: "paired_with_cluster",
      clonableByteExact: "depends_on_brand_era",
      notes: "Cluster owns part of the immo handshake (J393 / Kessy). Replacing a cluster typically needs SKC adapt with a VAG dealer tool or VCDS.",
    },
    cloneAccessibility: "mixed",
    donorCompatibilityNote: "Exact part-number match required, and CAN gateway will reject obvious VIN mismatches across model years.",
    knownGotchas: [
      "Mileage tampering is unlawful in nearly every jurisdiction — this profile is read-only by policy in this app.",
    ],
    status: "documented",
  },

  // ---------------------------------------------------------------- BMW ----
  {
    moduleProfileId: "bmw_bosch_ms43",
    displayName: "Bosch MS43 (M54 inline-6 gasoline)",
    brand: "BMW",
    manufacturer: "Bosch",
    category: "ECU",
    ecuCode: "MS43",
    partNumberPattern: "DME 7 532 xxx",
    yearRange: [2001, 2006],
    applications: [
      "BMW E46 325i / 330i",
      "BMW E39 525i / 530i",
      "BMW E60 525i / 530i (early)",
      "BMW E83 X3",
      "BMW E85 Z4 2.5i / 3.0i",
    ],
    mcu: {
      family: "Infineon C167",
      variants: ["SAK-C167CR-LM"],
      accessMethods: ["soic_clip", "obd_kline"],
    },
    memories: [
      { role: "immo_eeprom",       chipProfileId: "stmicroelectronics_m95080", accessMethod: "soic_clip", note: "Paired with EWS3. ISN (Individual Serial Number) lives here." },
      { role: "calibration_flash", chipProfileId: "stmicroelectronics_m25p20", accessMethod: "obd_kline" },
    ],
    immo: {
      storedIn: "paired_with_immo_box",
      clonableByteExact: "yes",
      notes: "MS43 ↔ EWS3 marriage by ISN. Cloning a DONOR MS43 to look like the original means copying the original's 95080 (which carries the ISN) into the donor.",
    },
    cloneAccessibility: "external_only",
    donorCompatibilityNote: "Same hardware index. Different DME part numbers (5WK9 vs 7532) are NOT interchangeable.",
    knownGotchas: [
      "If donor is from an automatic car and target is manual (or vice versa), trans adaptations differ — software match required.",
    ],
    status: "documented",
  },
  {
    moduleProfileId: "bmw_bosch_msv70_msv80",
    displayName: "Bosch MSV70 / MSV80 (N52/N53 gasoline)",
    brand: "BMW",
    manufacturer: "Bosch",
    category: "ECU",
    ecuCode: "MSV70 / MSV80",
    yearRange: [2005, 2013],
    applications: [
      "BMW E90/E91/E92 325i/328i/330i (N52/N53)",
      "BMW E60 LCI 525i/530i",
      "BMW E83 X3 N52",
      "BMW E70 X5 3.0si",
    ],
    mcu: {
      family: "Infineon Tricore",
      variants: ["TC1796"],
      accessMethods: ["soic_clip", "bench_boot", "jtag"],
    },
    memories: [
      { role: "immo_eeprom",          chipProfileId: "stmicroelectronics_m95256",   accessMethod: "soic_clip", note: "MSV80 carries pairing data with CAS3/CAS3+." },
      { role: "main_program_flash",   chipProfileId: "macronix_mx25l3206e",         accessMethod: "soic_clip" },
    ],
    immo: {
      storedIn: "paired_with_immo_box",
      clonableByteExact: "usually",
      notes: "DME ↔ CAS marriage via ISN. Clone of original DME's external memories into donor DME usually preserves the ISN match. If CAS is also dead, this gets harder.",
    },
    cloneAccessibility: "external_plus_obd_clone",
    donorCompatibilityNote: "Match DME P/N exactly. N52 and N53 DMEs are NOT interchangeable.",
    knownGotchas: [
      "EWS-delete is a tuner shortcut, NOT supported in this app.",
    ],
    status: "documented",
  },
  {
    moduleProfileId: "bmw_bosch_msd80_msd87",
    displayName: "Bosch MSD80 / MSD81 / MSD85 / MSD87 (N54/N55/S65/N63)",
    brand: "BMW",
    manufacturer: "Bosch",
    category: "ECU",
    ecuCode: "MSD80 family",
    yearRange: [2006, 2013],
    applications: [
      "BMW E90/E92 335i (N54/N55)",
      "BMW E60 N54 (535i)",
      "BMW E70 X5 N63 4.4i",
      "BMW E92 M3 (MSS60 — but very close cousin)",
    ],
    mcu: {
      family: "Infineon Tricore",
      variants: ["TC1796"],
      accessMethods: ["soic_clip", "bench_boot", "jtag"],
    },
    memories: [
      { role: "immo_eeprom",        chipProfileId: "stmicroelectronics_m95256", accessMethod: "soic_clip" },
      { role: "main_program_flash", chipProfileId: "macronix_mx25l6406e",       accessMethod: "soic_clip" },
    ],
    immo: {
      storedIn: "paired_with_immo_box",
      clonableByteExact: "usually",
      notes: "Same MSD ↔ CAS marriage. Cloned donor + correct external memories + matching CAS = car starts.",
    },
    cloneAccessibility: "external_plus_obd_clone",
    donorCompatibilityNote: "MSD80 (N54) vs MSD81 (N55) vs MSD87 (N63) are NOT interchangeable. Match exactly.",
    knownGotchas: [],
    status: "documented",
  },
  {
    moduleProfileId: "bmw_cas3",
    displayName: "BMW CAS3 / CAS3+ (Car Access System)",
    brand: "BMW",
    manufacturer: "BMW",
    category: "IMMO",
    ecuCode: "CAS3 / CAS3+",
    yearRange: [2004, 2013],
    applications: [
      "BMW E60/E61",
      "BMW E70/E71",
      "BMW E83 LCI",
      "BMW E90/E91/E92/E93",
    ],
    mcu: {
      family: "NEC V850 / Freescale 9S12",
      variants: ["D70F3239", "MC9S12XEP100"],
      accessMethods: ["obd_can", "bench_boot", "bdm"],
    },
    memories: [
      { role: "immo_eeprom", chipProfileId: "stmicroelectronics_m95320", accessMethod: "soic_clip", note: "Holds ISN + key info; mirrored partly in MCU internal flash." },
    ],
    immo: {
      storedIn: "internal_mcu",
      clonableByteExact: "sometimes",
      notes: "CAS holds the master immo pairing. CAS3+ uses MC9S12 with internal flash containing key codes — external EEPROM alone is NOT a complete clone.",
    },
    cloneAccessibility: "mixed",
    donorCompatibilityNote: "Match CAS hardware variant (CAS3 vs CAS3+) and software version. ISN must match the DME/DDE you're pairing with.",
    knownGotchas: [
      "CAS work is the riskiest part of any BMW recovery — lots of ways to lose all keys.",
      "Read CAS BEFORE doing anything else; archive multiple verified backups.",
    ],
    status: "documented",
  },

  // ----------------------------------------------------------- Mercedes ----
  {
    moduleProfileId: "mb_bosch_me97",
    displayName: "Bosch ME9.7 / ME9.7CDI (M272 / M273 V6/V8)",
    brand: "Mercedes",
    manufacturer: "Bosch",
    category: "ECU",
    ecuCode: "ME9.7",
    partNumberPattern: "A 272 153 xx 79 (and siblings)",
    yearRange: [2004, 2011],
    applications: [
      "Mercedes W211 E350 / E550",
      "Mercedes W221 S350 / S550",
      "Mercedes W204 C350",
      "Mercedes W164 ML350 / ML550",
    ],
    mcu: {
      family: "Freescale MPC55x / MPC56x",
      variants: ["MPC555", "MPC562"],
      accessMethods: ["soic_clip", "bench_boot", "bdm", "nexus"],
    },
    memories: [
      { role: "immo_eeprom",          chipProfileId: "stmicroelectronics_m95320", accessMethod: "soic_clip" },
      { role: "calibration_flash",    chipProfileId: "macronix_mx25l1606e",       accessMethod: "soic_clip" },
    ],
    immo: {
      storedIn: "paired_with_immo_box",
      clonableByteExact: "yes",
      notes: "ME9.7 pairs with EZS/SKReader (FBS3). External EEPROM clone usually sufficient when both donor and original are FBS3-era.",
    },
    cloneAccessibility: "external_only",
    donorCompatibilityNote: "Match part number exactly. Cross-engine (M272 vs M273) is NOT swappable.",
    knownGotchas: [
      "MB starter ban — after several failed start attempts FBS3 escalates; do recovery on bench, not in-vehicle.",
    ],
    status: "documented",
  },
  {
    moduleProfileId: "mb_siemens_sid208",
    displayName: "Siemens SID208 / SID807 (OM642 / OM651 CDI)",
    brand: "Mercedes",
    manufacturer: "Siemens Continental",
    category: "ECU",
    ecuCode: "SID208 / SID807",
    yearRange: [2005, 2015],
    applications: [
      "Mercedes W211 E320 CDI (OM642)",
      "Mercedes W204 C220/C320 CDI (OM651)",
      "Mercedes Sprinter OM642 CDI",
      "Jeep Grand Cherokee WK 3.0 CRD (OM642)",
    ],
    mcu: {
      family: "Freescale MPC56x",
      variants: ["MPC563", "MPC564"],
      accessMethods: ["bench_boot", "nexus", "soic_clip"],
    },
    memories: [
      { role: "immo_eeprom",        chipProfileId: "stmicroelectronics_m95128", accessMethod: "soic_clip", note: "Some SID208 variants instead use internal EEPROM only." },
      { role: "main_program_flash", chipProfileId: "macronix_mx25l3206e",       accessMethod: "soic_clip" },
    ],
    immo: {
      storedIn: "internal_mcu",
      clonableByteExact: "usually",
      notes: "SID stores most binding data internally. External clone alone is insufficient; need Nexus/BDM access in Phase F.",
    },
    cloneAccessibility: "internal_required",
    donorCompatibilityNote: "Hardware revision + software match. Cross-engine swaps not viable.",
    knownGotchas: [
      "OM642 SID208 boards have a known dry-joint failure on the small T-com chip — symptom: intermittent no-start.",
    ],
    status: "documented",
  },
  {
    moduleProfileId: "mb_ezs_skreader",
    displayName: "Mercedes EZS / EIS (Ignition Switch, FBS3)",
    brand: "Mercedes",
    manufacturer: "Mercedes-Benz",
    category: "IMMO",
    ecuCode: "EZS-FBS3",
    yearRange: [2002, 2014],
    applications: [
      "Mercedes W211/W219/W203/W204 (FBS3 era)",
      "Mercedes W164/W251/W221",
    ],
    mcu: {
      family: "NEC V850 / Motorola 9S12",
      variants: ["D70F3xxx", "MC9S12XHZ256"],
      accessMethods: ["obd_can", "bench_boot", "bdm"],
    },
    memories: [
      { role: "immo_eeprom", chipProfileId: "stmicroelectronics_m95320", accessMethod: "soic_clip" },
    ],
    immo: {
      storedIn: "internal_mcu",
      clonableByteExact: "no",
      notes: "EZS is the master of the immo system. Cloning EZS without re-personalising keys breaks the system. Out of scope for this app.",
    },
    cloneAccessibility: "internal_required",
    donorCompatibilityNote: "Don't clone EZS as a workaround for a burned ECU — clone the ECU instead.",
    knownGotchas: [
      "If your goal is 'burned ECU recovery', do NOT touch the EZS. Replace the ECU only.",
    ],
    status: "documented",
  },

  // --------------------------------------------------------------- GM -----
  {
    moduleProfileId: "gm_delphi_e38",
    displayName: "Delphi E38 PCM (LS2 / LS3 / LS7 gasoline)",
    brand: "GM",
    manufacturer: "Delphi",
    category: "ECU",
    ecuCode: "E38",
    yearRange: [2005, 2014],
    applications: [
      "Chevrolet Corvette C6 (LS2/LS3/LS7)",
      "Chevrolet Camaro Gen5 (LS3/L99)",
      "Cadillac CTS-V (LSA)",
      "GMC/Chevrolet trucks (L92/L94/L96)",
    ],
    mcu: {
      family: "Freescale MPC56x",
      accessMethods: ["obd_can", "bench_boot"],
    },
    memories: [
      { role: "calibration_flash", chipProfileId: "stmicroelectronics_m25p32", accessMethod: "soic_clip", note: "Off-chip cal storage in some revisions." },
    ],
    immo: {
      storedIn: "paired_with_immo_box",
      clonableByteExact: "usually",
      notes: "GM Vehicle Anti-Theft System (VATS) / Passlock — pairing with BCM/instrument cluster. Tuners commonly re-VIN E38 via HP Tuners / EFILive; for repair clone, byte-exact preserves pairing.",
    },
    cloneAccessibility: "external_plus_obd_clone",
    donorCompatibilityNote: "E38 hardware is one PCM; software image per application differs. Match application image after clone.",
    knownGotchas: [
      "HP Tuners / EFILive are the dominant tools — bench reads possible but credit licenses control writes.",
    ],
    status: "documented",
  },
  {
    moduleProfileId: "gm_ac_delco_e67",
    displayName: "AC Delco E67 ECM (turbo/DI ecotec)",
    brand: "GM",
    manufacturer: "AC Delco",
    category: "ECU",
    ecuCode: "E67",
    yearRange: [2007, 2014],
    applications: [
      "Buick Regal GS",
      "Pontiac Solstice GXP",
      "Chevrolet Cobalt SS Turbo",
      "Chevrolet HHR SS",
    ],
    mcu: {
      family: "Freescale MPC56x",
      accessMethods: ["obd_can", "bench_boot"],
    },
    memories: [],
    immo: {
      storedIn: "paired_with_immo_box",
      clonableByteExact: "usually",
      notes: "Like E38 — internal flash holds the calibration; pairing via VATS / Passlock.",
    },
    cloneAccessibility: "internal_required",
    donorCompatibilityNote: "Match P/N exactly.",
    knownGotchas: [],
    status: "placeholder",
  },

  // -------------------------------------------------------------- Ford ----
  {
    moduleProfileId: "ford_visteon_pcm_2006_2010",
    displayName: "Ford Visteon PCM (Spanish Oak / Black Oak / Fox)",
    brand: "Ford",
    manufacturer: "Visteon",
    category: "ECU",
    ecuCode: "Spanish Oak / Black Oak",
    yearRange: [2004, 2014],
    applications: [
      "Ford F-150 5.4 Triton",
      "Ford Mustang 4.6 / 5.0 Coyote",
      "Ford Edge 3.5 V6",
      "Ford Explorer 4.0",
    ],
    mcu: {
      family: "Freescale MPC55x / MPC56x",
      accessMethods: ["obd_can", "soic_clip"],
    },
    memories: [
      { role: "immo_eeprom",       chipProfileId: "stmicroelectronics_m95160", accessMethod: "soic_clip" },
      { role: "calibration_flash", chipProfileId: "macronix_mx25l1606e",       accessMethod: "soic_clip" },
    ],
    immo: {
      storedIn: "external_eeprom",
      clonableByteExact: "yes",
      notes: "Ford PATS data lives in PCM external EEPROM. Clone is well-known among independent shops.",
    },
    cloneAccessibility: "external_only",
    donorCompatibilityNote: "Match calibration ID (stamped on housing) AND hardware revision.",
    knownGotchas: [
      "Some Ford PCMs are paired to the Instrument Cluster; cluster pairing intact on clone.",
    ],
    status: "documented",
  },

  // -------------------------------------------------------- Stellantis ----
  {
    moduleProfileId: "stellantis_bosch_edc16cp",
    displayName: "Bosch EDC16CP (Chrysler/Dodge/Jeep 3.0 CRD CDI)",
    brand: "Stellantis",
    manufacturer: "Bosch",
    category: "ECU",
    ecuCode: "EDC16CP31 / EDC16CP35",
    yearRange: [2005, 2010],
    applications: [
      "Jeep Grand Cherokee WK 3.0 CRD (OM642 — pre-SID swap)",
      "Dodge Sprinter 3.0 CDI",
      "Chrysler 300C CRD",
    ],
    mcu: {
      family: "Freescale MPC56x",
      accessMethods: ["soic_clip", "bench_boot", "nexus"],
    },
    memories: [
      { role: "immo_eeprom",        chipProfileId: "stmicroelectronics_m95080", accessMethod: "soic_clip" },
      { role: "main_program_flash", chipProfileId: "macronix_mx25l1606e",       accessMethod: "soic_clip" },
    ],
    immo: {
      storedIn: "external_eeprom",
      clonableByteExact: "yes",
      notes: "Same Bosch architecture as MB equivalents — external EEPROM clone usually sufficient.",
    },
    cloneAccessibility: "external_only",
    donorCompatibilityNote: "Match calibration ID exactly.",
    knownGotchas: [],
    status: "documented",
  },

  // ------------------------------------------------------------ Toyota ----
  {
    moduleProfileId: "toyota_denso_xxxxx",
    displayName: "Denso ECM 89661-xxxxx (Toyota gasoline)",
    brand: "Toyota",
    manufacturer: "Denso",
    category: "ECU",
    ecuCode: "Denso 89661 family",
    yearRange: [2003, 2018],
    applications: [
      "Toyota Camry 2.4 / 3.5",
      "Toyota Corolla 1.8",
      "Toyota RAV4 2.5",
      "Lexus IS250 / IS350",
    ],
    mcu: {
      family: "Renesas SH7058 / SH7059",
      accessMethods: ["obd_can", "bench_boot", "jtag"],
    },
    memories: [
      { role: "immo_eeprom", chipProfileId: "stmicroelectronics_m95080", accessMethod: "soic_clip" },
    ],
    immo: {
      storedIn: "internal_mcu",
      clonableByteExact: "usually",
      notes: "Most Denso ECMs hold immo data internally in the SH7058. External 95080 is for adaptations only. Toyota smart-key cars are paired with the cluster + smart-key ECU.",
    },
    cloneAccessibility: "internal_required",
    donorCompatibilityNote: "Match Denso P/N (89661-xxxxx) exactly. Different engine + transmission combos use different P/Ns.",
    knownGotchas: [
      "Smart-key Toyotas need both Smart-Key ECU + Cluster + ECM in sync. Cloning ECM alone may not start the car.",
    ],
    status: "documented",
  },
];
