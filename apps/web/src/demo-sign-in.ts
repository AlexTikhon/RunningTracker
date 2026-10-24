import { RunnerApiError } from './runner-api.js';

// Sign-in for the local demo (docs/runbooks/demo.md). It is the development session the console snippet used, and
// nothing more: POST /api/session for one of two fixed people, then the page's own session check. The API offers that
// endpoint only with LOCAL_AUTH_ENABLED, refuses it in production, and accepts only the IDs in LOCAL_AUTH_USER_IDS.

// The demo people of scripts/demo-plan.mjs (`demoIds`), which demo:seed writes into the development database. That
// file is a Node script, so the two IDs are repeated here; scripts/demo-plan.test.mjs checks that the copies agree.
// A plain object, not Object.freeze: a top-level call would keep the IDs in a production bundle that never uses them.
export type DemoRole = 'coach' | 'runner';

export const demoIdentities: Readonly<Record<DemoRole, string>> = {
  coach: 'dddddddd-dddd-4ddd-8ddd-dddddddd0002',
  runner: 'dddddddd-dddd-4ddd-8ddd-dddddddd0001',
};

export const demoRoleLabels: Readonly<Record<DemoRole, string>> = { coach: 'Demo coach', runner: 'Demo runner' };

// `npm run demo:up` sets the flag for its own Vite process; nothing else does. A production build has DEV false, so it
// never offers the buttons whatever the flag says.
export function localDemoEnabled(env: { readonly DEV: boolean; readonly VITE_LOCAL_DEMO_ENABLED?: string }): boolean {
  return env.DEV && env.VITE_LOCAL_DEMO_ENABLED === 'true';
}

export interface DemoSignInSnapshot {
  // Why the last attempt did not end in a session; null while one is pending and before the first.
  failure: string | null;
  // The identity being signed in. Both buttons are disabled while it is set.
  pending: DemoRole | null;
}

export interface DemoSignInControllerOptions {
  // The page's own session check (useRunnerSession's refreshSession): its GET /api/session establishes the identity,
  // the CSRF token, the lifetime and, from there, organization discovery. Resolves to whether a session is now held.
  confirm: () => Promise<boolean>;
  create: (userId: string, signal: AbortSignal) => Promise<void>;
  onChange: (snapshot: DemoSignInSnapshot) => void;
}

function describeDetail(error: unknown): string {
  if (error instanceof RunnerApiError) {
    switch (error.code) {
      case 'ROUTE_NOT_FOUND':
        return 'Local sign-in is off on this API. Start the demo with npm run demo:up, or set LOCAL_AUTH_ENABLED=true and restart the API.';
      case 'ORIGIN_DENIED':
        return 'The API does not accept sign-in from this address. Open the app at http://127.0.0.1:5173, not localhost.';
      case 'LOCAL_IDENTITY_DENIED':
        return 'The API does not allow this demo identity. npm run demo:up allows both; otherwise add it to LOCAL_AUTH_USER_IDS and restart the API.';
      default: {
        const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
        return `${error.message.replace(/[.\s]+$/u, '')} (${error.code}).${reference} Try again.`;
      }
    }
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'The server did not answer in time. Try again.';
  }
  return 'The server could not be reached. Check that the API is running, then try again.';
}

export function describeDemoSignInFailure(role: DemoRole, error: unknown): string {
  return `Could not sign in as the ${demoRoleLabels[role].toLowerCase()}. ${describeDetail(error)}`;
}

const notConfirmed =
  'The server accepted the sign-in, but the session check that followed did not confirm it (see the message above). ' +
  'If the API sends Secure cookies over plain http, start it with npm run demo:up. Then try again.';

/**
 * One demo sign-in at a time, for one signed-out screen. Disposing it (the screen goes away because a session became
 * ready by any route, or the page closes) aborts the request and silences it, so a late answer can neither show
 * anything nor start a session check. It never holds a session itself: after the server accepts, the page's own check
 * decides who is signed in, exactly as after a reload.
 */
export class DemoSignInController {
  readonly #confirm: () => Promise<boolean>;
  readonly #create: (userId: string, signal: AbortSignal) => Promise<void>;
  readonly #onChange: (snapshot: DemoSignInSnapshot) => void;
  #disposed = false;
  #request: AbortController | null = null;

  public constructor(options: DemoSignInControllerOptions) {
    this.#confirm = options.confirm;
    this.#create = options.create;
    this.#onChange = options.onChange;
  }

  public signIn(role: DemoRole): void {
    if (this.#disposed || this.#request !== null) return;
    const request = new AbortController();
    this.#request = request;
    this.#onChange({ failure: null, pending: role });
    void this.#run(role, request);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#request?.abort();
    this.#request = null;
  }

  // Whether an answer to `request` may still change what is shown.
  #current(request: AbortController): boolean {
    return !this.#disposed && this.#request === request;
  }

  async #run(role: DemoRole, request: AbortController): Promise<void> {
    try {
      await this.#create(demoIdentities[role], request.signal);
    } catch (error) {
      if (!this.#current(request)) return;
      this.#request = null;
      this.#onChange({ failure: describeDemoSignInFailure(role, error), pending: null });
      return;
    }
    if (!this.#current(request)) return;
    // Still pending: the buttons stay disabled until the page has asked the server who is signed in.
    const confirmed = await this.#confirm().catch(() => false);
    if (!this.#current(request)) return;
    this.#request = null;
    this.#onChange({ failure: confirmed ? null : notConfirmed, pending: null });
  }
}
