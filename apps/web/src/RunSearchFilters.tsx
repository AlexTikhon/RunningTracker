import type { DistanceUnit, RunSearchSort } from '@running-tracker/contracts';
import type { FormEvent } from 'react';

import type { PeriodDraft, RunSearchDraft } from './run-search.js';

export interface RunSearchFiltersProps {
  // The editable fields differ from what was last applied.
  dirty: boolean;
  draft: RunSearchDraft;
  errors: string[];
  onApply: () => void;
  onChange: (draft: RunSearchDraft) => void;
  timeZone: string;
}

type PeriodChoice = 'dates' | 'previous-month' | 'this-month';

function choiceOf(period: PeriodDraft): PeriodChoice {
  return period.kind === 'dates' ? 'dates' : period.preset;
}

function periodFor(choice: PeriodChoice, current: PeriodDraft): PeriodDraft {
  if (choice === 'dates') {
    return current.kind === 'dates' ? current : { fromDate: '', kind: 'dates', toDate: '' };
  }
  return { kind: 'preset', preset: choice };
}

// The editable draft. Nothing typed here reaches the results until it is applied, and there is no field for a
// person or an organization: the search is always the signed-in person's own runs.
export function RunSearchFilters({ dirty, draft, errors, onApply, onChange, timeZone }: RunSearchFiltersProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (errors.length === 0) {
      onApply();
    }
  };

  const dates = draft.period.kind === 'dates' ? draft.period : null;

  return (
    <form aria-label="Filter my runs" className="search-filters" onSubmit={submit}>
      <label>
        Period
        <select
          onChange={(event) =>
            onChange({ ...draft, period: periodFor(event.target.value as PeriodChoice, draft.period) })
          }
          value={choiceOf(draft.period)}
        >
          <option value="this-month">This month</option>
          <option value="previous-month">Previous month</option>
          <option value="dates">Custom dates</option>
        </select>
      </label>
      {dates !== null && (
        <>
          <label>
            From
            <input
              onChange={(event) =>
                onChange({ ...draft, period: { ...dates, fromDate: event.target.value } })
              }
              type="date"
              value={dates.fromDate}
            />
          </label>
          <label>
            To (included)
            <input
              onChange={(event) =>
                onChange({ ...draft, period: { ...dates, toDate: event.target.value } })
              }
              type="date"
              value={dates.toDate}
            />
          </label>
        </>
      )}
      <label>
        Minimum distance
        <input
          inputMode="decimal"
          onChange={(event) => onChange({ ...draft, minDistance: event.target.value })}
          placeholder="any"
          type="text"
          value={draft.minDistance}
        />
      </label>
      <label>
        Maximum distance
        <input
          inputMode="decimal"
          onChange={(event) => onChange({ ...draft, maxDistance: event.target.value })}
          placeholder="any"
          type="text"
          value={draft.maxDistance}
        />
      </label>
      <label>
        Units
        <select
          onChange={(event) => onChange({ ...draft, unit: event.target.value as DistanceUnit })}
          value={draft.unit}
        >
          <option value="km">Kilometres</option>
          <option value="mi">Miles</option>
        </select>
      </label>
      <label>
        Sort
        <select
          onChange={(event) => onChange({ ...draft, sort: event.target.value as RunSearchSort })}
          value={draft.sort}
        >
          <option value="newest">Newest first</option>
          <option value="longest">Longest first</option>
          <option value="shortest">Shortest first</option>
        </select>
      </label>
      <button disabled={errors.length > 0} type="submit">
        Apply filters
      </button>
      <p className="search-filters__zone">
        Dates and times use your time zone: <strong>{timeZone}</strong>.
        {dirty && errors.length === 0 && <span> Changes are not applied yet.</span>}
      </p>
      {errors.length > 0 && (
        <ul className="search-filters__errors" role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
    </form>
  );
}
