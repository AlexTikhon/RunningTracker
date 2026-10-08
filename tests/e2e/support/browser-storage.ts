import type { Page } from '@playwright/test';

// The durable runner state in the page's own IndexedDB (apps/web/src/runner-storage.ts), read directly. A test
// uses it to prove what survives a sign-out in the browser itself, not what the page happens to display.
// Opening without a version never upgrades the database, and it exists by the time any caller reads it.
const databaseName = 'running-tracker-runner';

export interface DurableRunnerState {
  // The ordered sequence keys of the points still buffered for this user, across all of their runs.
  readonly bufferedSeqKeys: readonly string[];
  // The run the profile points at, if any.
  readonly activeRunId: string | null;
  // The ids of lifecycle commands queued for this user and not yet acknowledged by the server.
  readonly pendingCommandIds: readonly string[];
}

export async function readDurableRunnerState(page: Page, userId: string): Promise<DurableRunnerState> {
  return page.evaluate(
    async ({ name, user }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB'));
      });
      try {
        const all = <Record>(store: string): Promise<Record[]> =>
          new Promise((resolve, reject) => {
            const request = database.transaction(store, 'readonly').objectStore(store).getAll();
            request.onsuccess = () => resolve(request.result as Record[]);
            request.onerror = () => reject(request.error ?? new Error(`Unable to read ${store}`));
          });
        const points = await all<{ seqKey: string; userId: string }>('points');
        const profiles = await all<{ activeRunId: string | null; userId: string }>('profiles');
        const requests = await all<{ request: { commandId?: string }; userId: string }>('requests');
        return {
          activeRunId: profiles.find((profile) => profile.userId === user)?.activeRunId ?? null,
          bufferedSeqKeys: points
            .filter((point) => point.userId === user)
            .map((point) => point.seqKey)
            .sort(),
          pendingCommandIds: requests
            .filter((entry) => entry.userId === user)
            .flatMap((entry) => (entry.request.commandId === undefined ? [] : [entry.request.commandId])),
        };
      } finally {
        database.close();
      }
    },
    { name: databaseName, user: userId },
  );
}

// The lifecycle status stored for the run the profile points at, or null when none is. A separate read so the
// shape of DurableRunnerState, which many tests compare whole, does not change.
export async function readDurableRunStatus(page: Page, userId: string): Promise<string | null> {
  return page.evaluate(
    async ({ name, user }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB'));
      });
      try {
        const read = <Record>(store: string, key: string): Promise<Record | undefined> =>
          new Promise((resolve, reject) => {
            const request = database.transaction(store, 'readonly').objectStore(store).get(key);
            request.onsuccess = () => resolve(request.result as Record | undefined);
            request.onerror = () => reject(request.error ?? new Error(`Unable to read ${store}`));
          });
        const profile = await read<{ activeOrgId: string | null; activeRunId: string | null }>('profiles', user);
        if (profile?.activeRunId == null || profile.activeOrgId == null) return null;
        const record = await read<{ run: { status: string } | null }>('runs', `${user}:${profile.activeOrgId}:${profile.activeRunId}`);
        return record?.run?.status ?? null;
      } finally {
        database.close();
      }
    },
    { name: databaseName, user: userId },
  );
}

// Ends the writer lease record behind the page's back, as if the owner had been released or had expired: the page
// finds out at its next renewal, and a claim afterwards starts a newer epoch for the same owner (ADR-0053).
export async function endWriterLeaseBehindThePage(page: Page, userId: string): Promise<void> {
  await page.evaluate(
    async ({ name, user }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB'));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction('leases', 'readwrite');
          const store = transaction.objectStore('leases');
          const get = store.get(user);
          get.onsuccess = () => {
            const record = get.result as Record<string, unknown> | undefined;
            if (record === undefined) { reject(new Error('There is no lease to end')); return; }
            const now = new Date().toISOString();
            store.put({ ...record, expiresAt: now, releasedAt: now });
          };
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error ?? new Error('Unable to end the lease'));
        });
      } finally {
        database.close();
      }
    },
    { name: databaseName, user: userId },
  );
}
