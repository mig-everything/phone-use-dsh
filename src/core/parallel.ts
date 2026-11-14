/** Bounded, ordered outcomes. A failed device never retries or cancels its peers. */
export async function settleParallel<T, R>(items: T[], work: (item: T) => Promise<R>, limit = 4) {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        try {
          results[index] = { status: 'fulfilled', value: await work(items[index]!) };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    }),
  );
  return results;
}
