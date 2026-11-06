import type { ActivityView } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ActivityAlreadySaved, type SavedActivityView } from './ActivityAlreadySaved.js';

const savedId = 'ad000000-0000-4000-8000-000000000100';
const activity: ActivityView = {
  activityId: savedId,
  createdAt: '2026-10-05T08:00:00.000Z',
  distanceM: 32_500,
  durationS: 4_500,
  notes: 'Hilly loop',
  rpe: 6,
  source: 'manual',
  startedAt: '2026-10-05T05:30:00.000Z',
  type: 'ride',
};

function render(view: SavedActivityView, savedActivityId: string | null = savedId): string {
  return renderToStaticMarkup(
    <ActivityAlreadySaved
      onOpen={() => undefined}
      onStartNew={() => undefined}
      savedActivityId={savedActivityId}
      timeZone="Europe/Warsaw"
      unit="km"
      view={view}
    />,
  );
}

describe('ActivityAlreadySaved (409 ACTIVITY_ALREADY_SAVED)', () => {
  it('tells the person the earlier save went through and the changed details were not saved, as an alert', () => {
    const markup = render({ status: 'closed' });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Your earlier save went through"');
    expect(markup).toContain('<strong>Your earlier save went through.</strong>');
    expect(markup).toMatch(/changed details you just tried to save were not saved, so\s+nothing was duplicated/u);
    expect(markup).toMatch(/delete it from your list and save it again/u);
  });

  it('offers to open the saved activity and to start a new one', () => {
    const markup = render({ status: 'closed' });
    expect(markup).toContain('<button type="button">Open saved activity</button>');
    expect(markup).toContain('<button class="primary-action" type="button">Start a new activity</button>');
  });

  it('shows the saved activity once opened, without the open button', () => {
    const markup = render({ activity, status: 'ready' });
    for (const text of ['Ride', '5 Oct 2026, 07:30', '1:15:00', '32.50 km', '6/10', 'Hilly loop']) {
      expect(markup).toContain(text);
    }
    expect(markup).not.toContain('Open saved activity');
    expect(markup).toContain('Start a new activity');
  });

  it('disables the open button while loading, and says why opening failed', () => {
    expect(render({ status: 'loading' })).toContain('<button disabled="" type="button">Open saved activity</button>');
    expect(render({ message: 'The saved activity could not be opened.', status: 'error' })).toContain(
      'The saved activity could not be opened.',
    );
  });

  it('points to the list when the server did not name the activity', () => {
    const markup = render({ status: 'closed' }, null);
    expect(markup).not.toContain('Open saved activity');
    expect(markup).toContain('It is in your list of activities below.');
  });

  it('puts no identifier on the screen', () => {
    expect(render({ activity, status: 'ready' })).not.toContain(savedId);
  });
});
