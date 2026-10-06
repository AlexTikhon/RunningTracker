import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OrganizationPicker } from './OrganizationPicker.js';
import type { OrganizationsState } from './organization-selection.js';

const orgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const noop = () => undefined;

function render(state: OrganizationsState, selected: string | null, locked = false): string {
  return renderToStaticMarkup(
    <OrganizationPicker locked={locked} onChoose={noop} onRetry={noop} selected={selected} state={state} />,
  );
}

describe('OrganizationPicker', () => {
  it('shows nothing before a session exists', () => {
    expect(render({ status: 'idle' }, null)).toBe('');
  });

  it('says it is loading', () => {
    expect(render({ status: 'loading' }, null)).toContain('Loading your organizations');
  });

  it('shows the single organization as a fact, with no field to fill in or choose from', () => {
    const markup = render({ organizations: [orgA], status: 'ready' }, orgA);

    expect(markup).toContain('aaaaaaaa');
    expect(markup).not.toContain('<select');
    expect(markup).not.toContain('<input');
  });

  it('offers a choice among several, with no choice made yet', () => {
    const markup = render({ organizations: [orgA, orgB], status: 'ready' }, null);

    expect(markup).toContain('<select');
    expect(markup).toContain('Choose an organization');
    expect(markup).toContain(`value="${orgA}"`);
    expect(markup).toContain(`value="${orgB}"`);
    expect(markup).not.toContain('<input');
  });

  it('marks the selected organization and locks switching while a run exists', () => {
    const markup = render({ organizations: [orgA, orgB], status: 'ready' }, orgB, true);

    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Finish and clear the current run');
    expect(markup).not.toContain('Choose an organization');
  });

  it('explains plainly that the account belongs to no organization', () => {
    const markup = render({ organizations: [], status: 'ready' }, null);

    expect(markup).toContain('No organization yet');
    expect(markup).toContain('Ask the organizer');
    expect(markup).not.toContain('<select');
    expect(markup).not.toMatch(/uuid|RLS|membership row/iu);
  });

  it('reports a failed load as an alert with a way to try again', () => {
    const markup = render({ message: 'The server could not be reached.', status: 'error' }, null);

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Try again');
  });
});
