import {
  DAILY_MOVEMENT_ACTIVE_ENERGY_MAX_KCAL,
  DAILY_MOVEMENT_STEPS_MAX,
  addLocalDays,
  putDailyMovementRequestSchema,
  type DailyMovementSource,
  type DailyMovementView,
  type PutDailyMovementRequest,
} from '@running-tracker/contracts';

// The Movement section of the Check-in tab (ADR-0078). Every field is the text the person typed; only a valid draft
// becomes a request. The server checks the same rules again and is the authority, also for "not after today".
//
// Empty and zero are different: an empty field is "not recorded" (null), "0" is a recorded zero. Nothing is derived:
// active energy is what the person enters, never estimated from steps.

export const MOVEMENT_HISTORY_DAYS = 14;

export interface MovementDraft {
  // kcal, '.' or ',' as the decimal separator, at most one decimal.
  activeEnergyKcal: string;
  // A whole number; spaces between digit groups are allowed ("8 042").
  steps: string;
}

/** Both values of a day, each present (null for "not recorded"). The zone is added when it is sent. */
export type MovementValues = Required<Omit<PutDailyMovementRequest, 'timeZone'>>;

export type MovementValidation = { errors: string[]; ok: false } | { ok: true; values: MovementValues };

export const emptyMovementDraft: MovementDraft = { activeEnergyKcal: '', steps: '' };

const stepsPattern = /^\d{1,6}$/u;
const energyPattern = /^\d{1,5}(?:[.,]\d)?$/u;
const grouping = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export function validateMovementDraft(draft: MovementDraft): MovementValidation {
  const errors: string[] = [];

  let steps: number | null = null;
  const stepsText = draft.steps.replace(/[\s\u00a0\u202f]/gu, '');
  if (stepsText !== '') {
    const parsed = stepsPattern.test(stepsText) ? Number(stepsText) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed > DAILY_MOVEMENT_STEPS_MAX) {
      errors.push(`Steps must be a whole number from 0 to ${grouping.format(DAILY_MOVEMENT_STEPS_MAX)}.`);
    } else {
      steps = parsed;
    }
  }

  let activeEnergyKcal: number | null = null;
  const energyText = draft.activeEnergyKcal.trim();
  if (energyText !== '') {
    const parsed = energyPattern.test(energyText) ? Number(energyText.replace(',', '.')) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed > DAILY_MOVEMENT_ACTIVE_ENERGY_MAX_KCAL) {
      errors.push(
        `Active energy must be from 0 to ${grouping.format(DAILY_MOVEMENT_ACTIVE_ENERGY_MAX_KCAL)} kcal, with at most one decimal.`,
      );
    } else {
      activeEnergyKcal = parsed;
    }
  }

  const values: MovementValues = { activeEnergyKcal, steps };
  if (errors.length === 0 && steps === null && activeEnergyKcal === null) {
    errors.push('Enter steps, active energy or both.');
  }
  if (errors.length > 0) return { errors, ok: false };
  // The contract is the authority: anything it refuses is shown rather than sent.
  const checked = putDailyMovementRequestSchema.safeParse({ ...values, timeZone: 'UTC' });
  if (!checked.success) return { errors: ['Check the values and try again.'], ok: false };
  return { ok: true, values };
}

/** The draft that shows a stored day, so saving it unchanged sends the same values again. */
export function movementDraftFromView(view: DailyMovementView): MovementDraft {
  return {
    activeEnergyKcal: view.activeEnergyKcal === null ? '' : String(view.activeEnergyKcal),
    steps: view.steps === null ? '' : String(view.steps),
  };
}

export interface MovementHistoryDay {
  localDate: string;
  movement: DailyMovementView | null;
}

/** The first and last date of the history window ending today. */
export function movementHistoryRange(today: string, count: number = MOVEMENT_HISTORY_DAYS): { from: string; to: string } {
  return { from: addLocalDays(today, -(count - 1)), to: today };
}

/** Every day of the window, newest first, the days without a record included as empty. */
export function movementHistoryDays(
  today: string,
  items: readonly DailyMovementView[],
  count: number = MOVEMENT_HISTORY_DAYS,
): MovementHistoryDay[] {
  const byDate = new Map(items.map((item) => [item.localDate, item]));
  return Array.from({ length: count }, (_, index) => {
    const localDate = addLocalDays(today, -index);
    return { localDate, movement: byDate.get(localDate) ?? null };
  });
}

export function formatSteps(steps: number): string {
  return `${grouping.format(steps)} ${steps === 1 ? 'step' : 'steps'}`;
}

export function formatActiveEnergy(kcal: number): string {
  // A stored value has at most one decimal, so the shortest spelling is exact (412.5, 0, 300).
  return `${String(kcal)} kcal`;
}

const sourceLabels: Record<DailyMovementSource, string> = { manual: 'Manually entered' };

export function movementSourceLabel(source: DailyMovementSource): string {
  return sourceLabels[source];
}

/**
 * The values of a day as short labelled pieces. A value that was not recorded is said to be so, never shown as zero.
 */
export function summarizeMovement(view: DailyMovementView): Array<{ label: string; value: string }> {
  return [
    { label: 'Steps', value: view.steps === null ? 'Not recorded' : formatSteps(view.steps) },
    { label: 'Active energy', value: view.activeEnergyKcal === null ? 'Not recorded' : formatActiveEnergy(view.activeEnergyKcal) },
  ];
}
