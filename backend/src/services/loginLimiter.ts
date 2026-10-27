/**
 * In-memory throttle for failed logins, keyed by client IP + email, and for
 * failed password changes, keyed by client IP + user id.
 *
 * One backend instance runs in production, so process memory is enough; a
 * restart (or the free tier going to sleep) simply resets the counters.
 */

export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60 * 1000;
const SWEEP_AT = 10_000;

interface Entry {
  count: number;
  firstAt: number;
}

const failures = new Map<string, Entry>();

function current(key: string, now: number): Entry | undefined {
  const entry = failures.get(key);
  if (entry && now - entry.firstAt > WINDOW_MS) {
    failures.delete(key);
    return undefined;
  }
  return entry;
}

export function isBlocked(key: string, now: number = Date.now()): boolean {
  return (current(key, now)?.count ?? 0) >= MAX_FAILURES;
}

export function recordFailure(key: string, now: number = Date.now()): void {
  const entry = current(key, now);
  if (entry) {
    entry.count++;
    return;
  }
  if (failures.size >= SWEEP_AT) {
    for (const k of [...failures.keys()]) current(k, now);
  }
  failures.set(key, { count: 1, firstAt: now });
}

export function clearFailures(key: string): void {
  failures.delete(key);
}

export function resetLoginLimiter(): void {
  failures.clear();
}
