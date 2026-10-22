import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { RunSharingSnapshot } from './run-sharing.js';
import { RunShareView } from './RunSharePanel.js';

const coachA = 'cccccccc-cccc-4ccc-8ccc-cccccccc0001';
const coachB = 'cccccccc-cccc-4ccc-8ccc-cccccccc0002';
const member = 'dddddddd-dddd-4ddd-8ddd-dddddddd0009';

function render(snapshot: RunSharingSnapshot): string {
  const noop = () => undefined;
  return renderToStaticMarkup(<RunShareView onGrant={noop} onRetry={noop} onRevoke={noop} snapshot={snapshot} />);
}

const ready: RunSharingSnapshot = {
  message: null,
  pending: null,
  rows: [
    { access: 'none', kind: 'coach', userId: coachA },
    { access: 'live', kind: 'coach', userId: coachB },
    { access: 'both', kind: 'member', userId: member },
  ],
  status: 'ready',
  truncated: false,
};

describe('RunShareView', () => {
  it('says plainly that Share grants live and history access, in every state', () => {
    for (const status of ['loading', 'ready', 'error'] as const) {
      const html = render({ ...ready, status });
      expect(html).toContain('Share gives the coach <strong>live and history access</strong>');
    }
  });

  it('shows each person with the exact access the server reports and the actions that fit it', () => {
    const html = render(ready);

    expect(html).toContain('Coach …cccc0001');
    expect(html).toContain(`title="${coachA}"`);
    expect(html).toContain('Not shared');
    expect(html).toContain('aria-label="Share with Coach …cccc0001"');
    // A partial grant is shown as it is, and can be completed or removed.
    expect(html).toContain('Live only');
    expect(html).toContain('aria-label="Share live and history with Coach …cccc0002"');
    expect(html).toContain('aria-label="Revoke Coach …cccc0002"');
    // Someone who is not a listed coach can only lose the share.
    expect(html).toContain('Member …dddd0009');
    expect(html).toContain('aria-label="Revoke Member …dddd0009"');
    expect(html).not.toContain('with Member');
  });

  it('disables every action while a change is open and names the one in progress', () => {
    const html = render({ ...ready, pending: { change: 'grant', userId: coachA } });

    expect(html).toContain('Sharing…');
    // Share; Share live and history and Revoke; Revoke.
    expect(html.match(/<button/gu)).toHaveLength(4);
    expect(html.match(/<button[^>]*disabled/gu)).toHaveLength(4);
  });

  it('shows the load state and a failure with Retry, and no rows when the shares are unknown', () => {
    expect(render({ ...ready, rows: [], status: 'loading' })).toContain('Loading coaches and current sharing');

    const failed = render({ ...ready, message: 'The current sharing could not be read: x', rows: [], status: 'error' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('The current sharing could not be read: x');
    expect(failed).toContain('>Retry<');
    expect(failed).not.toContain('Not shared');
  });

  it('keeps the rows after a change that was not confirmed, with the reason', () => {
    const html = render({ ...ready, message: 'Revoking was not confirmed: gone.' });

    expect(html).toContain('Revoking was not confirmed: gone.');
    expect(html).toContain('Coach …cccc0001');
  });

  it('says when there is no other coach, and when the list was cut', () => {
    expect(render({ ...ready, rows: [] })).toContain('No other active coach in this organization');
    expect(render({ ...ready, truncated: true })).toContain('only the first 100 are listed');
  });
});
