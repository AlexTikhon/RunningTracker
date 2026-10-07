import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  organizationLabel,
  organizationPrompt,
  readRememberedOrganization,
  rememberOrganization,
  resolveOrganization,
} from './organization-selection.js';

const orgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userId = '11111111-1111-4111-8111-111111111111';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveOrganization', () => {
  it('selects the only organization without being asked', () => {
    expect(resolveOrganization([orgA], null)).toBe(orgA);
  });

  it('leaves several organizations unselected until one is chosen', () => {
    expect(resolveOrganization([orgA, orgB], null)).toBeNull();
    expect(resolveOrganization([orgA, orgB], orgB)).toBe(orgB);
  });

  it('selects nothing for a person with no organization', () => {
    expect(resolveOrganization([], null)).toBeNull();
    expect(resolveOrganization([], orgA)).toBeNull();
  });

  it('ignores a remembered or recovered organization that is no longer in the list', () => {
    expect(resolveOrganization([orgB], orgA)).toBe(orgB);
    expect(resolveOrganization([orgB, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'], orgA)).toBeNull();
  });
});

describe('organizationLabel', () => {
  it('shows the start of the identifier, and all of it only when two would read the same', () => {
    expect(organizationLabel(orgA, [orgA, orgB])).toBe('aaaaaaaa');
    const sibling = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
    expect(organizationLabel(orgA, [orgA, sibling])).toBe(orgA);
  });
});

describe('organizationPrompt', () => {
  it('says nothing once an organization is selected', () => {
    expect(organizationPrompt({ organizations: [orgA], status: 'ready' }, orgA)).toBeNull();
  });

  it('explains each state in plain words', () => {
    expect(organizationPrompt({ status: 'idle' }, null)).toContain('Sign in');
    expect(organizationPrompt({ status: 'loading' }, null)).toContain('Loading');
    expect(organizationPrompt({ message: 'x', status: 'error' }, null)).toContain('could not be loaded');
    expect(organizationPrompt({ organizations: [], status: 'ready' }, null)).toBe(
      'You are not a member of any organization yet.',
    );
    expect(organizationPrompt({ organizations: [orgA, orgB], status: 'ready' }, null)).toContain('Choose');
  });
});

describe('the remembered organization', () => {
  it('is kept per identity', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const other = '22222222-2222-4222-8222-222222222222';

    rememberOrganization(userId, orgB);

    expect(readRememberedOrganization(userId)).toBe(orgB);
    expect(readRememberedOrganization(other)).toBeNull();
  });

  it('ignores a stored value that is not an identifier', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem(`running-tracker.organization.${userId}`, '<script>');

    expect(readRememberedOrganization(userId)).toBeNull();
  });

  it('survives a browser that refuses storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });

    expect(() => rememberOrganization(userId, orgA)).not.toThrow();
    expect(readRememberedOrganization(userId)).toBeNull();
  });
});
