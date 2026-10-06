import { uuidSchema } from '@running-tracker/contracts';

// What the browser knows about which organizations the signed-in person belongs to. The list comes from the
// server (`GET /api/organizations`); nothing here ever invents or widens it.
export type OrganizationsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { message: string; status: 'error' }
  | { organizations: readonly string[]; status: 'ready' };

// A chosen organization counts only while the person still belongs to it. A remembered or recovered choice
// that is no longer in the list is ignored, and the only automatic choice is the one organization there is.
export function resolveOrganization(
  organizations: readonly string[],
  preferred: string | null,
): string | null {
  if (preferred !== null && organizations.includes(preferred)) {
    return preferred;
  }
  const [only] = organizations;
  return organizations.length === 1 && only !== undefined ? only : null;
}

// The server answers with identifiers only, so the label is the start of the identifier, in full when two
// organizations would otherwise read the same.
export function organizationLabel(organizationId: string, organizations: readonly string[]): string {
  const short = organizationId.slice(0, 8);
  const ambiguous = organizations.some((other) => other !== organizationId && other.startsWith(short));
  return ambiguous ? organizationId : short;
}

// What a view that needs an organization says while none is selected; null once one is.
export function organizationPrompt(state: OrganizationsState, selected: string | null): string | null {
  if (selected !== null) {
    return null;
  }
  switch (state.status) {
    case 'idle':
      return 'Sign in to choose an organization.';
    case 'loading':
      return 'Loading your organizations…';
    case 'error':
      return 'Your organizations could not be loaded.';
    case 'ready':
      return state.organizations.length === 0
        ? 'You are not a member of any organization yet.'
        : 'Choose an organization to continue.';
  }
}

// The last choice is remembered per signed-in identity, so another person on the same browser never inherits it.
// It is only a preference: it is applied through resolveOrganization against the list the server just returned.
const storageKeyPrefix = 'running-tracker.organization.';

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readRememberedOrganization(userId: string): string | null {
  try {
    const value = browserStorage()?.getItem(`${storageKeyPrefix}${userId}`) ?? null;
    return value !== null && uuidSchema.safeParse(value).success ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function rememberOrganization(userId: string, organizationId: string): void {
  try {
    browserStorage()?.setItem(`${storageKeyPrefix}${userId}`, organizationId);
  } catch {
    // A browser that refuses storage just asks again next time.
  }
}
