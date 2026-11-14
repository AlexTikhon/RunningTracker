import type { MealView } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { idleMealSave, loadingMealList, type MealListSnapshot } from './meal-log-controller.js';
import { emptyMealDraft } from './meal-log.js';
import { MealLogScreen, MealLogView, type MealLogHandlers, type MealLogViewProps } from './MealLogScreen.js';

const DAY = '2026-11-05';
const TODAY = '2026-11-08';
const noop = () => undefined;
const handlers: MealLogHandlers = {
  askDelete: noop,
  cancelDelete: noop,
  cancelEdit: noop,
  chooseDate: noop,
  confirmDelete: noop,
  edit: noop,
  goToToday: noop,
  loadMore: noop,
  retryList: noop,
  startNew: noop,
  submit: noop,
  update: noop,
};

const entry: MealView = {
  carbohydrateG: null,
  createdAt: '2026-11-05T08:00:00.000Z',
  energyKcal: 410.5,
  fatG: 0,
  localDate: DAY,
  mealId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  mealType: 'lunch',
  proteinG: null,
  source: 'manual',
  timeZone: 'Europe/Warsaw',
  title: 'Lentil soup',
  updatedAt: '2026-11-05T08:00:00.000Z',
};
const readyList = (patch: Partial<MealListSnapshot> = {}): MealListSnapshot => ({ ...loadingMealList(DAY), status: 'ready', ...patch });

function props(patch: Partial<MealLogViewProps> = {}): MealLogViewProps {
  return {
    busy: false,
    dateInput: DAY,
    deletion: null,
    draft: emptyMealDraft,
    editing: null,
    errors: null,
    handlers,
    list: readyList(),
    notice: null,
    repeatsUncertain: false,
    save: idleMealSave,
    timeZone: 'Europe/Warsaw',
    today: TODAY,
    ...patch,
  };
}

const render = (patch: Partial<MealLogViewProps> = {}) => renderToStaticMarkup(<MealLogView {...props(patch)} />);

