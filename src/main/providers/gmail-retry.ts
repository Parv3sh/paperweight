// Retry policy for Gmail API calls. Kept dependency-free so it can be unit
// tested without loading the provider (which needs build-time OAuth defines).
//
// Gmail throttles two ways: HTTP 429, and HTTP 403 whose body names a
// rate-limit or quota reason ("Quota exceeded for quota metric 'Queries' and
// limit 'Queries per minute per user'"). Both are per-minute limits that clear
// on their own, so a first sync of a large mailbox should wait and continue
// rather than fail. 5xx responses are retried too, per Google's guidance.

// Eight attempts: 1+2+4+8+16+32+60+60s ≈ 3 minutes of patience, enough to
// outlast a per-minute window that another process (or a previous run of the
// app) has already saturated.
export const GMAIL_MAX_RETRIES = 8;

const RATE_LIMIT_REASON =
  /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|Quota exceeded/i;

export function isRetryableGmailResponse(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  if (status === 403) return RATE_LIMIT_REASON.test(body);
  return false;
}

// True when an error thrown by the provider ("Gmail API error (403): ...") was
// a throttle that outlived the retries. Such a message must not be skipped: the
// caller fails the page so the next refresh retries it from the same token.
export function isGmailThrottleError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Gmail API error \(429\)/.test(msg)) return true;
  return /Gmail API error \(403\)/.test(msg) && RATE_LIMIT_REASON.test(msg);
}

// Prefers Retry-After; otherwise exponential backoff (1s, 2s, 4s, ... capped at
// 60s) plus up to one second of jitter so parallel workers don't retry in
// lockstep.
export function gmailRetryDelayMs(
  retryAfter: string | null,
  attempt: number,
  jitter: number = Math.random(),
): number {
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds) && seconds >= 0) return seconds * 1000;
  }
  const base = Math.min(2 ** attempt * 1000, 60_000);
  return Math.round(base + jitter * 1000);
}
