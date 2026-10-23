import { useQuery } from "@tanstack/react-query"
import { ApiError, api, isAdmin, type Me } from "./api"

/** null = signed out; undefined = still loading. */
export function useMe() {
  const q = useQuery<Me | null>({
    queryKey: ["me"],
    queryFn: () => api.me().catch((e) => { if (e instanceof ApiError && e.status === 401) return null; throw e }),
    staleTime: Infinity,
  })
  return { me: q.data, loading: q.isPending, error: q.error, refetch: q.refetch, admin: isAdmin(q.data?.role) }
}

/** id -> name map from /api/users (admins only; members get an empty map). */
export function useUserNames() {
  const { admin } = useMe()
  const q = useQuery({ queryKey: ["users"], queryFn: api.users, enabled: admin, staleTime: 5 * 60_000 })
  const byId = new Map((q.data ?? []).map((u) => [u.id, u]))
  return { users: q.data ?? [], name: (id?: string | null) => (id ? byId.get(id)?.name ?? id : "System"), get: (id?: string | null) => (id ? byId.get(id) : undefined) }
}
