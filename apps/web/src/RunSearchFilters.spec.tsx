import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RunSearchFilters } from './RunSearchFilters.js';
import { defaultDraft, type RunSearchDraft } from './run-search.js';

const noop = () => undefined;

function render(
  patch: { dirty?: boolean; draft?: RunSearchDraft; errors?: string[]; timeZone?: string } = {},
): string {
  return renderToStaticMarkup(
    <RunSearchFilters
      dirty={patch.dirty ?? false}
      draft={patch.draft ?? defaultDraft()}
      errors={patch.errors ?? []}
      onApply={noop}
      onChange={noop}
      timeZone={patch.timeZone ?? 'Europe/Warsaw'}
    />,
  );
}

describe('RunSearchFilters', () => {
  it('offers the period presets, distance bounds, units and sorting', () => {
    const markup = render();
    for (const text of [
      'This month',
      'Previous month',
      'Custom dates',
      'Minimum distance',
      'Maximum distance',
      'Kilometres',
      'Miles',
      'Newest first',
      'Longest first',
      'Shortest first',
      'Apply filters',
    ]) {
      expect(markup).toContain(text);
    }
  });

  it('shows the time zone that dates and times use', () => {
    expect(render({ timeZone: 'America/New_York' })).toContain('America/New_York');
  });

  it('asks for dates only when the period is custom', () => {
    expect(render()).not.toContain('type="date"');
    const custom = render({
      draft: { ...defaultDraft(), period: { fromDate: '2026-10-01', kind: 'dates', toDate: '2026-10-31' } },
    });
    expect(custom.match(/type="date"/gu)).toHaveLength(2);
    expect(custom).toContain('value="2026-10-01"');
    expect(custom).toContain('value="2026-10-31"');
  });

  it('reflects the draft values', () => {
    const markup = render({
      draft: { ...defaultDraft(), maxDistance: '10', minDistance: '5', sort: 'shortest', unit: 'mi' },
    });
    expect(markup).toContain('value="5"');
    expect(markup).toContain('value="10"');
    expect(markup).toMatch(/<option value="mi" selected/u);
    expect(markup).toMatch(/<option value="shortest" selected/u);
  });

  it('lists problems and does not allow applying them', () => {
    const markup = render({ errors: ['The minimum distance must not exceed the maximum distance.'] });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('The minimum distance must not exceed');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Apply filters/u);
  });

  it('says that edits are not applied yet, and not otherwise', () => {
    expect(render({ dirty: true })).toContain('not applied yet');
    expect(render({ dirty: false })).not.toContain('not applied yet');
  });

  it('has no field for an owner or a person', () => {
    expect(render()).not.toMatch(/user|owner|person id|organization/iu);
  });
});
