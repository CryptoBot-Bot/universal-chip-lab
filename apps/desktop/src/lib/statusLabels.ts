import type { JobStatus } from "@ecu/core";

export const STATUS_LABEL: Record<JobStatus, { label: string; tone: string }> = {
  not_started:           { label: "Not Started",           tone: "" },
  wiring_required:       { label: "Wiring Required",       tone: "info" },
  safety_check_required: { label: "Safety Check Required", tone: "warn" },
  ready_to_read:         { label: "Ready to Read",         tone: "info" },
  reading:               { label: "Reading…",              tone: "info" },
  read_complete:         { label: "Read Complete",         tone: "info" },
  verifying:             { label: "Verifying…",            tone: "info" },
  verified_backup:       { label: "Verified Backup",       tone: "ok" },
  warning:               { label: "Warning",               tone: "warn" },
  failed:                { label: "Failed",                tone: "danger" },
};
