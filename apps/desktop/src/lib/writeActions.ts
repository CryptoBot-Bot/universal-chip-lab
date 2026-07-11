/**
 * Write-action explanations — turns any write/actuator/security/calibration action
 * into a clear, detailed "here's exactly what will happen" briefing for the
 * confirmation dialog. Every write is gated behind this: no silent writes, ever.
 *
 * In the cockpit these execute against the SIMULATOR (harmless). On real hardware
 * the same briefing applies AND the write still routes through the Cloning Ceremony
 * (archive donor → verify → rollback). This layer strengthens the gate; it never
 * replaces it.
 */

export type WriteSeverity = "moderate" | "high" | "critical";

export interface PendingWrite {
  moduleLabel: string;
  label: string;
  request: string;
  kind: string;   // ActionKind or inferred capability kind
  risk: string;   // "write" | "caution" | "read"
  note?: string;
}

export interface WriteExplain {
  severity: WriteSeverity;
  summary: string;
  whatHappens: string[];
  risks: string[];
  preconditions: string[];
  confirmPhrase?: string;   // if set, the user must type it exactly
  touchesMemory?: boolean;  // true = memory clone/reflash path (Ceremony applies)
}

const isAirbagDeploy = (p: PendingWrite) =>
  /squib|deploy/i.test(`${p.label} ${p.note ?? ""}`);

