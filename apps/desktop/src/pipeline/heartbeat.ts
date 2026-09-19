/**
 * Progress ticks for work that can run for minutes without saying anything.
 *
 * Beyond keeping the log honest, this keeps the extension attached: a Chrome MV3
 * service worker is terminated after roughly 30 seconds of inactivity, and the
 * run stream is its only traffic. A proposer call that thinks in silence for seven
 * minutes takes the worker — and the side panel's live updates — down with it.
 */
export async function withHeartbeat<T>(
  work: () => Promise<T>,
  onTick: (elapsedMs: number) => void,
  intervalMs = 15_000,
): Promise<T> {
  const startedAt = Date.now();
  const timer = setInterval(() => onTick(Date.now() - startedAt), intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
