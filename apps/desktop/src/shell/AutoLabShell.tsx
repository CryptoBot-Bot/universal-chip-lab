import { useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { UpdateCenter } from "../components/UpdateCenter";
import { Api, type UpdateState } from "../lib/api";
import { ConnectionPill } from "./ConnectionPill";
import "./theme.css";

/** The three things the app is for. Everything else lives in the Archive. */
const TABS = [
  {
    to: "/diag", label: "Auto Diagnostic",
    icon: <><path d="M4 16a8 8 0 1 1 16 0" /><path d="M12 16l4-5" /><path d="M3 20h18" /></>,
  },
  {
    to: "/vehicles", label: "Vehicles Database",
    icon: <><path d="M3 15l2-6h14l2 6v3H3z" /><circle cx="7.5" cy="18" r="1.5" /><circle cx="16.5" cy="18" r="1.5" /></>,
  },
  {
    to: "/devices", label: "Pi Devices",
    icon: <><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3" /></>,
  },
];

/** Earlier work, kept working but out of the way. Each opens in its own (dark) layout. */
export const ARCHIVE = [
  { to: "/read", label: "Chip read" },
  { to: "/write", label: "Chip write" },
  { to: "/chips", label: "Chip database" },
  { to: "/dumps", label: "Dumps" },
  { to: "/bench", label: "Bench modules" },
  { to: "/cockpit", label: "3D cockpit" },
  { to: "/training", label: "AI training room" },
];

export function AppMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#1D4ED8" />
      <path d="M9 12h14l-2 9H11z" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="13" cy="16" r="1.3" fill="#FFFFFF" /><circle cx="16" cy="16" r="1.3" fill="#FFFFFF" /><circle cx="19" cy="16" r="1.3" fill="#FFFFFF" />
    </svg>
  );
}

export function AutoLabShell() {
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [updates, setUpdates] = useState(false);

  useEffect(() => {
    Api.updates.getState().then((s) => { setVersion(s.version); setUpdate(s.last); }).catch(() => undefined);
    return Api.updates.onState((s) => setUpdate(s));
  }, []);

  return (
    <div className="ual">
      <header className="ual-header">
        <Link to="/diag" className="ual-brand" aria-label="Universal Auto Lab — home">
          <AppMark /><b>Universal Auto Lab</b>
        </Link>
        <nav className="ual-nav" aria-label="Main">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} className={({ isActive }) => (isActive ? "active" : "")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{t.icon}</svg>
              {t.label}
            </NavLink>
          ))}
        </nav>
        <ConnectionPill />
      </header>

      <main className="ual-main">
        <Outlet />
      </main>

      <footer className="ual-footer">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10h14V9M10 13h4" /></svg>
        <b>Archive</b>
        {ARCHIVE.map((a) => <Link key={a.to} to={a.to}>{a.label}</Link>)}
        <span className="spacer" />
        <Link to="/settings">Settings</Link>
        {update?.state === "ready" ? (
          <button type="button" className="tiny primary" onClick={() => Api.updates.install()}>Install v{update.version} &amp; restart</button>
        ) : (
          <button type="button" className="tiny ghost" onClick={() => setUpdates(true)}>
            {update?.state === "downloading" ? `Downloading ${update.percent ?? 0}%…` : `v${version || "?"} · updates`}
          </button>
        )}
      </footer>
      {updates && <UpdateCenter onClose={() => setUpdates(false)} />}
    </div>
  );
}
