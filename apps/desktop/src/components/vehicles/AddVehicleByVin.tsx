import { useState } from "react";

import { bindVinIdentity, decodeVin, learnVin } from "@ecu/vehicle-db";
import type { OnlineVinDecode, VehicleProfile } from "@ecu/vehicle-db";

import { Api } from "../../lib/api";
import { manualProfile, ymmLabel } from "../../lib/diag";
import { VIcon } from "./icons";

/**
 * Add a vehicle by typing its VIN: the free NHTSA decoder names the year/make/model
 * (the same bindVinIdentity step Auto Diagnostic uses), and the VIN is filed under
 * that model in the library — an existing one, or a new one. The car itself is not
 * contacted. When NHTSA cannot name it, the operator names the model by hand.
 */

const HOW: Record<string, string> = {
  vin: "this exact car is already on file", pattern: "recognised by its VIN pattern",
  ymm: "matched by the NHTSA decode", new: "new model, filed from the NHTSA decode",
};

export function AddVehicleByVin({ profiles, onAdded, onClose }: {
  profiles: VehicleProfile[];
  onAdded: (list: VehicleProfile[], stored: VehicleProfile, message: string) => void;
  onClose: () => void;
}) {
  const [vin, setVin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState<{ vin: string; year: string; make: string; model: string } | null>(null);

  async function save(p: VehicleProfile, message: (stored: VehicleProfile) => string) {
    const list = await Api.vehicleLib.save(p);
    const stored = list.find((x) => x.id === p.id) ?? p;
    onAdded(list, stored, message(stored));
  }

  async function decode() {
    const d = decodeVin(vin);
    if (!d.valid) { setErr("That is not a valid 17-character VIN (the letters I, O and Q are never used)."); return; }
    setBusy(true); setErr(null); setManual(null);
    try {
      let online: OnlineVinDecode | null = null;
      try { online = await Api.vehicleExplorer.decodeOnline(d.vin); } catch { online = null; }
      const b = bindVinIdentity(profiles, d.vin, online, new Date().toISOString());
      if (!b.profile) {
        setManual({ vin: d.vin, year: d.year ? String(d.year) : "", make: d.make ?? "", model: "" });
        setErr(online
          ? `NHTSA could not name this VIN${online.errorText ? ` (${online.errorText})` : ""}. Name the model below and the VIN is filed under it.`
          : "The NHTSA decoder could not be reached. Name the model below and the VIN is filed under it.");
        return;
      }
      await save(b.profile, (s) => `VIN ${d.vin} → ${ymmLabel(s)} (${HOW[b.kind ?? "new"]}).`);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function fileManual() {
    if (!manual) return;
    const year = manual.year.trim() ? Number(manual.year) : null;
    const make = manual.make.trim(), model = manual.model.trim();
    if (!make || !model || (year !== null && !(year > 1980 && year < 2100))) { setErr("Enter the make and the model (and a 4-digit year, or leave the year empty)."); return; }
    setBusy(true); setErr(null);
    try {
      const now = new Date().toISOString();
      const existing = profiles.find((p) => p.year === year && p.make.toLowerCase() === make.toLowerCase() && p.model.toLowerCase() === model.toLowerCase());
      const { profile } = learnVin(existing ?? manualProfile(year, make, model, now), manual.vin, now);
      await save(profile, (s) => `VIN ${manual.vin} filed under ${ymmLabel(s)}${existing ? "" : " (new model, entered by hand)"}.`);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="ual-card pad vdb-addvin" aria-labelledby="vdb-addvin-title">
      <div className="vdb-addvin-head">
        <h2 id="vdb-addvin-title" className="ual-h2">Add a vehicle by VIN</h2>
        <button type="button" className="ghost tiny" onClick={onClose}><VIcon name="close" size={14} />Close</button>
      </div>
      <p className="ual-sub">Decoded with the free NHTSA service and filed under its year, make and model. Nothing is sent to a car.</p>
      <form className="vdb-addvin-row" onSubmit={(e) => { e.preventDefault(); void decode(); }}>
        <label className="vdb-field vdb-field-vin">
          <span>VIN</span>
          <input className="ual-mono" value={vin} maxLength={17} autoFocus spellCheck={false} autoComplete="off"
            placeholder="17 characters" onChange={(e) => setVin(e.target.value.toUpperCase().replace(/\s+/g, ""))} />
        </label>
        <button type="submit" className="primary" disabled={busy || vin.length !== 17}>{busy && !manual ? "Decoding…" : "Decode and add"}</button>
      </form>
      {manual && (
        <form className="vdb-addvin-row" onSubmit={(e) => { e.preventDefault(); void fileManual(); }}>
          <label className="vdb-field vdb-field-year"><span>Year</span>
            <input inputMode="numeric" maxLength={4} value={manual.year} onChange={(e) => setManual({ ...manual, year: e.target.value.replace(/\D/g, "") })} />
          </label>
          <label className="vdb-field"><span>Make</span>
            <input value={manual.make} onChange={(e) => setManual({ ...manual, make: e.target.value })} />
          </label>
          <label className="vdb-field"><span>Model</span>
            <input value={manual.model} onChange={(e) => setManual({ ...manual, model: e.target.value })} />
          </label>
          <button type="submit" className="primary" disabled={busy}>{busy ? "Filing…" : "File under this model"}</button>
        </form>
      )}
      {err && <div className={`ual-note ${manual ? "warn" : "err"}`} role="alert">{err}</div>}
    </section>
  );
}
