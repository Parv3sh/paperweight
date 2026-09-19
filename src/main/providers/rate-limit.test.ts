import { RateLimiter } from "./rate-limit";

// Fake clock: sleeping advances time, so waits are observable and instant.
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    slept,
  };
}

function limiter(c: ReturnType<typeof fakeClock>, burst: number, max = 6000, min?: number) {
  return new RateLimiter({
    maxUnitsPerMinute: max,
    minUnitsPerMinute: min,
    burstUnits: burst,
    now: c.now,
    sleep: c.sleep,
  });
}

describe("RateLimiter pacing", () => {
  it("serves requests from the initial burst capacity without waiting", async () => {
    const c = fakeClock();
    const l = limiter(c, 100);
    for (let i = 0; i < 20; i++) await l.acquire(5);
    expect(c.slept).toEqual([]);
  });

  it("waits exactly long enough to refill the deficit", async () => {
    const c = fakeClock();
    // 6000 units/min = 100 units/s. Capacity 10: the first 10 are free, the
    // next 5 are 5 short -> 50ms.
    const l = limiter(c, 10);
    await l.acquire(10);
    await l.acquire(5);
    expect(c.slept).toEqual([50]);
  });

  it("sustains the configured rate over time", async () => {
    const c = fakeClock();
    const l = limiter(c, 5); // 100 units/s
    for (let i = 0; i < 100; i++) await l.acquire(5); // 500 units
    // First 5 units are free from capacity; the remaining 495 need 4.95s.
    expect(c.now()).toBe(4950);
  });

  it("serves concurrent acquires in order", async () => {
    const c = fakeClock();
    const l = limiter(c, 5);
    const order: string[] = [];
    await Promise.all([
      l.acquire(5).then(() => order.push("a")),
      l.acquire(5).then(() => order.push("b")),
      l.acquire(5).then(() => order.push("c")),
    ]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("rejects a non-positive ceiling", () => {
    expect(() => new RateLimiter({ maxUnitsPerMinute: 0 })).toThrow();
  });
});

describe("RateLimiter adaptation", () => {
  it("penalize holds callers, empties the bucket, and cuts the rate by a quarter", async () => {
    const c = fakeClock();
    const l = limiter(c, 100);
    l.penalize(2000);
    expect(l.currentRate()).toBe(4500);
    await l.acquire(5);
    // Held 2s; refilling only starts when the hold ends, and at 4500/min
    // (75 units/s) 5 units take 67ms rather than bursting from tokens accrued
    // during the hold.
    expect(c.slept).toEqual([2000, 67]);
  });

  it("counts a cluster of rejections within the cooldown as one event", () => {
    const c = fakeClock();
    const l = limiter(c, 100);
    l.penalize(1000);
    c.advance(500);
    l.penalize(1000);
    c.advance(500);
    l.penalize(1000);
    expect(l.currentRate()).toBe(4500);
    c.advance(5000);
    l.penalize(1000);
    expect(l.currentRate()).toBe(3375);
  });

  it("never cuts below the floor", () => {
    const c = fakeClock();
    const l = limiter(c, 100, 6000, 1000);
    for (let i = 0; i < 20; i++) {
      l.penalize(0);
      c.advance(10_000);
    }
    expect(l.currentRate()).toBe(1000);
  });

  it("recovers ten percent per quiet minute, up to the ceiling", async () => {
    const c = fakeClock();
    const l = limiter(c, 100);
    l.penalize(0);
    expect(l.currentRate()).toBe(4500);

    c.advance(59_000);
    await l.acquire(1);
    expect(l.currentRate()).toBe(4500); // not a full minute yet

    c.advance(1_000);
    await l.acquire(1);
    expect(l.currentRate()).toBe(4950);

    for (let i = 0; i < 10; i++) {
      c.advance(60_000);
      await l.acquire(1);
    }
    expect(l.currentRate()).toBe(6000);
  });

  it("a rejection resets the quiet-minute clock", async () => {
    const c = fakeClock();
    const l = limiter(c, 100);
    l.penalize(0); // 4500
    c.advance(50_000);
    l.penalize(0); // 3375, clock restarts here
    c.advance(30_000);
    await l.acquire(1);
    expect(l.currentRate()).toBe(3375);
  });
});
