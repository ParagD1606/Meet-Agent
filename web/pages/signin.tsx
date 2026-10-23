import { LinkButton } from "@/lib/ui"

export function SignIn() {
  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 text-center">
        <span aria-hidden className="mx-auto mb-4 block size-10 rounded-xl bg-primary" />
        <h1 className="text-xl font-semibold">Company Brain</h1>
        <p className="mb-6 mt-2 text-sm text-muted">Your team's memory, connected to Slack. Sign in with your Slack account to continue.</p>
        <LinkButton href="/auth/slack" className="w-full">
          <img src="/slack-icon.png" alt="" className="size-4" /> Sign in with Slack
        </LinkButton>
      </div>
    </div>
  )
}
