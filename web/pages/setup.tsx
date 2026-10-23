import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Async, Badge, Button, Card, LinkButton, PageTitle, useToast } from "@/lib/ui"

const row = (ok: boolean, label: string, fix: string) => (
  <li key={label} className="flex items-start justify-between gap-3 py-3">
    <div><p className="font-medium">{label}</p>{!ok && <p className="text-sm text-muted">{fix}</p>}</div>
    <Badge tone={ok ? "ok" : "warn"}>{ok ? "Configured" : "Missing"}</Badge>
  </li>
)

export function Setup({ signedIn }: { signedIn: boolean }) {
  const status = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus })
  const manifest = useQuery({ queryKey: ["setup-manifest"], queryFn: api.setupManifest })
  const toast = useToast()
  return (
    <div className={signedIn ? "" : "mx-auto max-w-2xl p-6"}>
      <PageTitle title="Set up Company Brain" sub="Three things need to be configured on the server. Set the environment variables, restart, then reload this page." />
      <Card className="mb-6">
        <Async q={status}>
          {(s) => (
            <>
              <ol className="divide-y divide-line">
                {row(s.model, "1. Language model", "Set MODEL_API_KEY (and MODEL_BASE_URL + MODEL_NAME for OpenAI-compatible providers).")}
                {row(s.embedding, "2. Embeddings", "Set EMBEDDING_API_KEY / EMBEDDING_MODEL so memories can be searched.")}
                {row(s.slack, "3. Slack app", "Create the Slack app from the manifest below, then set its tokens and install it to your workspace.")}
              </ol>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={() => status.refetch()}>Re-check</Button>
                {s.slack && !signedIn && <LinkButton href="/auth/slack">Sign in with Slack</LinkButton>}
                {s.slack && <LinkButton href="/slack/install">Install to Slack</LinkButton>}
              </div>
            </>
          )}
        </Async>
      </Card>
      <h2 className="mb-2 font-semibold">Slack app manifest</h2>
      <p className="mb-2 text-sm text-muted">In Slack, open api.slack.com/apps, choose "Create New App", "From a manifest", and paste this YAML.</p>
      <Async q={manifest}>
        {(yaml) => (
          <div className="relative">
            <pre tabIndex={0} className="max-h-96 overflow-auto rounded-xl border border-line bg-surface p-4 text-xs">{yaml}</pre>
            <Button size="sm" className="absolute right-2 top-2" onClick={() => navigator.clipboard.writeText(yaml).then(() => toast("Manifest copied"), () => toast("Copy failed", "error"))}>Copy</Button>
          </div>
        )}
      </Async>
    </div>
  )
}
