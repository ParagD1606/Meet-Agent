import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react"
import { cn } from "./cn"

/** Wraps a control with label, hint and an inline error (server `issues` or client validation). */
export function FormField({ label, hint, error, children, className, htmlFor, optional }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: (p: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode; className?: string; htmlFor?: string; optional?: boolean }) {
  const id = useId()
  const cid = htmlFor ?? id
  const did = `${cid}-d`
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={cid} className="text-sm font-medium">
        {label}
        {optional && <span className="ml-1 font-normal text-subtle">Optional</span>}
      </label>
      {children({ id: cid, "aria-invalid": error ? true : undefined, "aria-describedby": error || hint ? did : undefined })}
      {error ? <p id={did} role="alert" className="text-xs text-danger">{error}</p> : hint ? <p id={did} className="text-xs text-muted">{hint}</p> : null}
    </div>
  )
}

export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input className={cn("input", className)} {...p} />
export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={cn("select", className)} {...p}>{children}</select>
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className={cn("textarea", className)} {...p} />

export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return <button id={id} type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="switch hit" onClick={() => onChange(!checked)} />
}

export function Checkbox({ checked, indeterminate, onChange, label, disabled }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <input type="checkbox" className="check hit" aria-label={label} disabled={disabled} checked={checked} ref={(el) => { if (el) el.indeterminate = !!indeterminate }} onChange={(e) => onChange(e.target.checked)} />
  )
}

/** Label + description on the left, control on the right. */
export function SettingRow({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0"><div className="text-sm font-medium">{title}</div>{desc && <div className="mt-0.5 text-xs text-muted">{desc}</div>}</div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
