import { useCallback, useEffect, useState } from 'react';

import {
  readRememberedOrganization,
  rememberOrganization,
  resolveOrganization,
  type OrganizationsState,
} from './organization-selection.js';
import { loadOrganizations, RunnerApiError } from './runner-api.js';
import type { SessionState } from './use-runner-session.js';

interface Loaded {
  // The session lifetime this answer was loaded for. A different lifetime (another sign-in, another person)
  // never sees it, not even for the one render before its own request starts.
  owner: AbortSignal;
  state: OrganizationsState;
}

interface Preference {
  orgId: string | null;
  userId: string;
}

// Discovers the organizations of the current session and tracks which one is selected. The selection is always
// derived from the list the server just returned: a remembered or recovered choice only counts while it is in it.
export function useOrganizations(session: SessionState) {
  const signal = session.status === 'ready' ? session.signal : null;
  const userId = session.status === 'ready' ? session.session.identity.userId : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [preference, setPreference] = useState<Preference | null>(null);

  useEffect(() => {
    if (signal === null) {
      setLoaded(null);
      setPreference(null);
      return undefined;
    }
    let active = true;
    loadOrganizations(signal)
      .then((organizations) => {
        if (active && !signal.aborted) {
          setLoaded({
            owner: signal,
            state: { organizations: organizations.map((id) => id.toLowerCase()), status: 'ready' },
          });
        }
      })
      .catch((error: unknown) => {
        if (active && !signal.aborted) {
          setLoaded({
            owner: signal,
            state: {
              message: error instanceof RunnerApiError ? error.message : 'The server could not be reached.',
              status: 'error',
            },
          });
        }
      });
    return () => {
      active = false;
    };
  }, [attempt, signal]);

  const discovery: OrganizationsState = signal === null
    ? { status: 'idle' }
    : loaded?.owner === signal
      ? loaded.state
      : { status: 'loading' };
  const preferred = preference !== null && preference.userId === userId ? preference.orgId : null;
  const selectedOrgId = discovery.status === 'ready' ? resolveOrganization(discovery.organizations, preferred) : null;

  const choose = useCallback((organizationId: string) => {
    if (userId === null) return;
    setPreference({ orgId: organizationId, userId });
    rememberOrganization(userId, organizationId);
  }, [userId]);

  // Offers the organization a recovered run belongs to, or else the one this identity chose last time.
  const prefer = useCallback((organizationId: string | null) => {
    if (userId === null) return;
    setPreference({ orgId: organizationId ?? readRememberedOrganization(userId), userId });
  }, [userId]);

  const reload = useCallback(() => {
    setLoaded(null);
    setAttempt((value) => value + 1);
  }, []);

  return { choose, discovery, prefer, reload, selectedOrgId };
}
