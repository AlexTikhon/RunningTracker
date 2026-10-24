import { useEffect, useRef, useState } from 'react';

import { DemoSignInController, demoRoleLabels, type DemoRole, type DemoSignInSnapshot } from './demo-sign-in.js';
import { createLocalSession } from './runner-api.js';

interface DemoSignInProps {
  create?: (userId: string, signal: AbortSignal) => Promise<void>;
  // The page's own session check (refreshSession).
  onSignedIn: () => Promise<boolean>;
  // The last session check had no answer, so a session may still exist. Offering an identity then could switch
  // people without a sign-out; the person retries the check first.
  sessionUnknown: boolean;
}

const idleSnapshot: DemoSignInSnapshot = { failure: null, pending: null };
const roles: readonly DemoRole[] = ['runner', 'coach'];

// The local demo's sign-in buttons (demo-sign-in.ts). The page renders this only on the signed-out screen of a dev
// server started by `npm run demo:up`, so switching identity always goes through Sign out. Each mount is one
// controller; unmounting silences whatever it still has in flight.
export function DemoSignIn({ create = createLocalSession, onSignedIn, sessionUnknown }: DemoSignInProps) {
  const [snapshot, setSnapshot] = useState<DemoSignInSnapshot>(idleSnapshot);
  const controller = useRef<DemoSignInController | null>(null);
  const confirm = useRef(onSignedIn);
  confirm.current = onSignedIn;

  useEffect(() => {
    const next = new DemoSignInController({ confirm: () => confirm.current(), create, onChange: setSnapshot });
    controller.current = next;
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [create]);

  return (
    <DemoSignInView
      onSignIn={(role) => controller.current?.signIn(role)}
      sessionUnknown={sessionUnknown}
      snapshot={snapshot}
    />
  );
}

interface DemoSignInViewProps {
  onSignIn: (role: DemoRole) => void;
  sessionUnknown: boolean;
  snapshot: DemoSignInSnapshot;
}

export function DemoSignInView({ onSignIn, sessionUnknown, snapshot }: DemoSignInViewProps) {
  const disabled = snapshot.pending !== null || sessionUnknown;
  return (
    <section aria-label="Local demo sign-in" className="notice notice--demo">
      <div>
        <strong>Local demo</strong>
        <span>
          Sign in as one of the two demo people. For the other one, use another browser profile or a private window:
          the tabs and windows of one profile share the sign-in.
        </span>
        {sessionUnknown && (
          <span className="notice__note">
            The server could not be asked whether someone is already signed in. Press Retry session first.
          </span>
        )}
        {snapshot.pending !== null && (
          <span className="notice__note" role="status">
            Signing in as the {demoRoleLabels[snapshot.pending].toLowerCase()}…
          </span>
        )}
        {snapshot.failure !== null && <span className="notice__failure" role="alert">{snapshot.failure}</span>}
      </div>
      <div className="notice__actions">
        {roles.map((role) => (
          <button disabled={disabled} key={role} onClick={() => onSignIn(role)} type="button">
            {demoRoleLabels[role]}
          </button>
        ))}
      </div>
    </section>
  );
}
