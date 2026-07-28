import type { ReactNode } from "react";

const statusSymbols = {
  danger: "×",
  information: "i",
  neutral: "—",
  success: "✓",
  warning: "!",
} as const;

export type StatusTone = keyof typeof statusSymbols;

export function StatusBadge({
  children,
  tone = "neutral",
}: Readonly<{ children: ReactNode; tone?: StatusTone }>) {
  return (
    <span className={`status-badge status-badge--${tone}`}>
      <span aria-hidden="true" className="status-badge__symbol">
        {statusSymbols[tone]}
      </span>
      <span>{children}</span>
    </span>
  );
}
