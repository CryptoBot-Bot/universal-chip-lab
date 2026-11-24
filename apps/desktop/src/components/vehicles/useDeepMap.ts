import { useEffect, useRef, useState } from "react";

import type { VehicleModule, VehicleProfile } from "@ecu/vehicle-db";

import { Api, type VehicleExplorerEvent, type VehicleExplorerTarget } from "../../lib/api";
import { addressedSystems, ymmLabel } from "../../lib/diag";
import { guardOf, plural, splitLabel } from "./vehicleFacts";

/**
 * The "Dig deeper" runner: the same AI vehicle explorer the Auto Diagnostic page's
 * "Learn all systems" uses (Api.vehicleExplorer.start → deepMapAndSave in the main
 * process, which saves the profile after every module). Read-only by design: the
 * explorer only sends read requests, and airbag / immobiliser systems are filtered
 * out here as well as in the main process.
 */

export interface DeepMapState {
  running: boolean;
  phase: string;
  prog: { done: number; total: number } | null;
  feed: string[];
  err: string | null;
  note: string | null;
  activeId: string | null;
  /** Profile id the current/last run belongs to. */
  profileId: string | null;
}

const IDLE: DeepMapState = { running: false, phase: "", prog: null, feed: [], err: null, note: null, activeId: null, profileId: null };

interface Opts {
  host: string;
  iface: string;
  online: boolean;
  /** The run finished: take over the profile the main process saved. */
  onProfile: (p: VehicleProfile) => void;
  /** A module was saved mid-run: re-read the library so the map fills in live. */
  onModuleSaved: () => void;
}

export function useDeepMap(opts: Opts) {
  const [st, setSt] = useState<DeepMapState>(IDLE);
  const o = useRef(opts); o.current = opts;
  const mounted = useRef(true);
  const offRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; offRef.current?.(); offRef.current = null; };
  }, []);

  const set = (patch: Partial<DeepMapState> | ((s: DeepMapState) => Partial<DeepMapState>)) => {
    if (!mounted.current) return;
    setSt((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));
  };
  const push = (line: string) => set((s) => ({ feed: [...s.feed, line].slice(-40) }));

  function targetFor(profile: VehicleProfile, m: VehicleModule): VehicleExplorerTarget {
    return {
      moduleId: m.id, displayName: m.label, brand: profile.make, category: m.category,
      protocol: profile.buses.find((b) => b.id === m.bus)?.protocol === "K-Line" ? "kwp2000" : "uds",
      requestId: m.addressing?.request ?? "", responseId: m.addressing?.response ?? "",
    };
  }

  /** Map these systems of this profile. Protected and address-less systems are dropped. */
  async function start(profile: VehicleProfile, modules: VehicleModule[]) {
    if (st.running) return;
    const { host, iface, online } = o.current;
    const allowed = modules.filter((m) => !guardOf(m) && m.addressing?.request && m.addressing?.response);
    if (!online) { set({ ...IDLE, profileId: profile.id, err: "No device connected — connect one from the pill at the top right, then start again." }); return; }
    if (!allowed.length) { set({ ...IDLE, profileId: profile.id, err: "Nothing to map: every system picked is protected (airbag / immobiliser) or has no diagnostic address yet." }); return; }

    set({ ...IDLE, running: true, profileId: profile.id, phase: "Starting the agent…", prog: { done: 0, total: allowed.length } });
    const names = new Map(allowed.map((m) => [m.id, splitLabel(m.label).short]));
    const off = Api.vehicleExplorer.onEvent((e: VehicleExplorerEvent) => {
      if (e.type === "module-start") {
        set({ activeId: e.moduleId, phase: `Learning ${e.index + 1} of ${e.total}: ${names.get(e.moduleId) ?? e.displayName}`, prog: { done: e.index, total: e.total } });
        push(`Mapping ${e.displayName}…`);
      } else if (e.type === "module-event") {
        const ev = e.event;
        if (ev.type === "thought" && ev.text) push(`  ${ev.text.slice(0, 140)}`);
        else if (ev.type === "action") {
          const purpose = ev.tool === "probe" ? (ev.input as { purpose?: string } | null)?.purpose : undefined;
          push(`  ${ev.tool}${purpose ? `: ${purpose}` : ""}`);
        } else if (ev.type === "finding") push(`  found ${ev.kind}: ${ev.title}`);
      } else if (e.type === "module-done") {
        const n = (e.result.operations ?? []).filter((x) => x.status === "supported").length;
        push(`Saved ${names.get(e.moduleId) ?? e.moduleId} — ${plural(n, "capability", "capabilities")} confirmed.`);
        o.current.onModuleSaved();
      } else if (e.type === "status") {
        set({ phase: e.text });
      } else if (e.type === "error") {
        push(`Problem: ${e.text}`);
        set({ err: e.text });
      }
    });
    offRef.current = off;
    try {
      const updated = await Api.vehicleExplorer.start({ host, iface, profile, targets: allowed.map((m) => targetFor(profile, m)) });
      if (mounted.current) {
        o.current.onProfile(updated);
        const sys = addressedSystems(updated);
        set({ note: `Done — ${sys.filter((m) => m.explored).length} of ${plural(sys.length, "system")} of ${ymmLabel(updated)} learned so far. Saved to the library.` });
      }
    } catch (e) {
      set({ err: (e as Error).message });
    } finally {
      off(); offRef.current = null;
      set({ running: false, phase: "", prog: null, activeId: null });
    }
  }

  function stop() {
    void Api.vehicleExplorer.stop().catch(() => undefined);
    set({ phase: "Stopping after the current step…" });
  }

  const dismiss = () => set({ err: null, note: null });

  return { ...st, start, stop, dismiss };
}

export type DeepMap = ReturnType<typeof useDeepMap>;
