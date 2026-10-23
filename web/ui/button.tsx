import type { ButtonHTMLAttributes, ReactNode } from "react"
import { Icon, type IconName } from "@/lib/icons"
import { cn } from "./cn"

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "ghost" | "danger" | "danger-solid"
  size?: "md" | "sm"
  loading?: boolean
  icon?: IconName
  children?: ReactNode
}

export function Button({ variant = "default", size = "md", loading, icon, children, className, disabled, type = "button", ...rest }: ButtonProps) {
  const iconOnly = !children && icon
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn("btn", variant !== "default" && `btn-${variant}`, size === "sm" && "btn-sm", iconOnly && "btn-icon", className)}
      {...rest}
    >
      {loading ? <Icon name="loader" className="spin" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  )
}

export function LinkButton({ href, children, variant = "default", size = "md", icon, external, className }: { href: string; children: ReactNode; variant?: ButtonProps["variant"]; size?: "md" | "sm"; icon?: IconName; external?: boolean; className?: string }) {
  return (
    <a href={href} {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})} className={cn("btn", variant !== "default" && `btn-${variant}`, size === "sm" && "btn-sm", className)}>
      {icon && <Icon name={icon} />}
      {children}
    </a>
  )
}