export function explainWrite(p: PendingWrite): WriteExplain {
  if (isAirbagDeploy(p)) {
    return {
      severity: "critical",
      confirmPhrase: "DEPLOY",
      summary: "Fire the pyrotechnic squib — physically deploy the airbag / pretensioner.",
      whatHappens: [
        "Commands the SRS deployment loop to fire the pyrotechnic charge.",
        "The airbag or seatbelt pretensioner physically DEPLOYS.",
        "This is destructive and one-time — the component is consumed.",
      ],
      risks: [
        "EXPLOSIVE deployment — serious injury risk to anyone near the vehicle.",
        "There is NO legitimate diagnostic reason to do this on a working car.",
        "Triggering a live airbag outside authorized disposal is illegal in most places.",
      ],
      preconditions: [
        "NEVER on an installed or occupied vehicle.",
        "Authorized component-disposal context only.",
      ],
    };
  }

  switch (p.kind) {
    case "clear":
      return {
        severity: "moderate",
        summary: "Erase this module's stored fault codes and freeze-frame data.",
        whatHappens: [
          `Sends ClearDiagnosticInformation (${p.request}).`,
          "All stored and pending DTCs are deleted from module memory.",
          "Freeze-frame snapshots tied to those codes are removed.",
          "OBD readiness monitors reset to 'not ready'.",
        ],
        risks: [
          "Diagnostic history is lost — if the fault remains, codes return.",
          "The vehicle may fail an emissions test until a full drive cycle re-runs the monitors.",
          "Warning lights clear only until the fault is re-detected.",
        ],
        preconditions: [
          "Ignition ON, engine off (recommended).",
          "Record any codes you need BEFORE clearing.",
        ],
      };
    case "adaptation":
      return {
        severity: "high",
        summary: "Reset the module's learned adaptation values to factory defaults.",
        whatHappens: [
          `Runs a RoutineControl reset (${p.request}).`,
          "Learned fuel-trim / idle / shift adaptations return to base values.",
          "The module begins relearning from scratch.",
        ],
        risks: [
          "Rough idle, hesitation, or firm/soft shifts until relearn completes.",
          "A specific OEM relearn drive cycle may be required.",
          "Only do this to resolve a real driveability concern.",
        ],
        preconditions: [
          "Engine at operating temperature.",
          "Be ready to perform the relearn procedure afterward.",
        ],
      };
    case "actuator":
      return {
        severity: "high",
        summary: "Command a physical component to activate for testing.",
        whatHappens: [
          `Sends an actuator / RoutineControl command (${p.request}).`,
          "The targeted component physically moves or energizes (solenoid, motor, relay, pump…).",
          "The module reports the actuator response.",
        ],
        risks: [
          "Moving parts activate — keep hands and tools clear.",
          "Wrong preconditions can damage parts (injector test with engine off, ABS pump run dry…).",
          "Repeated cycling wears the component.",
        ],
        preconditions: [
          "Meet the test's stated conditions (engine running / wheels raised / area clear).",
          "Bystanders clear of the vehicle.",
        ],
      };
    case "security":
      return {
        severity: "high",
        summary: "Unlock the module's protected services via SecurityAccess.",
        whatHappens: [
          `Requests a seed and returns a computed key (${p.request}).`,
          "On success the module unlocks write/programming services for this session.",
          "No anti-theft or immobiliser function is bypassed.",
        ],
        risks: [
          "Enables subsequent WRITE operations — proceed only if you intend to.",
          "Wrong keys increment an attempt counter and can lock you out with a delay.",
          "The unlock is session-scoped and lost on reset.",
        ],
        preconditions: [
          "Correct seed/key algorithm for this module.",
          "Stable power — never on a sagging supply.",
        ],
      };
    case "calibration":
      return {
        severity: "high",
        summary: "Write new calibration reference values to a safety system.",
        whatHappens: [
          `Runs a calibration routine (${p.request}).`,
          "New references (steering-angle zero, yaw/G bias, radar/camera aim) are stored.",
          "The safety system adopts the new baseline immediately.",
        ],
        risks: [
          "Incorrect calibration degrades ADAS / stability control — a genuine safety risk.",
          "Must be done with proper targets on a level surface.",
          "Miscalibration may only reveal itself in an emergency.",
        ],
        preconditions: [
          "Vehicle level, correct alignment targets in place.",
          "Follow the OEM calibration procedure exactly.",
        ],
      };
    case "coding":
      return {
        severity: "high",
        summary: "Write a new configuration / coding value to the module.",
        whatHappens: [
          `Sends WriteDataByIdentifier (${p.request}).`,
          "The coding value is stored in the module's configuration block (EEPROM).",
          "The behaviour changes immediately and persists across restarts.",
        ],
        risks: [
          "A wrong value can disable a feature or set a warning light.",
          "Some values (VIN, odometer) are legally protected — only change your own, lawfully.",
          "Note the original value before changing it so you can revert.",
        ],
        preconditions: [
          "Extended session + (often) security access.",
          "Record the current value first.",
        ],
      };
    case "dump":
      return {
        severity: "moderate",
        summary: "Read the module's memory out over the OBD bus (no changes made).",
        whatHappens: [
          `Reads memory via UDS (${p.request}) — RequestUpload / ReadMemoryByAddress.`,
          "The image streams to the Raspberry Pi and is saved as a .bin.",
          "This is a READ — nothing in the module is modified.",
        ],
        risks: [
          "Large reads take time; keep power stable throughout.",
          "The image is the clone source — archive and checksum it (Cloning Ceremony).",
        ],
        preconditions: [
          "Extended session + security access for protected regions.",
          "Stable supply for the whole transfer.",
        ],
      };
    default: // generic write / reflash — the clone path
      return {
        severity: "critical",
        confirmPhrase: "PROCEED",
        touchesMemory: true,
        summary: "Write data into the module's non-volatile memory.",
        whatHappens: [
          `Sends WriteDataByIdentifier / TransferData (${p.request}).`,
          "New bytes are programmed into the ECU's EEPROM/flash.",
          "This is the core clone / reflash path.",
        ],
        risks: [
          "A bad or interrupted write can BRICK the module.",
          "Requires a verified donor archive and a working rollback first.",
          "Never on unstable power.",
        ],
        preconditions: [
          "Donor image archived + checksummed (Cloning Ceremony).",
          "Stable supply, correct session, security unlocked.",
        ],
      };
  }
}
