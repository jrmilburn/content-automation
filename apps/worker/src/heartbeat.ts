import type { JobHandlerExecutionContext } from "@studio-parallel/db";

/**
 * Keeps a job's lease alive across one long operation.
 *
 * The domain lease is 120 seconds and handlers renew it themselves, so any
 * single await longer than that has its attempt reclaimed while the handler is
 * working perfectly well. A timer covers the whole operation rather than the
 * gaps between stages, which is the distinction #160 was about and #166 wants
 * applied to every queue.
 *
 * A failed heartbeat is swallowed: the work is still progressing, and turning a
 * transient database blip into a failed job would throw away whatever the
 * operation has already paid for — a provider call, or a transfer.
 *
 * Note this does not extend the queue's own delivery expiry, which is a
 * wall-clock ceiling on a single attempt. Work that could exceed it needs to be
 * resumable, not merely heartbeated.
 */
const heartbeatIntervalMs = 30_000;

export async function withHeartbeat<T>(
  execution: JobHandlerExecutionContext,
  operation: () => Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    void execution.heartbeat().catch(() => undefined);
  }, heartbeatIntervalMs);

  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}
