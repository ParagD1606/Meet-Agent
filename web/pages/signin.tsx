import { Brain } from "@/landing/scenes"
import { SlackMark } from "@/ui/connectors"

const REASONS: Record<string, string> = {
  not_allowed: "That Slack account isn't part of this workspace.",
  state: "The sign-in link expired. Try again.",
  denied: "Slack sign-in was cancelled.",
}

const S = {
  page: { minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: "32px 20px", background: "#ffffff", color: "#1c1c1e", fontFamily: '"Hanken Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', WebkitFontSmoothing: "antialiased", letterSpacing: "-0.01em" } as const,
  card: { width: "100%", maxWidth: 400, padding: "40px 36px", background: "#ffffff", border: "1px solid #e6e6e6", borderRadius: 0, boxShadow: "0 1px 2px rgba(0,0,0,0.04)" } as const,
  brand: { display: "flex", alignItems: "center", gap: 10, fontWeight: 500, fontSize: 15, letterSpacing: "-0.015em" } as const,
  brandMark: { width: 28, height: 28, background: "#1c1c1e", display: "grid", placeItems: "center" } as const,
  h1: { marginTop: 28, fontSize: 26, lineHeight: 1.15, letterSpacing: "-0.025em", fontWeight: 500 } as const,
  sub: { marginTop: 10, fontSize: 14, color: "rgba(0,0,0,0.55)", lineHeight: 1.5 } as const,
  err: { marginTop: 20, padding: "10px 12px", border: "1px solid #fecaca", background: "#fef2f2", color: "#991b1b", fontSize: 13.5, lineHeight: 1.4 } as const,
  btn: { marginTop: 24, display: "flex", width: "100%", height: 44, alignItems: "center", justifyContent: "center", gap: 10, background: "#1c1c1c", color: "#ffffff", fontSize: 14, fontWeight: 500, border: "1px solid #1c1c1c", borderRadius: 0, textDecoration: "none", transition: "background 0.18s ease" } as const,
  link: { marginTop: 20, display: "block", textAlign: "center", fontSize: 13, color: "rgba(0,0,0,0.55)", textDecoration: "underline", textUnderlineOffset: 3 } as const,
  foot: { marginTop: 28, textAlign: "center", fontSize: 11.5, color: "rgba(0,0,0,0.4)", letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: '"DM Mono", ui-monospace, monospace' } as const,
}

export function SignIn() {
  const err = new URLSearchParams(location.search).get("error")
  return (
    <main style={S.page}>
      <div style={S.card}>
        <div style={S.brand}><i style={S.brandMark}><Brain size={16} color="#fff" /></i>Company Brain</div>
        <h1 style={S.h1}>Sign in</h1>
        <p style={S.sub}>Use the Slack workspace this deployment belongs to.</p>
        {err && <p role="alert" style={S.err}>{REASONS[err] ?? "Sign-in failed. Try again."}</p>}
        <a href="/auth/slack" style={S.btn}><SlackMark size={16} />Continue with Slack</a>
        <a href="/setup" style={S.link}>Setting up a new deployment?</a>
        <p style={S.foot}>Self-hosted · Your data stays yours</p>
      </div>
    </main>
  )
}
