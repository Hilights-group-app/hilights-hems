/** Signals from the existing authenticated Realtime channel; no extra channel. */
export const NOTIFICATION_FEED_EVENT = "hems:notification-feed-change";
export const MAINTENANCE_ALERTS_EVENT = "hems:maintenance-alerts-change";

type RefreshOptions = {
  debounceMs?: number;
  minIntervalMs?: number;
  maxWaitMs?: number;
  isVisible?: () => boolean;
  onError?: (error: unknown) => void;
};

/**
 * One read at a time, with at most one pending follow-up. A busy warehouse can
 * send many change events while an earlier read is slow: do not start another
 * copy, but do read again afterwards so the latest change is not lost.
 * Hidden tabs keep the dirty flag and resume when their owner calls resume().
 */
export function createRefreshQueue(read: () => Promise<unknown>, options: RefreshOptions = {}) {
  const debounceMs = Math.max(0, options.debounceMs ?? 250);
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 1000);
  const maxWaitMs = Math.max(debounceMs, options.maxWaitMs ?? 2000);
  const isVisible = options.isVisible ?? (() =>
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
  let disposed = false;
  let running = false;
  let pending = false;
  let urgent = false;
  let pendingSince = 0;
  let dueAt = 0;
  let lastStartedAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function arm() {
    clearTimer();
    if (disposed || running || !pending || !isVisible()) return;
    const deadline = Math.max(
      lastStartedAt + minIntervalMs,
      Math.min(dueAt, pendingSince + maxWaitMs),
    );
    timer = setTimeout(() => { timer = undefined; void run(); }, Math.max(0, deadline - Date.now()));
  }

  async function run() {
    if (disposed || running || !pending || !isVisible()) return;
    running = true;
    pending = false;
    urgent = false;
    lastStartedAt = Date.now();
    try {
      await read();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
      arm();
    }
  }

  function enqueue(immediate: boolean) {
    if (disposed) return;
    const now = Date.now();
    if (!pending) pendingSince = now;
    pending = true;
    urgent = urgent || immediate;
    dueAt = urgent ? pendingSince : now + debounceMs;
    arm();
  }

  return {
    request: () => enqueue(true),
    schedule: () => enqueue(false),
    resume: arm,
    isPending: () => pending || running,
    dispose: () => { disposed = true; pending = false; clearTimer(); },
  };
}
