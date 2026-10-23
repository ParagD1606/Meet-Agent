import { useMutation, useQueryClient } from "@tanstack/react-query"
import { errMsg } from "@/lib/api"
import { useToast } from "@/ui/toast"

interface Opts<V, R> {
  /** Query keys to invalidate on success. */
  invalidate?: unknown[][]
  /** Success toast. */
  ok?: string
  onSuccess?: (r: R, v: V) => void
  /** Don't toast errors: the caller renders `mutation.error` inline next to the field. */
  inline?: boolean
}

/** Mutation with the app's conventions: invalidate, success toast, error toast (or inline). */
export function useAction<V = void, R = unknown>(fn: (v: V) => Promise<R>, o: Opts<V, R> = {}) {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation<R, Error, V>({
    mutationFn: fn,
    onSuccess: (r, v) => {
      o.invalidate?.forEach((k) => void qc.invalidateQueries({ queryKey: k }))
      if (o.ok) toast.push({ kind: "success", title: o.ok })
      o.onSuccess?.(r, v)
    },
    onError: (e) => { if (!o.inline) toast.push({ kind: "error", title: "That didn't work", body: errMsg(e) }) },
  })
}
