import type { DailyMetricsView } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { historyDays, localDateIn } from './daily-checkin.js';
import { CheckInDeletion, CheckInHistory, DailyCheckInScreen, type CheckInDeletionProps } from './DailyCheckInScreen.js';
import { defaultTimeZone } from './run-search.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const nowMs = Date.parse('2026-11-06T09:00:00.000Z');

const view = (localDate: string, overrides: Partial<DailyMetricsView> = {}): DailyMetricsView => ({
  createdAt: '2026-11-05T08:00:00.000Z',
  localDate,
  mood: 4,
  note: 'Legs heavy after intervals',
  sleepMinutes: 455,
  sleepQuality: 3,
  soreness: 6,
  timeZone: 'Europe/Warsaw',
  updatedAt: '2026-11-05T08:00:00.000Z',
  weightKg: 72.3,
  ...overrides,
});

describe('DailyCheckInScreen', () => {
  const markup = renderToStaticMarkup(
    <DailyCheckInScreen
      csrf={{ headerName: 'x-csrf-token', token: 'a'.repeat(43) }}
      nowMs={nowMs}
      orgId={orgId}
      signal={new AbortController().signal}
    />,
  );
  const today = localDateIn(defaultTimeZone(), nowMs);

  it('is titled Check-in and says plainly that only the person can see their check-ins', () => {
    expect(markup).toContain('<h1 id="checkin-title" tabindex="-1">Check-in</h1>');
    expect(markup).toMatch(/Only you\s+can see your check-ins: coaches and other members cannot/u);
  });

  it('defaults the date to today in the person\'s zone, allows earlier dates back to 2000 and none after today', () => {
    expect(markup).toContain('aria-label="Daily check-in"');
    expect(markup).toMatch(new RegExp(`<input max="${today}" min="2000-01-01" type="date" value="${today}"/>`, 'u'));
    expect(markup).toContain(`in ${defaultTimeZone()}.`);
  });

  it('offers every value as optional, with the scales and the note limit', () => {
    for (const label of ['Weight in kg (optional)', 'Sleep (optional)', 'Hours', 'Minutes', 'Sleep quality (optional)', 'Mood (optional)', 'Soreness (optional)', 'Note (optional)']) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('maxLength="500"');
    expect(markup).toContain('<option value="5">5 of 5</option>');
    expect(markup).toContain('<option value="0">0 of 10</option>');
    expect(markup).toContain('<option value="10">10 of 10</option>');
    expect(markup.match(/<option value="" selected="">Not rated<\/option>/gu)).toHaveLength(3);
  });

  it('waits for the day to load before the form can be used or saved, with no problems listed', () => {
    expect(markup).toContain('Loading this day…');
    expect(markup).toMatch(/<button class="primary-action" disabled="" type="submit">Save check-in<\/button>/u);
    expect(markup).not.toContain('Problems with the check-in');
    expect(markup).not.toContain('role="alert"');
  });

  it('shows the history loading, and puts no identifiers on the screen', () => {
    expect(markup).toContain('Last 14 days');
    expect(markup).toContain('Loading your recent check-ins…');
    expect(markup).not.toContain(orgId);
  });

  it('offers no deletion before the day is loaded', () => {
    expect(markup).not.toContain('Delete check-in');
  });
});

