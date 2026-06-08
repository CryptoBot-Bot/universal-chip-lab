import type { ModuleJobStatus } from "@ecu/core";

export const MODULE_JOB_STATUS_LABEL: Record<ModuleJobStatus, { label: string; tone: string }> = {
  draft:              { label: "Draft",                tone: "" },
  source_reading:     { label: "Source reading…",      tone: "info" },
  source_verified:    { label: "Source verified",      tone: "ok" },
  donor_pre_read:     { label: "Donor pre-reading…",   tone: "info" },
  donor_pre_verified: { label: "Donor archive saved",  tone: "ok" },
  ready_to_write:     { label: "Ready to write",       tone: "warn" },
  donor_writing:     { label: "Writing donor…",        tone: "warn" },
  donor_post_read:   { label: "Post-write reading…",   tone: "info" },
  clone_verified:    { label: "Clone verified",        tone: "ok" },
  warning:           { label: "Warning",               tone: "warn" },
  failed:            { label: "Failed",                tone: "danger" },
};
