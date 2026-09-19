// Adaptive token-bucket pacing for a per-minute API quota whose real
// enforcement we can't see. Callers `acquire(units)` before each request; the
// bucket refills continuously at the current rate and holds at most
// `burstUnits`, so a fresh limiter allows a short burst and then settles.
// Acquires are served in FIFO order.
//
// The rate adapts (additive-increase / multiplicative-decrease): a server
// rejection (`penalize`) cuts it by a quarter, at most once per cooldown so a
// cluster of simultaneous rejections counts as one event; a full minute with
// no rejection raises it by ten percent, up to the configured ceiling. Within
// a few minutes the limiter sits just under whatever the server tolerates.
//
// `now` and `sleep` are injectable so tests can drive a fake clock.

type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface RateLimiterOptions {
  /** Ceiling the rate recovers towards. */
  maxUnitsPerMinute: number;
  /** Floor the rate is never cut below. Default: an eighth of the ceiling. */
  minUnitsPerMinute?: number;
  /** Bucket capacity: how much can be spent at once. Default: the ceiling. */
  burstUnits?: number;
  /** Rejections closer together than this count as one event. Default 5s. */
  penaltyCooldownMs?: number;
  /** Quiet time before the rate is raised a step. Default 60s. */
  recoveryIntervalMs?: number;
  now?: () => number;
  sleep?: Sleep;
}

const DECREASE_FACTOR = 0.75;
const INCREASE_FACTOR = 1.1;

export class RateLimiter {
  private rate: number;
  private readonly maxRate: number;
  private readonly minRate: number;
  private readonly capacity: number;
  private readonly penaltyCooldownMs: number;
  private readonly recoveryIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: Sleep;

  private tokens: number;
  private lastRefill: number;
  private notBefore = 0;
  private lastPenaltyAt = -Infinity;
  private lastAdjustAt: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    const max = options.maxUnitsPerMinute;
    if (!(max > 0)) throw new Error("maxUnitsPerMinute must be positive");
    this.maxRate = max;
    this.minRate = Math.min(max, options.minUnitsPerMinute ?? max / 8);
    this.capacity = options.burstUnits ?? max;
    this.penaltyCooldownMs = options.penaltyCooldownMs ?? 5_000;
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.rate = max;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
    this.lastAdjustAt = this.lastRefill;
  }

  /** Current sustained rate in units per minute. */
  currentRate(): number {
    return Math.round(this.rate);
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.lastRefill);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.rate) / 60_000);
    this.lastRefill = t;
  }

  private maybeRecover(): void {
    if (this.rate >= this.maxRate) return;
    const t = this.now();
    if (t - this.lastAdjustAt < this.recoveryIntervalMs) return;
    this.rate = Math.min(this.maxRate, this.rate * INCREASE_FACTOR);
    this.lastAdjustAt = t;
  }

  /** Resolves once `units` have been reserved from the bucket. */
  async acquire(units: number): Promise<void> {
    const previous = this.queue;
    let release: () => void = () => {};
    this.queue = new Promise<void>((r) => (release = r));
    await previous;
    try {
      while (true) {
        const t = this.now();
        if (t < this.notBefore) {
          await this.sleep(this.notBefore - t);
          continue;
        }
        this.maybeRecover();
        this.refill();
        if (this.tokens >= units) {
          this.tokens -= units;
          return;
        }
        const deficit = units - this.tokens;
        await this.sleep(Math.ceil((deficit * 60_000) / this.rate));
      }
    } finally {
      release();
    }
  }

  /**
   * The server rejected a request despite our pacing. Hold every caller for
   * `holdMs`, drop accumulated tokens so we don't burst when the hold ends,
   * and cut the sustained rate unless another rejection was just counted.
   */
  penalize(holdMs: number): void {
    const t = this.now();
    this.notBefore = Math.max(this.notBefore, t + holdMs);
    this.tokens = 0;
    // Refilling starts when the hold ends, so callers resume at the sustained
    // rate rather than in a burst of tokens accrued during the hold.
    this.lastRefill = this.notBefore;
    if (t - this.lastPenaltyAt >= this.penaltyCooldownMs) {
      this.rate = Math.max(this.minRate, this.rate * DECREASE_FACTOR);
      this.lastPenaltyAt = t;
    }
    this.lastAdjustAt = t;
  }
}
