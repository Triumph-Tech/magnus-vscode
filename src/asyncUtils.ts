/**
 * Run `fn` over every item in `items` with at most `concurrency` promises in
 * flight at once. Results are returned in input order. Rejections propagate
 * immediately (any other in-flight work continues but its result is discarded).
 *
 * The `R = void` default lets callers that only care about side effects ignore
 * the returned array entirely; callers that need per-item results get a
 * properly typed array back.
 */
export async function mapWithConcurrency<T, R = void>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    const workers: Promise<void>[] = [];
    for (let w = 0; w < workerCount; w++) {
        workers.push((async () => {
            while (true) {
                const i = cursor++;
                if (i >= items.length) {
                    return;
                }
                results[i] = await fn(items[i], i);
            }
        })());
    }
    await Promise.all(workers);
    return results;
}
