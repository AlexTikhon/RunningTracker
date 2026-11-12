import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import { ActivityDeletionController, ActivitySubmissionController } from './activity-controller.js';
import { ActivityHistoryController, noHistoryFilters } from './activity-history-controller.js';
import { ActivityTrendsController } from './activity-trends-controller.js';
import { CheckInDayController, CheckInHistoryController } from './daily-checkin-controller.js';
import { MovementDayController, MovementHistoryController } from './daily-movement-controller.js';
import { DailyOverviewController } from './daily-overview-controller.js';
import { DailyTrendsController } from './daily-trends-controller.js';
import { MealCreateController, MealDeletionController, MealEditController, MealListController } from './meal-log-controller.js';
import { validateMealDraft } from './meal-log.js';
import { WeeklyInsightController } from './weekly-insight-controller.js';
import { WeeklyReviewController } from './weekly-review-controller.js';

// Screens are mounted and unmounted many times within one session, and every controller follows the session's signal
// so that ending the session silences it. Disposing a controller must also take its listener off that signal: the
// session outlives the controller, and a listener left behind keeps the disposed controller, its callbacks and its
// last snapshot reachable until sign-out. Late results staying silent after disposal is covered by each controller's
// own spec; this one counts listeners.

const ORG = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const DAY = '2026-11-05';
const WEEK = '2026-11-02';
const ZONE = 'Europe/Warsaw';
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const noop = (): void => undefined;
const csrf = () => ({ headerName: 'x-csrf-token' as const, token: 'token' });
const mealDetails = (() => {
  const validation = validateMealDraft({ carbohydrateG: '', energyKcal: '', fatG: '', mealType: 'lunch', proteinG: '', title: 'Soup' });
  if (!validation.ok) throw new Error('fixture draft must be valid');
  return validation.details;
})();

interface Disposable {
  dispose(): void;
}

const controllers: Record<string, (signal: AbortSignal) => Disposable> = {
  ActivityDeletionController: (signal) => {
    const controller = new ActivityDeletionController({ activityId: ID, csrf, deleteActivity: never, onChange: noop, onDeleted: noop, orgId: ORG, signal });
    controller.confirm();
    return controller;
  },
  ActivityHistoryController: (signal) => {
    const controller = new ActivityHistoryController({ filters: noHistoryFilters, load: never, onChange: noop, orgId: ORG, signal });
    controller.start();
    return controller;
  },
  ActivitySubmissionController: (signal) =>
    new ActivitySubmissionController({ create: never, csrf, newId: () => ID, newKey: () => ID, onAlreadySaved: noop, onChange: noop, onSaved: noop, orgId: ORG, signal }),
  CheckInDayController: (signal) => {
    const controller = new CheckInDayController({
      csrf, date: DAY, onChange: noop, onDeleted: noop, onLoaded: noop, onSaved: noop, orgId: ORG, read: never, remove: never, signal, timeZone: ZONE, write: never,
    });
    controller.start();
    return controller;
  },
  CheckInHistoryController: (signal) => {
    const controller = new CheckInHistoryController({ load: never, onChange: noop, orgId: ORG, signal, today: DAY });
    controller.start();
    return controller;
  },
  DailyOverviewController: (signal) => {
    const controller = new DailyOverviewController({ localDate: DAY, onChange: noop, orgId: ORG, read: never, signal, timeZone: ZONE });
    controller.start();
    return controller;
  },
  DailyTrendsController: (signal) => {
    const controller = new DailyTrendsController({ endDate: DAY, onChange: noop, orgId: ORG, read: never, signal, timeZone: ZONE });
    controller.start();
    return controller;
  },
  ActivityTrendsController: (signal) => {
    const controller = new ActivityTrendsController({
      filters: { endDate: DAY, source: 'manual', type: 'ride' },
      onChange: noop,
      orgId: ORG,
      read: never,
      signal,
      timeZone: ZONE,
    });
    controller.start();
    return controller;
  },
  MealCreateController: (signal) => {
    const controller = new MealCreateController({
      create: never, csrf, newKey: () => ID, onAlreadySaved: noop, onChange: noop, onSaved: noop, orgId: ORG, signal, timeZone: ZONE,
    });
    controller.submit(DAY, mealDetails);
    return controller;
  },
  MealDeletionController: (signal) => {
    const controller = new MealDeletionController({ csrf, mealId: ID, onChange: noop, onDeleted: noop, orgId: ORG, remove: never, signal });
    controller.confirm();
    return controller;
  },
  MealEditController: (signal) => {
    const controller = new MealEditController({ csrf, mealId: ID, onChange: noop, onSaved: noop, orgId: ORG, signal, update: never });
    controller.submit(mealDetails);
    return controller;
  },
  MealListController: (signal) => {
    const controller = new MealListController({ load: never, localDate: DAY, onChange: noop, orgId: ORG, signal });
    controller.start();
    return controller;
  },
  MovementDayController: (signal) => {
    const controller = new MovementDayController({
      csrf, date: DAY, onChange: noop, onDeleted: noop, onLoaded: noop, onSaved: noop, orgId: ORG, read: never, remove: never, signal, timeZone: ZONE, write: never,
    });
    controller.start();
    return controller;
  },
  MovementHistoryController: (signal) => {
    const controller = new MovementHistoryController({ load: never, onChange: noop, orgId: ORG, signal, today: DAY });
    controller.start();
    return controller;
  },
  WeeklyInsightController: (signal) => {
    const controller = new WeeklyInsightController({ csrf, onChange: noop, orgId: ORG, read: never, request: never, signal, timeZone: ZONE, weekStart: WEEK });
    controller.start();
    return controller;
  },
  WeeklyReviewController: (signal) => {
    const controller = new WeeklyReviewController({ onChange: noop, orgId: ORG, read: never, signal, timeZone: ZONE, weekStart: WEEK });
    controller.start();
    return controller;
  },
};

describe('controller disposal releases the session subscription', () => {
  it.each(Object.keys(controllers))('%s: 100 start/dispose cycles under one live session leave no abort listener behind', (name) => {
    const create = controllers[name]!;
    const session = new AbortController();
    const baseline = getEventListeners(session.signal, 'abort').length;

    for (let index = 0; index < 100; index += 1) {
      const controller = create(session.signal);
      expect(getEventListeners(session.signal, 'abort').length).toBe(baseline + 1);
      controller.dispose();
      controller.dispose(); // idempotent
      expect(getEventListeners(session.signal, 'abort').length).toBe(baseline);
    }
    // A live controller still follows the session and is disposed when it ends.
    const live = create(session.signal);
    session.abort();
    expect(getEventListeners(session.signal, 'abort').length).toBe(0);
    live.dispose();
  });

  it.each(Object.keys(controllers))('%s: created under an ended session, it adds no listener', (name) => {
    const session = new AbortController();
    session.abort();
    controllers[name]!(session.signal).dispose();
    expect(getEventListeners(session.signal, 'abort').length).toBe(0);
  });
});
