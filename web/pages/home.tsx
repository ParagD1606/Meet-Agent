import { useQuery } from "@tanstack/react-query"
import { Link } from "wouter"
import { api, count, type Turn } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { Async, Badge, Card, Empty, PageTitle, ago } from "@/lib/ui"

export const statusTone = { done: "ok", error: "danger", running: "primary", waiting_approval: "warn" } as const

export function TurnList({ turns }: { turns: Turn[] }) {
  if (!turns.length) return <Empty>No turns yet. Mention the bot in Slack to get started.</Empty>
  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
      {turns.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
          <Badge tone={statusTone[t.status] ?? "neutral"}>{t.status.replace("_", " ")}</Badge>
          <span className="font-medium">{t.trigger}</span>
          <span className="text-muted">{t.channelId}</span>
          <span className="ml-auto text-xs text-muted">{ago(t.startedAt)}</span>
        </li>
      ))}
    </ul>
  )
}

export function Home() {
  const { me, admin } = useMe()
  const q = useQuery({ queryKey: ["overview"], queryFn: api.overview })
  return (
    <>
      <PageTitle title={`Welcome${me ? `, ${me.name.split(" ")[0]}` : ""}`} sub="What your Company Brain knows and is doing right now." />
      <Async q={q}>
        {(o) => (
          <>
            <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {[
                ["Memories", o.memoryCount, "/memories"],
                ["Connections", count(o.connections), "/configure/integrations"],
                ["Automations", count(o.automations), "/configure/automations"],
              ].map(([label, n, to]) => (
                <Link key={label as string} href={to as string}>
                  <Card className="transition hover:border-primary">
                    <p className="text-sm text-muted">{label}</p>
                    <p className="mt-1 text-3xl font-semibold">{n}</p>
                  </Card>
                </Link>
              ))}
            </div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Recent turns</h2>
              {admin && <Link href="/turns" className="text-sm text-primary">View all</Link>}
            </div>
            <TurnList turns={o.recentTurns ?? []} />
          </>
        )}
      </Async>
    </>
  )
}
