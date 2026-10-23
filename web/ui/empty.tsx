import type { ReactNode } from "react"
import { Icon, type IconName } from "@/lib/icons"
export function EmptyState({ icon = "inbox", title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-3 flex size-9 items-center justify-center rounded-lg border border-line bg-sunken text-muted"><Icon name={icon} size={18} /></div>
      <h3 className="text-base">{title}</h3>
      {children && <p className="mt-1 max-w-sm text-sm text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
