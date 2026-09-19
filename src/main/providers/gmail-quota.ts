// Gmail API quota accounting. Documented per-call costs are at
// https://developers.google.com/gmail/api/reference/quota. In practice Google's
// "Total Query Cost" metric has rejected us at nominal spends far below the
// quoted limit, most sharply while vendor-wide batch actions ran, so the batch
// call is charged per affected message rather than the documented flat 50.
// Over-counting only makes us a little slower; under-counting gets the whole
// account throttled.

export const QUOTA_COST = {
  get: 5,
  list: 5,
  modify: 5,
  trash: 5,
  send: 100,
  history: 2,
  profile: 1,
} as const;

/** batchModify: at least the documented 50, else 5 per message touched. */
export function batchModifyCost(messageCount: number): number {
  return Math.max(50, QUOTA_COST.modify * messageCount);
}
