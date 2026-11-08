import type { DailyMovementView } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { loadingMovementDay, type MovementDaySnapshot, type MovementHistorySnapshot } from './daily-movement-controller.js';
import { emptyMovementDraft, movementHistoryDays, type MovementDraft } from './daily-movement.js';
import { DailyCheckInScreen } from './DailyCheckInScreen.js';
import {
  DailyMovementSection,
  MovementDeletion,
  MovementFormView,
  MovementHistory,
  type MovementDeletionProps,
  type MovementFormViewProps,
} from './DailyMovementSection.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const today = '2026-11-06';
const noop = () => undefined;

const view = (localDate: string, overrides: Partial<DailyMovementView> = {}): DailyMovementView => ({
  activeEnergyKcal: 412.5,
  createdAt: '2026-11-05T08:00:00.000Z',
  localDate,
  source: 'manual',
  steps: 8_042,
  timeZone: 'Europe/Warsaw',
  updatedAt: '2026-11-05T08:00:00.000Z',
  ...overrides,
});

const ready = (existing: DailyMovementView | null, patch: Partial<MovementDaySnapshot> = {}): MovementDaySnapshot => ({
  ...loadingMovementDay(today),
  existing,
  load: 'ready',
  ...patch,
});

function form(day: MovementDaySnapshot, overrides: Partial<MovementFormViewProps> = {}, draft: MovementDraft = emptyMovementDraft) {
  return renderToStaticMarkup(
    <MovementFormView
      confirmingDelete={false}
      dateInput={day.date}
      day={day}
      draft={draft}
      onCancelDelete={noop}
      onChangeDate={noop}
      onChangeDraft={noop}
      onConfirmDelete={noop}
      onRetry={noop}
      onStartDelete={noop}
      onSubmit={noop}
      showErrors={false}
      timeZone="Europe/Warsaw"
      today={today}
      {...overrides}
    />,
  );
}

describe('DailyMovementSection', () => {
  const markup = renderToStaticMarkup(
    <DailyMovementSection
      csrf={{ headerName: 'x-csrf-token', token: 'a'.repeat(43) }}
      orgId={orgId}
      signal={new AbortController().signal}
      timeZone="Europe/Warsaw"
      today={today}
    />,
  );

  it('is a Movement section that says phone and watch synchronization is not connected and that only the person sees it', () => {
    expect(markup).toContain('aria-labelledby="movement-title"');
    expect(markup).toContain('<h2 id="movement-title" tabindex="-1">Movement</h2>');
    expect(markup).toMatch(/Phone and watch synchronization is not connected yet/u);
    expect(markup).toMatch(/Only you can see your movement: coaches and other members cannot/u);
  });

  it('labels the energy field "Active energy (kcal)" and explains what it is not, with no estimate from steps', () => {
    expect(markup).toContain('Steps (optional)');
    expect(markup).toContain('Active energy (kcal)');
    expect(markup).toMatch(/not resting energy, total\s+energy burned or food/u);
    expect(markup).toContain('empty is not recorded, 0 is a value');
    expect(markup).not.toMatch(/estimat/iu);
  });

  it("defaults the date to today, allows dates back to 2000 and none after today, and waits for the day's values", () => {
    expect(markup).toContain('aria-label="Daily movement"');
    expect(markup).toContain(`<input max="${today}" min="2000-01-01" type="date" value="${today}"/>`);
    expect(markup).toContain('Loading this day&#x27;s movement…');
    expect(markup).toMatch(/<button class="primary-action" disabled="" type="submit">Save movement<\/button>/u);
    expect(markup).toContain('Loading your recent movement…');
    expect(markup).not.toContain('Delete movement');
    expect(markup).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });

  it('is part of the Check-in screen, below the check-in history and above the weekly review', () => {
    const screen = renderToStaticMarkup(
      <DailyCheckInScreen
        csrf={{ headerName: 'x-csrf-token', token: 'a'.repeat(43) }}
        nowMs={Date.parse('2026-11-06T09:00:00.000Z')}
        orgId={orgId}
        signal={new AbortController().signal}
      />,
    );
    const checkIn = screen.indexOf('aria-label="Daily check-in"');
    const movement = screen.indexOf('aria-label="Daily movement"');
    const review = screen.indexOf('id="review-title"');
    expect(checkIn).toBeGreaterThan(-1);
    expect(movement).toBeGreaterThan(checkIn);
    expect(review).toBeGreaterThan(movement);
  });
});

