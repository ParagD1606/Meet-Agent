import type { ReactNode } from "react"
import { cn } from "./cn"
export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger"
export function Badge({ tone = "neutral", dot, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return <span className={cn("badge", tone !== "neutral" && `badge-${tone}`, className)}>{dot && <span className="dot" />}{children}</span>
}
