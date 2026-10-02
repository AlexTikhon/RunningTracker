import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SignInNotice, signInFailureMessage, signInPath } from './sign-in.js';

describe('signInFailureMessage', () => {
  it('describes each failure the API reports', () => {
    expect(signInFailureMessage('?sign_in_error=denied')).toContain('did not confirm');
    expect(signInFailureMessage('?sign_in_error=login_expired')).toContain('Try again');
    expect(signInFailureMessage('?sign_in_error=not_provisioned')).toContain('not set up');
    expect(signInFailureMessage('?sign_in_error=unavailable')).toContain('temporarily unavailable');
  });

  it('says nothing without a failure, and never reflects an unknown value', () => {
    expect(signInFailureMessage('')).toBeUndefined();
    expect(signInFailureMessage('?other=1')).toBeUndefined();
    expect(signInFailureMessage('?sign_in_error=%3Cscript%3Ealert(1)%3C%2Fscript%3E')).toBeUndefined();
  });
});

describe('SignInNotice', () => {
  it('links to the API login route as a normal navigation', () => {
    const markup = renderToStaticMarkup(<SignInNotice failure={undefined} />);

    expect(signInPath).toBe('/api/auth/login');
    expect(markup).toContain(`href="${signInPath}"`);
    expect(markup).toContain('Sign in');
    expect(markup).not.toContain('role="alert"');
  });

  it('shows the failure as an alert', () => {
    const markup = renderToStaticMarkup(
      <SignInNotice failure="Your account is not set up for this service yet." />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Your account is not set up for this service yet.');
  });
});
