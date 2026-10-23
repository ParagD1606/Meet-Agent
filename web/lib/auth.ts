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
