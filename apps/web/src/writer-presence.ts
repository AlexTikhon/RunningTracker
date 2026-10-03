// Proof that a writer's JavaScript is still running, independent of any cleanup code.
//
// The writer lease in IndexedDB only says who owned recording at some moment; it cannot tell a reloaded or
// crashed tab from a live one until it expires. A Web Lock held for the lifetime of the document can: the
// browser releases it when the document is destroyed, however that happens. A claimant that finds a live
// lease waits for its holder's lock; once it is free the holder is provably gone and the claimant may replace
// the lease. Safety never rests on this: the fencing token in IndexedDB still decides every write.

export interface WriterPresence {
  // Marks ownerId as live until the returned function is called or the document is destroyed.
  announce(ownerId: string): Promise<() => void>;
  // True once ownerId is not live, false if it is still live after timeoutMs. An owner that never announced
  // itself counts as gone.
  waitForGone(ownerId: string, timeoutMs: number): Promise<boolean>;
}

// Where Web Locks are unavailable nobody is ever proven gone, so ownership falls back to plain lease expiry.
export const inertPresence: WriterPresence = {
  announce: () => Promise.resolve(() => undefined),
  waitForGone: () => Promise.resolve(false),
};

function lockName(ownerId: string): string {
  return `running-tracker:writer-presence:${ownerId}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function createWebLocksPresence(locks: LockManager | undefined): WriterPresence {
  if (locks === undefined) {
    return inertPresence;
  }
  return {
    announce: (ownerId) => new Promise<() => void>((resolve, reject) => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolveHeld) => {
        release = resolveHeld;
      });
      locks.request(lockName(ownerId), () => {
        resolve(release);
        return held;
      }).catch(reject);
    }),
    waitForGone: async (ownerId, timeoutMs) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await locks.request(lockName(ownerId), { signal: controller.signal }, () => true);
      } catch (error) {
        if (isAbortError(error)) {
          return false;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function browserWriterPresence(): WriterPresence {
  return createWebLocksPresence(typeof navigator === 'undefined' ? undefined : navigator.locks);
}
