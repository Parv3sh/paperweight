import { mapWithConcurrency } from "./concurrency";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

describe("mapWithConcurrency", () => {
  it("returns results in input order even when items finish out of order", async () => {
    const delays = [30, 5, 20, 1, 10];
    const out = await mapWithConcurrency(delays, 5, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:5", "2:20", "3:1", "4:10"]);
  });

  it("never has more than `limit` calls in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      await tick();
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 8, async (x) => x)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 8, async (x) => x * 2)).toEqual([2, 4]);
  });

  it("treats a limit below one as one", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3], 0, async (x) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return x;
    });
    expect(out).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
  });

  it("rejects when a call throws, so callers must catch per item if they want to skip", async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow("boom");
  });

  it("stops starting new items after the first failure but lets in-flight calls finish", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 2, async (x) => {
        started.push(x);
        await tick();
        if (x === 1) throw new Error("throttled");
        await tick();
        finished.push(x);
        return x;
      }),
    ).rejects.toThrow("throttled");
    // Item 0 was in flight alongside item 1 and completed; nothing beyond the
    // two in-flight items was started.
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([0]);
  });
});
