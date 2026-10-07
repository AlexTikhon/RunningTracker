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
