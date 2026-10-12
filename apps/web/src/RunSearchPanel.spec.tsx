import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RunSearchPanel } from './RunSearchPanel.js';
import { defaultTimeZone } from './run-search.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

describe('RunSearchPanel', () => {
  const markup = renderToStaticMarkup(<RunSearchPanel csrf={{ headerName: 'x-csrf-token', token: 'a'.repeat(43) }} orgId={orgId} userId={userId} />);

  it('is titled as the person’s own runs and says how it differs from the map', () => {
    expect(markup).toContain('My runs');
    expect(markup).toMatch(/only runs you recorded/iu);
    expect(markup).toMatch(/map[^.]*shared with you/iu);
  });

  it('starts with the default search loading, the filters editable and the applied filters apart', () => {
    expect(markup).toContain('Searching your runs');
    expect(markup).toContain('Apply filters');
    expect(markup).toContain('Applied filters');
    expect(markup).toContain('This month');
    expect(markup).toContain(defaultTimeZone());
  });

  it('does not put identifiers on the screen', () => {
    expect(markup).not.toContain(orgId);
    expect(markup).not.toContain(userId);
  });

  it('offers describing the search in words above the filters, with the OpenAI disclosure before any send', () => {
    expect(markup).toContain('Describe your search');
    expect(markup).toContain('sent to OpenAI');
    expect(markup).toMatch(/>Interpret</u);
    expect(markup.indexOf('Describe your search')).toBeLessThan(markup.indexOf('Filter my runs'));
  });

  it('keeps the manual filters and the Apply button fully present beside it', () => {
    expect(markup).toContain('Filter my runs');
    expect(markup).toContain('Minimum distance');
    expect(markup).toMatch(/<button[^>]*>Apply filters</u);
  });

  it('never puts the CSRF token on the screen', () => {
    expect(markup).not.toContain('a'.repeat(43));
  });
});
