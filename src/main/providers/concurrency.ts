// Run `fn` over `items` with at most `limit` calls in flight, returning results
// in input order. Dependency-free so providers can share it and tests can load
// it alone.
//
// Failure semantics: the first rejection from `fn` stops new items from being
// started, in-flight calls are allowed to finish, and the map then rejects with
// that first error. Callers that want to skip individual failures catch inside
// `fn` instead.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;

  const workers = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  let failure: { error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (failure === undefined) failure = { error };
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, worker));
  if (failure !== undefined) throw failure.error;
  return results;
}
