// Run `fn` over `items` with at most `limit` calls in flight, returning results
// in input order. Dependency-free so providers can share it and tests can load
// it alone. A rejection from `fn` rejects the whole map; callers that want to
// skip individual failures catch inside `fn`.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;

  const workers = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
