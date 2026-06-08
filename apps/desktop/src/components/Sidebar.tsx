import { NavLink } from "react-router-dom";

import { usePico } from "../lib/pico-connection";
import { UpdateWidget } from "./UpdateWidget";

const ITEMS: { to: string; label: string; icon: string }[] = [
  { to: "/read",  label: "Read",          icon: "▼" },
  { to: "/write", label: "Write",         icon: "▲" },
  { to: "/chips", label: "Chip Database", icon: "◇" },
  { to: "/dumps", label: "Dumps",         icon: "▤" },
];

const DOT: Record<string, string> = {
  connected: "var(--accent)",
  connecting: "var(--warn)",
  error: "var(--danger)",
  idle: "var(--border)",
};

export function Sidebar() {
  const { port, status, error, connect, disconnect } = usePico();

  const label =
    status === "connected" ? `PicoForge · ${port}`
    : status === "connecting" ? "Connecting…"
    : status === "error" ? "Connection failed"
    : "Not connected";

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        PicoForge
        <small>Universal Chip Lab</small>
      </div>
      <nav>
        {ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="tiny" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: DOT[status], display: "inline-block" }} />
          {label}
        </div>
        {status === "connected" ? (
          <button className="tiny" style={{ marginTop: 6 }} onClick={disconnect}>Disconnect</button>
        ) : (
          <button className="tiny primary" style={{ marginTop: 6 }} onClick={() => connect()} disabled={status === "connecting"}>
            Connect device
          </button>
        )}
        {status === "error" && error && (
          <div className="tiny" style={{ color: "var(--danger)", marginTop: 6 }}>{error}</div>
        )}
        <div className="tiny dim" style={{ marginTop: 10 }}>Lawful repair only · 3.3 V safe</div>
        <UpdateWidget />
      </div>
    </aside>
  );
}
