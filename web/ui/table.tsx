import { useMemo, useState, type ReactNode } from "react"
import { Icon } from "@/lib/icons"
import { cn } from "./cn"

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** Provide to make the header sortable. */
  sort?: (row: T) => string | number | null | undefined
  num?: boolean
  primary?: boolean   // first line of the mobile card
  end?: boolean       // top-right of the mobile card
  hideSm?: boolean
  width?: string
  label?: string      // label shown on mobile cards
}

export function Table<T>({ rows, columns, rowKey, onRowClick, selectedKey, caption, initialSort }: { rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string | number; onRowClick?: (r: T) => void; selectedKey?: string | number | null; caption: string; initialSort?: { key: string; dir: 1 | -1 } }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(initialSort ?? null)
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort?.key)
    if (!col?.sort || !sort) return rows
    const f = col.sort
    return [...rows].sort((a, b) => {
      const x = f(a), y = f(b)
      if (x == null) return 1
      if (y == null) return -1
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
    })
  }, [rows, columns, sort])
  return (
    <table className="tbl">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => {
            const on = sort?.key === c.key
            return (
              <th key={c.key} scope="col" className={cn(c.num && "num")} style={{ width: c.width }} aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : c.sort ? "none" : undefined}>
                {c.sort ? (
                  <button type="button" onClick={() => setSort(on ? (sort!.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 })}>
                    {c.header}
                    <Icon name={on && sort!.dir === -1 ? "sortDown" : "sortUp"} size={12} className={on ? "text-fg" : "text-transparent"} />
                  </button>
                ) : c.header}
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => {
          const k = rowKey(r)
          return (
            <tr key={k} data-click={onRowClick ? "" : undefined} aria-selected={selectedKey != null ? selectedKey === k : undefined}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === "Enter" && e.target === e.currentTarget) onRowClick(r) } : undefined}>
              {columns.map((c) => (
                <td key={c.key} className={cn(c.num && "num")} data-label={c.label ?? (typeof c.header === "string" ? c.header : undefined)} data-primary={c.primary ? "" : undefined} data-end={c.end ? "" : undefined} data-hide-sm={c.hideSm ? "" : undefined}>{c.cell(r)}</td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
