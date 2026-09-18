// Token-bucket pacing for a per-minute API quota. Callers `acquire(units)`
// before each request; the bucket refills continuously at `unitsPerMinute`
// and holds at most `capacity` units, so a fresh limiter allows a short burst
// and then settles at the sustained rate. Acquires are served in FIFO order.
//
// `now` and `sleep` are injectable so tests can drive a fake clock.

type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private notBefore = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly unitsPerMinute: number,
    private readonly capacity: number = unitsPerMinute,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {
    if (unitsPerMinute <= 0) throw new Error("unitsPerMinute must be positive");
    this.tokens = capacity;
    this.lastRefill = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.lastRefill);
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsed * this.unitsPerMinute) / 60_000,
    );
    this.lastRefill = t;
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
        this.refill();
        if (this.tokens >= units) {
          this.tokens -= units;
          return;
        }
        const deficit = units - this.tokens;
        await this.sleep(Math.ceil((deficit * 60_000) / this.unitsPerMinute));
      }
    } finally {
      release();
    }
  }

  /**
   * The server rejected a request despite our pacing: hold every caller for
   * `ms` and drop any accumulated tokens so we don't burst when the hold ends.
   */
  penalize(ms: number): void {
    this.notBefore = Math.max(this.notBefore, this.now() + ms);
    this.tokens = 0;
    // Refilling starts when the hold ends, so the bucket is empty at that
    // point and callers resume at the sustained rate rather than in a burst.
    this.lastRefill = this.notBefore;
  }
}
