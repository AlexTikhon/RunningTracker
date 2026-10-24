import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DemoSignInSnapshot } from './demo-sign-in.js';
import { DemoSignIn, DemoSignInView } from './DemoSignIn.js';

const idle: DemoSignInSnapshot = { failure: null, pending: null };

function render(snapshot: DemoSignInSnapshot, sessionUnknown = false): string {
  return renderToStaticMarkup(<DemoSignInView onSignIn={() => undefined} sessionUnknown={sessionUnknown} snapshot={snapshot} />);
}

function buttons(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*>[^<]*<\/button>/gu)].map(([button]) => button);
}

describe('DemoSignInView', () => {
  it('offers the two fixed demo people as buttons, and no way to type or pick another identity', () => {
    const markup = render(idle);

    expect(markup).toContain('aria-label="Local demo sign-in"');
    expect(buttons(markup)).toEqual([
      '<button type="button">Demo runner</button>',
      '<button type="button">Demo coach</button>',
    ]);
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<select');
    expect(markup).not.toContain('dddddddd');
    expect(markup).not.toContain('role="alert"');
    // The other role needs another browser profile: tabs share the session cookie.
    expect(markup).toMatch(/private window/u);
  });

  it('disables both buttons while a sign-in is pending and says which one', () => {
    const markup = render({ failure: null, pending: 'coach' });

    expect(buttons(markup)).toEqual([
      '<button disabled="" type="button">Demo runner</button>',
      '<button disabled="" type="button">Demo coach</button>',
    ]);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Signing in as the demo coach…');
  });

  it('shows a failure as an alert with both buttons available again', () => {
    const markup = render({ failure: 'Could not sign in as the demo runner. The server could not be reached.', pending: null });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('The server could not be reached.');
    expect(buttons(markup).every((button) => !button.includes('disabled'))).toBe(true);
  });

  it('waits for an answer about the current session before offering an identity', () => {
    const markup = render(idle, true);

    expect(buttons(markup).every((button) => button.includes('disabled=""'))).toBe(true);
    expect(markup).toContain('Retry session');
  });
});

describe('DemoSignIn', () => {
  it('renders the idle buttons before any effect has run', () => {
    const markup = renderToStaticMarkup(<DemoSignIn onSignedIn={() => Promise.resolve(true)} sessionUnknown={false} />);

    expect(buttons(markup)).toHaveLength(2);
    expect(markup).not.toContain('disabled');
  });
});
