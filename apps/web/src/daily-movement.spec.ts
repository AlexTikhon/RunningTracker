import type { DailyMovementView } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import {
  MOVEMENT_HISTORY_DAYS,
  emptyMovementDraft,
  formatActiveEnergy,
  formatSteps,
  movementDraftFromView,
  movementHistoryDays,
  movementHistoryRange,
  movementSourceLabel,
  summarizeMovement,
  validateMovementDraft,
} from './daily-movement.js';

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

const valid = (steps: string, activeEnergyKcal: string) => {
  const result = validateMovementDraft({ activeEnergyKcal, steps });
  if (!result.ok) throw new Error(result.errors.join(' '));
  return result.values;
};
const errors = (steps: string, activeEnergyKcal: string) => {
  const result = validateMovementDraft({ activeEnergyKcal, steps });
  return result.ok ? [] : result.errors;
};

describe('the movement draft', () => {
  it('turns an empty field into "not recorded" and a typed 0 into a recorded zero', () => {
    expect(valid('0', '')).toEqual({ activeEnergyKcal: null, steps: 0 });
    expect(valid('', '0')).toEqual({ activeEnergyKcal: 0, steps: null });
    expect(valid('', '0,0')).toEqual({ activeEnergyKcal: 0, steps: null });
    expect(valid('8042', '412.5')).toEqual({ activeEnergyKcal: 412.5, steps: 8_042 });
  });

  it('requires at least one value', () => {
    expect(errors('', '')).toEqual(['Enter steps, active energy or both.']);
    expect(errors('  ', ' ')).toEqual(['Enter steps, active energy or both.']);
    expect(validateMovementDraft(emptyMovementDraft).ok).toBe(false);
  });

  it('accepts spaces between digit groups of steps and a comma as the decimal separator of energy', () => {
    expect(valid('8 042', '')).toMatchObject({ steps: 8_042 });
    expect(valid('12 345', '')).toMatchObject({ steps: 12_345 });
    expect(valid('', '412,5')).toMatchObject({ activeEnergyKcal: 412.5 });
  });

  it('bounds steps to whole numbers from 0 to 200,000', () => {
    expect(valid('200000', '')).toMatchObject({ steps: 200_000 });
    for (const text of ['200001', '-1', '1.5', '1,5', '1e3', 'abc', '0x10', '+5']) {
      expect(errors(text, '')).toEqual(['Steps must be a whole number from 0 to 200,000.']);
    }
  });

  it('bounds active energy from 0 to 20,000 kcal with at most one decimal, refusing what it would otherwise round', () => {
    expect(valid('', '20000')).toMatchObject({ activeEnergyKcal: 20_000 });
    expect(valid('', '0.1')).toMatchObject({ activeEnergyKcal: 0.1 });
    for (const text of ['20000.1', '412.55', '-5', '1e3', 'NaN', 'Infinity', '412.', '.5', 'twelve']) {
      expect(errors('', text)).toEqual(['Active energy must be from 0 to 20,000 kcal, with at most one decimal.']);
    }
  });

  it('lists every problem at once, and only valid values become a request', () => {
    expect(errors('x', 'y')).toHaveLength(2);
    expect(validateMovementDraft({ activeEnergyKcal: '412.5', steps: 'x' }).ok).toBe(false);
  });

  it('shows a stored day so that saving it unchanged sends the same values', () => {
    expect(movementDraftFromView(view('2026-11-05'))).toEqual({ activeEnergyKcal: '412.5', steps: '8042' });
    const zero = movementDraftFromView(view('2026-11-05', { activeEnergyKcal: null, steps: 0 }));
    expect(zero).toEqual({ activeEnergyKcal: '', steps: '0' });
    expect(valid(zero.steps, zero.activeEnergyKcal)).toEqual({ activeEnergyKcal: null, steps: 0 });
  });
});

describe('the movement history', () => {
  it('covers the 14 days ending today, across a month end and a DST change', () => {
    expect(MOVEMENT_HISTORY_DAYS).toBe(14);
    expect(movementHistoryRange('2026-11-06')).toEqual({ from: '2026-10-24', to: '2026-11-06' });
    expect(movementHistoryRange('2026-03-31')).toEqual({ from: '2026-03-18', to: '2026-03-31' });
  });

  it('lists every day newest first, the days without a record as empty', () => {
    const days = movementHistoryDays('2026-11-06', [view('2026-11-05'), view('2026-10-24', { steps: 0 })]);
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({ localDate: '2026-11-06', movement: null });
    expect(days[1]?.movement?.localDate).toBe('2026-11-05');
    expect(days[13]?.movement?.steps).toBe(0);
    expect(days.filter((day) => day.movement === null)).toHaveLength(12);
  });

  it('says "Not recorded" for a missing value and shows a recorded zero as zero', () => {
    expect(summarizeMovement(view('2026-11-05'))).toEqual([
      { label: 'Steps', value: '8,042 steps' },
      { label: 'Active energy', value: '412.5 kcal' },
    ]);
    expect(summarizeMovement(view('2026-11-05', { activeEnergyKcal: null, steps: 0 }))).toEqual([
      { label: 'Steps', value: '0 steps' },
      { label: 'Active energy', value: 'Not recorded' },
    ]);
    expect(summarizeMovement(view('2026-11-05', { activeEnergyKcal: 0, steps: null }))).toEqual([
      { label: 'Steps', value: 'Not recorded' },
      { label: 'Active energy', value: '0 kcal' },
    ]);
    expect(formatSteps(1)).toBe('1 step');
    expect(formatActiveEnergy(300)).toBe('300 kcal');
  });

  it('labels the only source as manual entry', () => {
    expect(movementSourceLabel('manual')).toBe('Manually entered');
  });
});
