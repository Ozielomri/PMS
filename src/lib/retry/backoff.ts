/**
 * Exponential backoff with jitter, shared by the webhook dispatcher and the internal event bus.
 *
 * attempt 1 failed → wait ~base, attempt 2 → ~2×base, … capped at maxDelayMs, each ±jitter.
 * Returns null when the next attempt would land after the deadline (give up).
 */
export interface BackoffOptions {
  /** Number of attempts made so far (≥ 1). */
  attempt: number;
  now: Date;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Fraction of the delay to randomise, 0..1. */
  jitter?: number;
  /** Stop retrying after this moment. */
  deadline?: Date | null;
  /** Stop retrying after this many attempts. */
  maxAttempts?: number | null;
  random?: () => number;
}

export const WEBHOOK_BACKOFF = {
  baseDelayMs: 30_000,
  maxDelayMs: 60 * 60_000,
  jitter: 0.2,
  windowMs: 24 * 60 * 60_000,
} as const;

export function backoffDelayMs(attempt: number, opts: Omit<BackoffOptions, "attempt" | "now"> = {}): number {
  const base = opts.baseDelayMs ?? WEBHOOK_BACKOFF.baseDelayMs;
  const max = opts.maxDelayMs ?? WEBHOOK_BACKOFF.maxDelayMs;
  const jitter = opts.jitter ?? WEBHOOK_BACKOFF.jitter;
  const random = opts.random ?? Math.random;
  const exponent = Math.max(0, attempt - 1);
  // Avoid overflow for large attempt numbers.
  const raw = exponent > 30 ? max : Math.min(max, base * 2 ** exponent);
  const spread = raw * jitter;
  return Math.max(0, Math.round(raw - spread + random() * 2 * spread));
}

export function nextRetryAt(opts: BackoffOptions): Date | null {
  if (opts.maxAttempts != null && opts.attempt >= opts.maxAttempts) return null;
  const at = new Date(opts.now.getTime() + backoffDelayMs(opts.attempt, opts));
  if (opts.deadline && at.getTime() > opts.deadline.getTime()) return null;
  return at;
}