describe('Meal log view (ADR-0083)', () => {
  it('shows the date, a form with type, title and four optional values with units, and the manual source', () => {
    const html = render();
    expect(html).toContain('<h1 id="meal-log-title" tabindex="-1">Meal log</h1>');
    expect(html).toContain('Showing <strong>Thu, 5 Nov 2026</strong>. New entries are saved in the time zone Europe/Warsaw.');
    expect(html).toContain('max="2026-11-08" min="2000-01-01" type="date" value="2026-11-05"');
    expect(html).toContain('Add an entry for Thu, 5 Nov 2026');
    for (const label of ['Meal type', 'Title', 'Food energy (kcal)', 'Protein (g)', 'Carbohydrate (g)', 'Fat (g)']) expect(html).toContain(label);
    for (const option of ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Other']) expect(html).toContain(`>${option}</option>`);
    expect(html).toContain('Nutrition for the whole entry (optional)');
    expect(html).toContain('Empty means not recorded (unknown); 0 means none.');
    expect(html).toContain('Source: <span class="review-badge">Manually entered</span>');
    expect(html).toContain('<button class="primary-action" type="submit">Add entry</button>');
    expect(html).not.toContain('Back to Today');
  });

  it('shows loading, empty, and failure with Retry for the list', () => {
    expect(render({ list: loadingMealList(DAY) })).toContain('Loading your entries for Thu, 5 Nov 2026…');
    expect(render({ list: loadingMealList(DAY) })).toContain('aria-busy="true" data-meal-list-state="loading"');
    expect(render()).toContain('Nothing is logged for Thu, 5 Nov 2026 yet.');
    const failed = render({ list: { ...loadingMealList(DAY), message: 'The connection failed.', status: 'error' } });
    expect(failed).toContain('role="alert"><span>The connection failed.</span><button type="button">Retry</button>');
  });

  it('lists entries with their type, title, values (unknown as not recorded, zero as zero), the source and actions', () => {
    const html = render({ list: readyList({ hasMore: true, items: [entry] }) });
    expect(html).toContain('<h3>Lentil soup</h3>');
    expect(html).toContain('<p class="eyebrow">Lunch</p>');
    expect(html).toContain('<div><dt>Food energy</dt><dd>410.5 kcal</dd></div>');
    expect(html).toContain('<div class="today-rows__missing"><dt>Protein</dt><dd>Not recorded</dd></div>');
    expect(html).toContain('<div><dt>Fat</dt><dd>0 g</dd></div>');
    expect(html).toContain('<span class="review-badge">Manually entered</span>');
    expect(html).toContain('aria-label="Edit lunch &quot;Lentil soup&quot;"');
    expect(html).toContain('aria-label="Delete lunch &quot;Lentil soup&quot;"');
    expect(html).toContain('>Load more</button>');
  });

  it('shows validation problems, the saving state and the failure message', () => {
    expect(render({ errors: ['Enter a short title, for example "Porridge with berries".'] })).toContain('aria-label="Problems with the entry"');
    const saving = render({ busy: true, save: { message: null, phase: 'pending', uncertain: false } });
    expect(saving).toContain('<button class="primary-action" disabled="" type="submit">Saving…</button>');
    const failed = render({ save: { message: 'The entry was not saved: No.', phase: 'failed', uncertain: false } });
    expect(failed).toContain('<p class="activity-form__failure" role="status">The entry was not saved: No.</p>');
  });

  it('warns after an uncertain save only when changed details would be sent, and offers a new entry when the earlier save went through', () => {
    const uncertain = { message: 'The save was not confirmed.', phase: 'failed' as const, uncertain: true };
    expect(render({ repeatsUncertain: false, save: uncertain })).toContain('Your previous save may already have gone through.');
    expect(render({ repeatsUncertain: true, save: uncertain })).not.toContain('Your previous save may already have gone through.');
    const already = render({ save: { message: 'Your earlier save went through, so these changed details were not saved.', phase: 'already-saved', uncertain: false } });
    expect(already).toContain('role="alert"><p>Your earlier save went through, so these changed details were not saved.</p><button type="button">Start a new entry</button>');
    expect(already).toContain('<button class="primary-action" disabled="" type="submit">Add entry</button>');
  });

  it('edits one entry in the same form, and confirms a deletion before sending it', () => {
    const editing = render({ editing: entry, list: readyList({ items: [entry] }) });
    expect(editing).toContain('Edit &quot;Lentil soup&quot;');
    expect(editing).toContain('>Save changes</button>');
    expect(editing).toContain('>Cancel edit</button>');
    expect(editing).toContain(' Editing now.');
    const confirming = render({ deletion: { mealId: entry.mealId, snapshot: { message: null, phase: 'confirming' } }, list: readyList({ items: [entry] }) });
    expect(confirming).toContain('<h4>Delete this entry?</h4>');
    expect(confirming).toContain('It is removed permanently. This cannot be undone.');
    expect(confirming).toContain('>Confirm delete</button>');
  });

  it('while a mutation is in flight, keeps the date, the edited entry and the other entries fixed (ADR-0083)', () => {
    const other: MealView = { ...entry, mealId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', title: 'Toast' };
    const busy = render({
      busy: true,
      editing: entry,
      list: readyList({ items: [entry, other] }),
      save: { message: null, phase: 'pending', uncertain: false },
    });
    expect(busy).toMatch(/<input disabled="" max="2026-11-08" min="[^"]+" type="date" value="2026-11-05"/u);
    expect(busy).toContain('<button disabled="" type="button">Go to today</button>');
    expect(busy).toContain('<button disabled="" type="button">Cancel edit</button>');
    expect(busy).toContain('<button aria-label="Edit lunch &quot;Toast&quot;" disabled="" type="button">Edit</button>');
    expect(busy).toContain('<button aria-label="Delete lunch &quot;Toast&quot;" disabled="" type="button">Delete</button>');
    const settled = render({ busy: false, editing: entry, list: readyList({ items: [entry, other] }) });
    expect(settled).toContain('<button aria-label="Edit lunch &quot;Toast&quot;" type="button">Edit</button>');
    expect(settled).not.toMatch(/<input disabled=""[^>]*type="date"/u);
  });

  it('refuses a date after today and offers Back to Today on the date shown', () => {
    const late = render({ dateInput: '2026-11-09' });
    expect(late).toContain('The date cannot be after today.');
    expect(late).toContain('<button class="primary-action" disabled="" type="submit">Add entry</button>');
    const back = vi.fn();
    const element = MealLogView(props({ handlers: { ...handlers, backToToday: back } }));
    expect(renderToStaticMarkup(element)).toContain('>Back to Today</button>');
  });

  it('never estimates, judges or advises', () => {
    const html = render({ list: readyList({ items: [entry] }) });
    expect(html).not.toMatch(/\b(goal|target|should|healthy|unhealthy|recommend|deficit|surplus|balance|allowance|estimated (as|at))\b/iu);
  });
});

describe('Meal log screen', () => {
  it('opens on the date Today asked for, or on today when none is given or it is in the future', () => {
    const signal = new AbortController().signal;
    const api = { create: vi.fn(), list: vi.fn(), propose: vi.fn(), remove: vi.fn(), update: vi.fn() };
    const nowMs = Date.parse('2026-11-08T10:00:00Z');
    const csrf = { headerName: 'x-csrf-token' as const, token: 't' };
    const screen = (initialDate: string | null) =>
      renderToStaticMarkup(<MealLogScreen api={api} csrf={csrf} initialDate={initialDate} nowMs={nowMs} orgId="org" signal={signal} timeZone="Europe/Warsaw" />);
    expect(screen(DAY)).toContain('value="2026-11-05"');
    expect(screen(null)).toContain('value="2026-11-08"');
    expect(screen('2026-11-09')).toContain('value="2026-11-08"');
    expect(screen('1999-12-31')).toContain('value="2026-11-08"');
    // Server rendering runs no effect: nothing is read or written before the screen mounts.
    expect(api.list).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.propose).not.toHaveBeenCalled();
  });
});
