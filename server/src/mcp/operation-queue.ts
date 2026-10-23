/** Runs operations strictly one at a time (FIFO). Used per MCP connection: many servers/sessions are not safe to hit concurrently. */
export type SerialOperationQueue = { run<T>(op: () => Promise<T>): Promise<T> };

export function createSerialOperationQueue(): SerialOperationQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(op: () => Promise<T>): Promise<T> {
      const next = tail.then(op, op); // a failed predecessor must not block or poison the queue
      tail = next.catch(() => {});
      return next;
    },
  };
}

const queues = new Map<string, { q: SerialOperationQueue; pending: number }>();

/** One queue per connection id; entries are dropped when idle so the map never grows. */
export function runForConnection<T>(connectionId: string, op: () => Promise<T>): Promise<T> {
  let e = queues.get(connectionId);
  if (!e) queues.set(connectionId, (e = { q: createSerialOperationQueue(), pending: 0 }));
  const entry = e;
  entry.pending++;
  return entry.q.run(op).finally(() => { if (--entry.pending === 0) queues.delete(connectionId); });
}
