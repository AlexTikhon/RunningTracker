// Test setup only: no application module imports this. The application lets go of a run only through the fenced
// IndexedDbRunnerStorage operations (clearFinishedRun, the discards); this moves the pointer behind the storage
// class's back, with no lease and no check, for a test that needs the state another epoch could have left (for
// example, a run that is no longer active while it still has buffered points or queued requests).
export async function detachActiveRunForTest(factory: IDBFactory, databaseName: string, userId: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('profiles', 'readwrite');
      const profiles = transaction.objectStore('profiles');
      const read = profiles.get(userId);
      read.onsuccess = () => {
        const profile = read.result as Record<string, unknown> | undefined;
        profiles.put({ ...profile, activeOrgId: null, activeRunId: null, userId });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    });
  } finally {
    database.close();
  }
}
