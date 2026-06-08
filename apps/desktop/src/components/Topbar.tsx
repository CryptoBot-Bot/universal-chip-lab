import { ReactNode } from "react";

export interface TopbarProps {
  title: string;
  crumb?: string;
  actions?: ReactNode;
}

export function Topbar({ title, crumb, actions }: TopbarProps) {
  return (
    <header className="topbar">
      <span className="title">{title}</span>
      {crumb && <span className="crumb">/ {crumb}</span>}
      <span className="spacer" />
      {actions}
      <span className="legal-badge">Read-only by default</span>
    </header>
  );
}