describe('CheckInDeletion', () => {
  const props: CheckInDeletionProps = {
    confirming: false,
    dateLabel: 'Thu, 5 Nov 2026',
    disabled: false,
    failure: null,
    onCancel: () => undefined,
    onConfirm: () => undefined,
    onStart: () => undefined,
    phase: 'idle',
  };
  const render = (overrides: Partial<CheckInDeletionProps>) => renderToStaticMarkup(<CheckInDeletion {...props} {...overrides} />);

  it('starts as one button naming the day, which asks first and deletes nothing by itself', () => {
    const markup = render({});
    expect(markup).toContain('aria-label="Delete the check-in of Thu, 5 Nov 2026"');
    expect(markup).toContain('>Delete check-in</button>');
    expect(markup).not.toContain('Confirm delete');
    expect(render({ disabled: true })).toMatch(/disabled=""[^>]*>Delete check-in<\/button>/u);
  });

  it('asks for confirmation, says the deletion is permanent, and can be cancelled', () => {
    const markup = render({ confirming: true });
    expect(markup).toContain('aria-label="Delete the check-in of Thu, 5 Nov 2026?"');
    expect(markup).toContain('<h2>Delete this check-in?</h2>');
    expect(markup).toContain('Everything recorded for Thu, 5 Nov 2026 is removed permanently. This cannot be undone.');
    expect(markup).toContain('>Confirm delete</button>');
    expect(markup).toContain('>Cancel</button>');
    expect(markup).not.toContain('role="alert"');
  });

  it('locks both buttons while deleting, and shows why the last attempt failed', () => {
    const pending = render({ confirming: true, phase: 'pending' });
    expect(pending).toMatch(/disabled=""[^>]*>Deleting…<\/button>/u);
    expect(pending).toMatch(/disabled=""[^>]*>Cancel<\/button>/u);
    const failed = render({ confirming: true, failure: 'The deletion was not confirmed: the connection failed. Deleting again is safe.', phase: 'failed' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Deleting again is safe.');
    expect(failed).toContain('>Confirm delete</button>');
  });
});

describe('CheckInHistory', () => {
  const days = historyDays('2026-11-06', [view('2026-11-05'), view('2026-10-24', { mood: null, note: null, sleepMinutes: null, sleepQuality: null, soreness: null, weightKg: 80 })]);
  const markup = renderToStaticMarkup(
    <CheckInHistory
      disabled={false}
      onEdit={() => undefined}
      onRetry={() => undefined}
      selectedDate="2026-11-06"
      snapshot={{ days, message: null, status: 'ready' }}
    />,
  );
  const items = markup.match(/<li [^>]*>.*?<\/li>/gu) ?? [];

  it('lists all 14 days newest first, the empty ones visible as "No check-in"', () => {
    expect(items).toHaveLength(14);
    expect(items[0]).toContain('<time dateTime="2026-11-06">');
    expect(items[13]).toContain('<time dateTime="2026-10-24">');
    expect(markup.match(/No check-in/gu)).toHaveLength(12);
    expect(items[0]).toContain('No check-in');
    expect(items[0]).toContain('aria-current="date"');
  });

  it('shows the recorded values of a day and only those', () => {
    const filled = items[1]!;
    for (const text of ['<dt>Weight</dt><dd>72.3 kg</dd>', '<dt>Sleep</dt><dd>7 h 35 min</dd>', '<dt>Sleep quality</dt><dd>3/5</dd>', '<dt>Mood</dt><dd>4/5</dd>', '<dt>Soreness</dt><dd>6/10</dd>', 'Legs heavy after intervals']) {
      expect(filled).toContain(text);
    }
    const weightOnly = items[13]!;
    expect(weightOnly).toContain('<dd>80 kg</dd>');
    expect(weightOnly).not.toContain('Mood');
    expect(weightOnly).not.toContain('No check-in');
  });

  it('offers Edit for a recorded day and Add for an empty one, and not for the day already in the form', () => {
    expect(items[1]).toMatch(/aria-label="Edit the check-in of [^"]+"[^>]*>Edit<\/button>/u);
    expect(items[2]).toMatch(/aria-label="Add a check-in for [^"]+"[^>]*>Add<\/button>/u);
    expect(items[0]).toMatch(/disabled=""[^>]*>Add<\/button>/u);
  });

  it('shows a failure with a retry instead of the days', () => {
    const failed = renderToStaticMarkup(
      <CheckInHistory disabled={false} onEdit={() => undefined} onRetry={() => undefined} selectedDate="2026-11-06" snapshot={{ days: [], message: 'Could not load.', status: 'error' }} />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Could not load.');
    expect(failed).not.toContain('<li');
  });
});
