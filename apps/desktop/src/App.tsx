import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { Api } from "./lib/api";
import { PicoProvider } from "./lib/pico-connection";
import { ChipDatabase } from "./routes/ChipDatabase";
import { CockpitTab } from "./routes/CockpitTab";
import { DumpsTab } from "./routes/DumpsTab";
import { ObdTab } from "./routes/ObdTab";
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
        <h1>PicoForge · Universal Chip Lab</h1>
        <p className="dim">Initialising workspace…</p>
      </div>
    );
  }

  return (
    <PicoProvider>
      <Layout>
        <Routes>
          <Route path="/read" element={<ReadTab />} />
          <Route path="/write" element={<WriteTab />} />
          <Route path="/chips" element={<ChipDatabase />} />
          <Route path="/dumps" element={<DumpsTab />} />
          <Route path="/obd" element={<ObdTab />} />
          <Route path="/cockpit" element={<CockpitTab />} />
          <Route path="/vehicles" element={<VehicleDatabase />} />
          <Route path="/training" element={<TrainingRoom />} />
          <Route path="/settings" element={<SettingsTab />} />
          <Route path="*" element={<Navigate to="/read" />} />
        </Routes>
      </Layout>
    </PicoProvider>
  );
}
