import {
  GMAIL_MAX_RETRIES,
  gmailRetryDelayMs,
  isRetryableGmailResponse,
} from "./gmail-retry";

const QUOTA_BODY = JSON.stringify({
  error: {
    code: 403,
    message:
      "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'gmail.googleapis.com'",
    errors: [{ reason: "rateLimitExceeded", domain: "usageLimits" }],
  },
});

describe("isRetryableGmailResponse", () => {
  it("retries the per-user quota 403 that a large first sync triggers", () => {
    expect(isRetryableGmailResponse(403, QUOTA_BODY)).toBe(true);
  });

  it("retries 403s by reason even without the human message", () => {
    expect(isRetryableGmailResponse(403, '{"reason":"userRateLimitExceeded"}')).toBe(true);
    expect(isRetryableGmailResponse(403, '{"reason":"quotaExceeded"}')).toBe(true);
  });

  it("does not retry a permission 403", () => {
    const forbidden = JSON.stringify({
      error: { code: 403, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] },
    });
    expect(isRetryableGmailResponse(403, forbidden)).toBe(false);
  });

  it("retries 429 and 5xx, never 4xx client errors", () => {
    expect(isRetryableGmailResponse(429, "")).toBe(true);
    expect(isRetryableGmailResponse(500, "")).toBe(true);
    expect(isRetryableGmailResponse(503, "")).toBe(true);
    expect(isRetryableGmailResponse(400, "")).toBe(false);
    expect(isRetryableGmailResponse(401, "")).toBe(false);
    expect(isRetryableGmailResponse(404, "")).toBe(false);
  });
});

describe("gmailRetryDelayMs", () => {
  it("honours Retry-After when present", () => {
    expect(gmailRetryDelayMs("7", 0, 0)).toBe(7000);
  });

  it("falls back to exponential backoff with jitter", () => {
    expect(gmailRetryDelayMs(null, 0, 0)).toBe(1000);
    expect(gmailRetryDelayMs(null, 3, 0)).toBe(8000);
    expect(gmailRetryDelayMs(null, 3, 0.5)).toBe(8500);
    expect(gmailRetryDelayMs("not-a-number", 1, 0)).toBe(2000);
  });

  it("caps the backoff at one minute", () => {
    expect(gmailRetryDelayMs(null, 10, 0)).toBe(60_000);
  });

  it("waits out a full per-minute window across all attempts", () => {
    let total = 0;
    for (let attempt = 0; attempt < GMAIL_MAX_RETRIES; attempt++) {
      total += gmailRetryDelayMs(null, attempt, 0);
    }
    expect(total).toBeGreaterThanOrEqual(60_000);
  });
});
