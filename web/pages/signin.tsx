import { Logo } from "@/lib/icons"
import { SlackMark } from "@/ui/connectors"

const REASONS: Record<string, string> = {
  not_allowed: "That Slack account isn't part of this workspace.",
  state: "The sign-in link expired. Try again.",
  denied: "Slack sign-in was cancelled.",
}

export function SignIn() {
  const err = new URLSearchParams(location.search).get("error")
  return (
    <>
      <div className="auth-bg" aria-hidden />
      <main className="relative flex min-h-dvh items-center justify-center px-4" style={{ colorScheme: "dark", color: "oklch(0.95 0.004 255)" }}>
        <div className="auth-card w-full max-w-[360px] p-6">
          <Logo size={28} />
          <h1 className="mt-4 text-xl">Sign in to Company Brain</h1>
          <p className="mt-1.5 text-sm" style={{ color: "oklch(0.74 0.01 255)" }}>Use the Slack workspace this deployment belongs to.</p>
          {err && <p role="alert" className="mt-4 rounded-md px-3 py-2 text-sm" style={{ background: "oklch(0.28 0.06 25)", color: "oklch(0.85 0.1 25)" }}>{REASONS[err] ?? "Sign-in failed. Try again."}</p>}
          <a href="/auth/slack" className="mt-6 flex h-10 w-full items-center justify-center gap-2 rounded-[10px] text-sm font-medium transition-colors" style={{ background: "oklch(0.98 0 0)", color: "oklch(0.18 0.01 255)" }}>
            <SlackMark size={16} />Continue with Slack
          </a>
          <a href="/setup" className="mt-5 block text-center text-xs underline-offset-2 hover:underline" style={{ color: "oklch(0.7 0.01 255)" }}>Setting up a new deployment?</a>
        </div>
      </main>
    </>
  )
}
