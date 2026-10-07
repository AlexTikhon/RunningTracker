export const signInPath = '/api/auth/login';

// The API reports a closed set of failure codes in `sign_in_error`; only these are ever shown, so
// the page never reflects text taken from the URL.
const failureMessages: Readonly<Record<string, string>> = {
  denied: 'The identity provider did not confirm your sign-in. Try again.',
  login_expired: 'The sign-in took too long or was started in another browser. Try again.',
  not_provisioned: 'Your account is not set up for this service yet. Ask the organizer to add it.',
  unavailable: 'Sign-in is temporarily unavailable. Try again in a minute.',
};

export function signInFailureMessage(search: string): string | undefined {
  const code = new URLSearchParams(search).get('sign_in_error');
  return code !== null && Object.hasOwn(failureMessages, code) ? failureMessages[code] : undefined;
}

export function SignInNotice({ failure, message }: { failure: string | undefined; message?: string }) {
  return (
    <section className="notice notice--error" {...(failure === undefined ? {} : { role: 'alert' })}>
      <div>
        <strong>Sign in required</strong>
        <span>{failure ?? message ?? 'Sign in with your organization account to record and view runs.'}</span>
      </div>
      {/* A real navigation: the browser must leave for the identity provider. */}
      <a className="button" href={signInPath}>Sign in</a>
    </section>
  );
}