describe('MovementFormView states', () => {
  it('shows an empty day', () => {
    const markup = form(ready(null));
    expect(markup).toContain('No movement recorded for Fri, 6 Nov 2026 yet.');
    expect(markup).not.toContain('Source:');
    expect(markup).not.toContain('Delete movement');
    expect(markup).toMatch(/<button class="primary-action" type="submit">Save movement<\/button>/u);
  });

  it('shows a stored day with its explicit manual source, and offers deletion', () => {
    const markup = form(ready(view(today)), {}, { activeEnergyKcal: '412.5', steps: '8042' });
    expect(markup).toContain('Showing what you entered for Fri, 6 Nov 2026. Saving replaces it.');
    expect(markup).toContain('Source: Manually entered');
    expect(markup).toContain('value="8042"');
    expect(markup).toContain('value="412.5"');
    expect(markup).toContain('aria-label="Delete the movement of Fri, 6 Nov 2026"');
  });

  it('lists validation problems only after a save was attempted', () => {
    const invalid = { activeEnergyKcal: '412.55', steps: '-3' };
    expect(form(ready(null), {}, invalid)).not.toContain('Problems with the movement');
    const markup = form(ready(null), { showErrors: true }, invalid);
    expect(markup).toContain('aria-label="Problems with the movement"');
    expect(markup).toContain('Steps must be a whole number from 0 to 200,000.');
    expect(markup).toContain('Active energy must be from 0 to 20,000 kcal, with at most one decimal.');
    expect(form(ready(null), { showErrors: true })).toContain('Enter steps, active energy or both.');
    expect(form(ready(null), { dateInput: '2026-11-07', showErrors: true }, { activeEnergyKcal: '', steps: '0' })).toContain(
      'The date cannot be after today.',
    );
  });

  it('shows a load failure with Retry and keeps the form locked', () => {
    const markup = form({ ...loadingMovementDay(today), load: 'error', loadMessage: "This day's movement could not be loaded." });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('This day&#x27;s movement could not be loaded.');
    expect(markup).toContain('>Retry</button>');
    expect(markup).toMatch(/<button class="primary-action" disabled="" type="submit">Save movement<\/button>/u);
  });

  it('locks the date, the values and both actions while saving', () => {
    const markup = form(ready(view(today), { save: 'pending' }));
    expect(markup).toContain('Saving…');
    expect(markup).toMatch(/<input disabled="" max="2026-11-06" min="2000-01-01" type="date"/u);
    expect(markup.match(/<input[^>]*disabled=""/gu)?.length).toBe(3);
    expect(markup).toMatch(/aria-label="Delete the movement of Fri, 6 Nov 2026" disabled=""/u);
  });

  it('shows the outcome of a save, an uncertain save as a failure, and a confirmed deletion', () => {
    expect(form(ready(view(today), { save: 'saved', saveMessage: 'Movement saved.' }))).toContain('Movement saved.');
    const uncertain = form(ready(null, { save: 'failed', saveMessage: 'The save was not confirmed: the connection failed.', uncertain: true }));
    expect(uncertain).toContain('class="activity-form__failure" role="status">The save was not confirmed');
    expect(form(ready(null, { deletionMessage: 'Movement deleted.' }))).toContain('Movement deleted.');
  });
});

describe('MovementDeletion', () => {
  const render = (props: Partial<MovementDeletionProps> = {}) =>
    renderToStaticMarkup(
      <MovementDeletion
        confirming={false}
        dateLabel="Fri, 6 Nov 2026"
        disabled={false}
        failure={null}
        onCancel={noop}
        onConfirm={noop}
        onStart={noop}
        phase="idle"
        {...props}
      />,
    );

  it('asks first, says the deletion is permanent, and can be cancelled', () => {
    expect(render()).toContain('Delete movement');
    const confirming = render({ confirming: true });
    expect(confirming).toContain('aria-label="Delete the movement of Fri, 6 Nov 2026?"');
    expect(confirming).toContain('removed permanently. This cannot be undone.');
    expect(confirming).toContain('Confirm delete');
    expect(confirming).toContain('Cancel');
  });

  it('locks both buttons while deleting, and shows why the last attempt failed', () => {
    const pending = render({ confirming: true, phase: 'pending' });
    expect(pending).toContain('Deleting…');
    expect(pending.match(/disabled=""/gu)).toHaveLength(2);
    expect(render({ confirming: true, failure: 'The deletion was not confirmed.' })).toContain('The deletion was not confirmed.');
  });
});

describe('MovementHistory', () => {
  const render = (snapshot: MovementHistorySnapshot, selectedDate = today) =>
    renderToStaticMarkup(<MovementHistory disabled={false} onEdit={noop} onRetry={noop} selectedDate={selectedDate} snapshot={snapshot} />);

  it('lists all 14 days newest first, the empty ones as "No movement recorded"', () => {
    const markup = render({ days: movementHistoryDays(today, [view('2026-11-05')]), message: null, status: 'ready' });
    expect(markup).toContain('aria-labelledby="movement-history-title"');
    expect(markup.match(/<li /gu)).toHaveLength(14);
    expect(markup.match(/No movement recorded/gu)).toHaveLength(13);
    const newest = markup.indexOf('dateTime="2026-11-06"');
    expect(newest).toBeGreaterThan(-1);
    expect(newest).toBeLessThan(markup.indexOf('dateTime="2026-11-05"'));
  });

  it('shows recorded values, a recorded zero, "Not recorded" and the manual source', () => {
    const markup = render({
      days: movementHistoryDays(today, [view('2026-11-05', { activeEnergyKcal: null, steps: 0 })]),
      message: null,
      status: 'ready',
    });
    expect(markup).toContain('<dt>Steps</dt><dd>0 steps</dd>');
    expect(markup).toContain('<dt>Active energy</dt><dd>Not recorded</dd>');
    expect(markup).toContain('<dt>Source</dt><dd>Manually entered</dd>');
  });

  it('offers Edit for a recorded day and Add for an empty one, but not for the day already in the form', () => {
    const markup = render({ days: movementHistoryDays(today, [view('2026-11-05')]), message: null, status: 'ready' });
    expect(markup).toContain('aria-label="Edit the movement of Thu, 5 Nov 2026"');
    expect(markup).toContain('aria-label="Add movement for Wed, 4 Nov 2026"');
    expect(markup).toMatch(/aria-label="Add movement for Fri, 6 Nov 2026" disabled=""/u);
  });

  it('shows loading, and a failure with Retry instead of the days', () => {
    expect(render({ days: [], message: null, status: 'loading' })).toContain('Loading your recent movement…');
    const failed = render({ days: [], message: 'Your recent movement could not be loaded.', status: 'error' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('>Retry</button>');
    expect(failed).not.toContain('<li');
  });
});
