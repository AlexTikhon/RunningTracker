/** Resolves after `delayMs` or rejects with the signal's reason; never leaves the timer running. */
export function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The load run was aborted');
}

/**
 * Runs `worker` over `items` with at most `limit` in flight. The first failure (or an abort of `signal`)
 * stops new work, aborts the signal handed to running workers, and rejects immediately; workers already in
 * flight are left to settle on their own. Results keep item order.
 */
export async function runBounded<Item, Result>(
  limit: number,
  items: readonly Item[],
  worker: (item: Item, index: number, signal: AbortSignal) => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('The concurrency limit must be a positive integer');
  }
  const internal = new AbortController();
  const stop = (): void => internal.abort(signal ? abortReason(signal) : undefined);
  if (signal?.aborted) {
    throw abortReason(signal);
  }
  signal?.addEventListener('abort', stop, { once: true });

  const results = new Array<Result>(items.length);
  let next = 0;
  let firstError: { error: unknown } | undefined;

  return await new Promise<Result[]>((resolve, reject) => {
    let running = 0;
    const fail = (error: unknown): void => {
      if (firstError) {
        return;
      }
      firstError = { error };
      const failure = error instanceof Error ? error : new Error('A load worker failed', { cause: error });
      internal.abort(failure);
      reject(failure);
    };
    const finishIfDone = (): void => {
      if (!firstError && running === 0 && next >= items.length) {
        signal?.removeEventListener('abort', stop);
        resolve(results);
      }
    };
    const launch = (): void => {
      while (!firstError && running < limit && next < items.length) {
        if (internal.signal.aborted) {
          fail(abortReason(internal.signal));
          return;
        }
        const index = next++;
        running += 1;
        worker(items[index] as Item, index, internal.signal).then(
          (result) => {
            results[index] = result;
            running -= 1;
            launch();
            finishIfDone();
          },
          (error: unknown) => {
            running -= 1;
            fail(error);
          },
        );
      }
      finishIfDone();
    };
    launch();
  }).finally(() => signal?.removeEventListener('abort', stop));
}
