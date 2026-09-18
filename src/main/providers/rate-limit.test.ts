import { RateLimiter } from "./rate-limit";

// Fake clock: sleeping advances time, so waits are observable and instant.
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

describe("RateLimiter", () => {
  it("serves requests from the initial burst capacity without waiting", async () => {
    const c = fakeClock();
    const limiter = new RateLimiter(6000, 100, c.now, c.sleep);
    for (let i = 0; i < 20; i++) await limiter.acquire(5);
    expect(c.slept).toEqual([]);
  });

  it("waits exactly long enough to refill the deficit", async () => {
    const c = fakeClock();
    // 6000 units/min = 100 units/s. Capacity 10: the first 10 are free, the
    // next 5 are 5 short -> 50ms.
    const limiter = new RateLimiter(6000, 10, c.now, c.sleep);
    await limiter.acquire(10);
    await limiter.acquire(5);
    expect(c.slept).toEqual([50]);
  });

  it("sustains the configured rate over time", async () => {
    const c = fakeClock();
    const limiter = new RateLimiter(6000, 5, c.now, c.sleep); // 100 units/s
    for (let i = 0; i < 100; i++) await limiter.acquire(5); // 500 units
    // First 5 units are free from capacity; the remaining 495 need 4.95s.
    expect(c.now()).toBe(4950);
  });

  it("penalize holds callers and discards accumulated tokens", async () => {
    const c = fakeClock();
    const limiter = new RateLimiter(6000, 100, c.now, c.sleep);
    limiter.penalize(2000);
    await limiter.acquire(5);
    // Held 2s; refilling only starts when the hold ends, so 5 units then
    // need another 50ms instead of bursting from tokens accrued during it.
    expect(c.slept).toEqual([2000, 50]);
  });

  it("serves concurrent acquires in order", async () => {
    const c = fakeClock();
    const limiter = new RateLimiter(6000, 5, c.now, c.sleep);
    const order: string[] = [];
    await Promise.all([
      limiter.acquire(5).then(() => order.push("a")),
      limiter.acquire(5).then(() => order.push("b")),
      limiter.acquire(5).then(() => order.push("c")),
    ]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("rejects a non-positive rate", () => {
    expect(() => new RateLimiter(0)).toThrow();
  });
});
