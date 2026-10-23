import { useId, useRef, type ReactNode } from "react"
import { Icon, type IconName } from "@/lib/icons"

/** Native popover menu: light-dismiss + Esc from the platform, arrow-key roving from us. */
export function Menu({ trigger, children, align = "start", up }: { trigger: (p: { onClick: () => void; "aria-haspopup": "menu"; "aria-controls": string; ref: React.Ref<HTMLButtonElement> }) => ReactNode; children: (close: () => void) => ReactNode; align?: "start" | "end"; up?: boolean }) {
  const id = useId()
  const pop = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const close = () => pop.current?.hidePopover()
  const place = () => {
    const p = pop.current, b = btn.current
    if (!p || !b) return
    const r = b.getBoundingClientRect()
    p.style.minWidth = `${Math.max(r.width, 180)}px`
    const pw = p.offsetWidth, ph = p.offsetHeight
    let left = align === "end" ? r.right - pw : r.left
    left = Math.max(8, Math.min(left, innerWidth - pw - 8))
    let top = up ? r.top - ph - 4 : r.bottom + 4
    if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 4)
    p.style.left = `${left}px`; p.style.top = `${top}px`
  }
  const open = () => {
    const p = pop.current!
    p.showPopover()
    place()
    p.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }
  const onKey = (e: React.KeyboardEvent) => {
    const items = [...pop.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus() }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus() }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus() }
    else if (e.key === "End") { e.preventDefault(); items.at(-1)?.focus() }
  }
  return (
    <>
      {trigger({ onClick: open, "aria-haspopup": "menu", "aria-controls": id, ref: btn })}
      <div ref={pop} id={id} popover="auto" role="menu" className="menu" style={{ zIndex: "var(--z-popover)" }} onKeyDown={onKey} onClick={(e) => { if ((e.target as HTMLElement).closest('[role="menuitem"]')) close() }}>
        {children(close)}
      </div>
    </>
  )
}

export function MenuItem({ icon, children, onSelect, danger, href, trailing, checked }: { icon?: IconName; children: ReactNode; onSelect?: () => void; danger?: boolean; href?: string; trailing?: ReactNode; checked?: boolean }) {
  const inner = <>{icon && <Icon name={icon} className="text-muted" />}<span className="flex-1 truncate">{children}</span>{trailing}{checked && <Icon name="check" className="text-accent" />}</>
  if (href) return <a role="menuitem" href={href} className="menu-item" data-danger={danger || undefined}>{inner}</a>
  return <button role="menuitem" type="button" className="menu-item" data-danger={danger || undefined} onClick={onSelect}>{inner}</button>
}
export const MenuSep = () => <div className="menu-sep" role="separator" />
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-label">{children}</div>
