import { describe, expect, it } from 'vitest';

import { createWebLocksPresence, inertPresence } from './writer-presence.js';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Node ships the same Web Locks API a browser does, so the adapter runs against the real lock manager.
function freshOwner(): string {
  return crypto.randomUUID();
}

describe('web locks writer presence', () => {
  it('reports an owner that never announced itself as gone at once', async () => {
    const presence = createWebLocksPresence(navigator.locks);

    await expect(presence.waitForGone(freshOwner(), 1_000)).resolves.toBe(true);
  });

  it('reports a live owner as present until its timeout, then as not gone', async () => {
    const presence = createWebLocksPresence(navigator.locks);
    const id = freshOwner();
    const release = await presence.announce(id);
    try {
      await expect(presence.waitForGone(id, 20)).resolves.toBe(false);
    } finally {
      release();
    }
  });

  it('resolves a pending wait the moment the owner releases, without polling', async () => {
    const presence = createWebLocksPresence(navigator.locks);
    const id = freshOwner();
    const release = await presence.announce(id);

    const pending = presence.waitForGone(id, 5_000);
    release();

    await expect(pending).resolves.toBe(true);
  });

  it('keeps owners independent of each other', async () => {
    const presence = createWebLocksPresence(navigator.locks);
    const release = await presence.announce(owner);
    try {
      await expect(presence.waitForGone(other, 1_000)).resolves.toBe(true);
      await expect(presence.waitForGone(owner, 20)).resolves.toBe(false);
    } finally {
      release();
    }
  });

  it('releasing twice is harmless', async () => {
    const presence = createWebLocksPresence(navigator.locks);
    const id = freshOwner();
    const release = await presence.announce(id);
    release();
    release();

    await expect(presence.waitForGone(id, 1_000)).resolves.toBe(true);
  });

  it('is inert, and never claims an owner is gone, without a lock manager', async () => {
    const presence = createWebLocksPresence(undefined);

    expect(presence).toBe(inertPresence);
    const release = await presence.announce(owner);
    release();
    await expect(presence.waitForGone(owner, 1_000)).resolves.toBe(false);
  });
});
