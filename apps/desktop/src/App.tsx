import { useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { Api } from "./lib/api";
import { PicoProvider } from "./lib/pico-connection";
import { SuperDeviceProvider } from "./lib/superdevice-connection";
import { WorkbenchProvider } from "./lib/workbench";
import { AutoLabShell } from "./shell/AutoLabShell";
import { ChipDatabase } from "./routes/ChipDatabase";
import { CockpitTab } from "./routes/CockpitTab";
import { DevicesTab } from "./routes/DevicesTab";
import { DiagnosticsTab } from "./routes/DiagnosticsTab";
import { DumpsTab } from "./routes/DumpsTab";
import { BenchTab } from "./routes/BenchTab";
import { TrainingRoom } from "./routes/TrainingRoom";
import { VehicleDatabase } from "./routes/VehicleDatabase";
import { ReadTab } from "./routes/ReadTab";
import { SettingsTab } from "./routes/SettingsTab";
import { WriteTab } from "./routes/WriteTab";

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Api.workspace
      .init()
      .then(() => setReady(true))
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) {
    return (
      <div style={{ padding: 32 }}>
        <h1>Failed to initialise workspace</h1>
        <p style={{ color: "var(--danger)" }}>{error}</p>
      </div>
    );
  }
  if (!ready) {
    return (
      <div style={{ padding: 32 }}>
        <h1>Universal Auto Lab</h1>
        <p className="dim">Initialising workspace…</p>
      </div>
    );
  }

  return (
    <PicoProvider>
      <SuperDeviceProvider>
      <WorkbenchProvider>
        <Routes>
          {/* Universal Auto Lab — the three main tabs (light B1 shell) */}
          <Route element={<AutoLabShell />}>
            <Route path="/diag" element={<DiagnosticsTab />} />
            <Route path="/vehicles" element={<VehicleDatabase />} />
            <Route path="/devices" element={<DevicesTab />} />
            <Route path="/settings" element={<SettingsTab />} />
          </Route>
          {/* Archive — earlier tools in their own (dark) layout, reached from the footer */}
          <Route element={<Layout><Outlet /></Layout>}>
            <Route path="/read" element={<ReadTab />} />
            <Route path="/write" element={<WriteTab />} />
            <Route path="/chips" element={<ChipDatabase />} />
            <Route path="/dumps" element={<DumpsTab />} />
            <Route path="/bench" element={<BenchTab />} />
            <Route path="/obd" element={<Navigate to="/bench" replace />} />
            <Route path="/cockpit" element={<CockpitTab />} />
            <Route path="/training" element={<TrainingRoom />} />
          </Route>
          <Route path="*" element={<Navigate to="/diag" replace />} />
        </Routes>
      </WorkbenchProvider>
      </SuperDeviceProvider>
    </PicoProvider>
  );
}
