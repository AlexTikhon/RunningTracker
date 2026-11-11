import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ActivityScreen } from './ActivityScreen.js';
import { defaultTimeZone } from './run-search.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const userId = '44444444-4444-4444-8444-444444444444';

describe('ActivityScreen', () => {
  const markup = renderToStaticMarkup(
    <ActivityScreen csrf={{ headerName: 'x-csrf-token', token: 'a'.repeat(43) }} orgId={orgId} signal={new AbortController().signal} userId={userId} />,
  );

  it('is titled Activity and says plainly that only the person can see their activities', () => {
    expect(markup).toContain('<h1 id="activity-title" tabindex="-1">Activity</h1>');
    expect(markup).toMatch(/Only you can see your activities: coaches\s+and other members cannot/u);
  });

  it('offers every field of a manual activity, with the optional ones marked', () => {
    expect(markup).toContain('aria-label="Add an activity"');
    for (const label of ['Type', 'Started', 'Hours', 'Minutes', 'Seconds', 'Distance (optional)', 'Unit', 'Effort (RPE, optional)', 'Notes (optional)']) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('type="datetime-local"');
    expect(markup).toContain('maxLength="1000"');
    for (const type of ['Run', 'Walk', 'Ride', 'Hike', 'Swim', 'Strength', 'Other']) {
      expect(markup).toContain(`>${type}</option>`);
    }
    expect(markup).toContain('<option value="km" selected="">Kilometres</option>');
    expect(markup).toContain('<option value="mi">Miles</option>');
    expect(markup).toContain('<option value="" selected="">Not rated</option>');
    expect(markup).toContain('<option value="10">10</option>');
  });

  it('starts with a ready Save button, no problems listed and empty status regions', () => {
    expect(markup).toMatch(/<button class="primary-action" type="submit">Save activity<\/button>/u);
    expect(markup).not.toContain('Problems with the activity');
    expect(markup).toContain('<p class="activity-form__status" role="status"></p>');
    expect(markup).toContain('<p class="search-panel__notice" role="status"></p>');
    expect(markup).not.toContain('role="alert"');
  });

  it('shows the unified history loading, unfiltered, with the zone it will use (ADR-0087)', () => {
    expect(markup).toContain('<h2 id="activity-history-title">Your activity history</h2>');
    expect(markup).toContain('Loading your activity history…');
    expect(markup).toContain(`Times are shown in ${defaultTimeZone()}`);
    expect(markup).toContain('aria-label="History filters"');
    expect(markup).toContain('<option value="" selected="">All sources</option>');
    expect(markup).toContain('<option value="" selected="">All types</option>');
    expect(markup).toContain('<option value="recorded_run">Recorded run</option>');
    expect(markup).not.toContain('Run details');
  });

  it('offers a GPX import beside the form, and says imports show elapsed time (ADR-0086)', () => {
    expect(markup).toContain('<h2 id="gpx-import-title">Import a GPX file</h2>');
    expect(markup).toContain('type="file"');
    expect(markup).toMatch(/a GPX import shows its elapsed time, pauses included, not moving time/u);
  });

  it('does not put identifiers on the screen', () => {
    expect(markup).not.toContain(orgId);
    expect(markup).not.toContain(userId);
  });
});
