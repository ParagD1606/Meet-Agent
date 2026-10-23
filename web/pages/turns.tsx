import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Async, Badge, Button, PageTitle, ago } from "@/lib/ui"
import { statusTone } from "./home"

export function Turns() {
  const q = useQuery({ queryKey: ["turns"], queryFn: () => api.turns(100) })
  return (
    <>
      <PageTitle title="Turns" sub="Recent agent runs, for debugging. Admins only." action={<Button onClick={() => q.refetch()} disabled={q.isFetching}>Refresh</Button>} />
      <Async q={q} empty="No turns recorded yet.">
        {(turns) => (
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">Recent turns</caption>
              <thead className="border-b border-line text-xs text-muted">
                <tr>{["Status", "Trigger", "Channel", "User", "Tools", "Tokens in/out", "Started", "Error"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {turns.map((t) => (
                  <tr key={t.id}>
                    <td className="px-3 py-2"><Badge tone={statusTone[t.status] ?? "neutral"}>{t.status.replace("_", " ")}</Badge></td>
                    <td className="px-3 py-2">{t.trigger}</td>
                    <td className="px-3 py-2 text-muted">{t.channelId}</td>
                    <td className="px-3 py-2 text-muted">{t.userId ?? "-"}</td>
                    <td className="px-3 py-2">{t.toolCalls?.length ?? 0}</td>
                    <td className="px-3 py-2">{t.inputTokens ?? 0} / {t.outputTokens ?? 0}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted">{ago(t.startedAt)}</td>
                    <td className="max-w-64 truncate px-3 py-2 text-danger" title={t.error ?? ""}>{t.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </>
  )
}
