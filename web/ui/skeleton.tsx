import { cn } from "./cn"
export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden className={cn("skeleton h-4", className)} />
export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("divide", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-3 py-3"><Skeleton className="h-3.5 w-1/4" /><Skeleton className="h-3.5 flex-1" /><Skeleton className="h-3.5 w-16" /></div>
      ))}
    </div>
  )
}
