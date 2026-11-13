import {
  ACTIVITY_TYPES,
  type ActivityHistorySource,
  type ActivityTrends,
  type ActivityTrendsComparisonReason,
  type ActivityType,
} from '@running-tracker/contracts';

import { activityTypeLabels } from './activity-form.js';
import { formatCheckInDate } from './daily-checkin.js';
import { formatDistance, formatDuration } from './run-search.js';

// Presentation of the Activity section of Trends (ADR-0089). Pure functions: every sentence, label and chart coordinate
// comes from here, so each state can be tested without a DOM. Three states stay apart everywhere: no entries ("None
// logged"), entries whose value is unknown ("Unknown"), and a recorded zero (shown as 0). Zero entries is never described
// as inactivity, and one source is never combined with another: each answer is one source and one type.

export type ActivityTrendMeasure = 'count' | 'duration' | 'distance';
export const ACTIVITY_TREND_MEASURES: readonly ActivityTrendMeasure[] = ['count', 'duration', 'distance'];

export const activityTrendSourceLabels: Record<ActivityHistorySource, string> = {
  gpx: 'GPX import',
  manual: 'Entered manually',
  recorded_run: 'Recorded run',
};

export const activityTrendSourceOptions = (['manual', 'gpx', 'recorded_run'] as const).map((source) => ({
  label: activityTrendSourceLabels[source],
  source,
}));

/** The types a source can have: a recorded run is a run. */
export function activityTrendTypesFor(source: ActivityHistorySource): readonly ActivityType[] {
  return source === 'recorded_run' ? ['run'] : ACTIVITY_TYPES;
}

/** Each source's duration, named for what it is (the history's names, ADR-0087). */
export const activityTrendDurationLabels: Record<ActivityHistorySource, string> = {
  gpx: 'Elapsed time',
  manual: 'Entered duration',
  recorded_run: 'Observed duration',
};

export const activityTrendDurationExplanations: Record<ActivityHistorySource, string> = {
  gpx: 'Elapsed time runs from the first to the last point of each GPX file, pauses included; it is not moving time.',
  manual: 'Entered duration is the duration you typed for each entry.',
  recorded_run:
    'Observed duration adds the time between accepted GPS points of each run, from a summary made for its current data; pauses and gaps are left out.',
};

export const activityTrendMeasureLabels = (source: ActivityHistorySource): Record<ActivityTrendMeasure, string> => ({
  count: source === 'recorded_run' ? 'Runs' : source === 'gpx' ? 'Imports' : 'Entries',
  distance: 'Distance',
  duration: activityTrendDurationLabels[source],
});

interface Metric {
  total: number | null;
  withValue: number;
}

/** One date of any source in one shape for display. The duration keeps its source's label everywhere it is shown. */
export interface ActivityTrendDisplayDay {
  count: number;
  distance: Metric;
  duration: Metric;
  endsAt: string;
  localDate: string;
  /** The zone skipped the whole date (an empty interval, e.g. Pacific/Apia's 2011-12-30): it has no hours and no items. */
  skipped: boolean;
  startsAt: string;
  summaries: { current: number; pending: number; stale: number } | null;
}

export function displayDays(trends: ActivityTrends): ActivityTrendDisplayDay[] {
  return trends.days.map((day) => {
    const duration = 'enteredDuration' in day ? day.enteredDuration : 'elapsedDuration' in day ? day.elapsedDuration : day.observedDuration;
    return {
      count: day.count,
      distance: { total: day.distance.totalM, withValue: day.distance.withValue },
      duration: { total: duration.totalS, withValue: duration.withValue },
      endsAt: day.endsAt,
      localDate: day.localDate,
      skipped: day.startsAt === day.endsAt,
      startsAt: day.startsAt,
      summaries: 'summaries' in day ? day.summaries : null,
    };
  });
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const days = (count: number) => plural(count, 'day', 'days');

/** "entry"/"entries", "import"/"imports" or "run"/"runs". */
export function itemNoun(source: ActivityHistorySource, count: number): string {
  const [one, many] = source === 'recorded_run' ? ['run', 'runs'] : source === 'gpx' ? ['import', 'imports'] : ['entry', 'entries'];
  return count === 1 ? one : many;
}

const items = (source: ActivityHistorySource, count: number) => `${count} ${itemNoun(source, count)}`;

/** "manual rides", "GPX imports of hikes", "recorded runs". */
export function selectionLabel(source: ActivityHistorySource, type: ActivityType): string {
  const typeName = activityTypeLabels[type].toLowerCase();
  if (source === 'recorded_run') return 'recorded runs';
  if (source === 'gpx') return `GPX imports of type ${typeName}`;
  return `manually entered activities of type ${typeName}`;
}

export const formatKilometres = (metres: number) => formatDistance(metres, 'km');

function metricLine(label: string, metric: Metric & { daysWithValue: number }, count: number, source: ActivityHistorySource, format: (value: number) => string): string {
  if (metric.withValue === 0) return `${label}: unknown. None of the ${items(source, count)} records it.`;
  const total = format(metric.total!);
  if (metric.withValue === count) return `${label}: ${total} in total, from ${count === 1 ? `the 1 ${itemNoun(source, 1)}` : `all ${items(source, count)}`}.`;
  const missing = count - metric.withValue;
  const rest = missing === 1 ? `other ${itemNoun(source, 1)} is unknown, not zero, and adds` : `other ${missing} are unknown, not zero, and add`;
  return `${label}: ${total} from ${metric.withValue} of ${items(source, count)}. The ${rest} nothing.`;
}

/** How many dates of the range the zone skipped entirely (at most one in 28 dates in practice). */
const skippedDates = (trends: ActivityTrends) => trends.days.filter((day) => day.startsAt === day.endsAt).length;
const skippedClause = (skipped: number) => (skipped === 0 ? '' : ` (${skipped === 1 ? '1 of them' : `${skipped} of them`} did not happen in this time zone)`);

/**
 * The range's coverage and totals, each sentence naming the items and days it covers. No entries are described as
 * nothing logged, never as inactivity.
 */
export function activitySummaryLines(trends: ActivityTrends): string[] {
  const { summary } = trends;
  const total = trends.range.days;
  const source = trends.source;
  if (summary.count === 0) {
    return [
      `No ${selectionLabel(source, trends.applied.type)} on any of these ${days(total)}. That only means nothing of this kind was logged here; it does not mean you were inactive.`,
    ];
  }
  const durationMetric = 'enteredDuration' in summary ? summary.enteredDuration : 'elapsedDuration' in summary ? summary.elapsedDuration : summary.observedDuration;
  const lines = [
    `${items(source, summary.count)} on ${summary.daysWithEntries} of ${days(total)}. ${
      summary.daysWithEntries === total ? '' : `On the other ${days(total - summary.daysWithEntries)} none was logged${skippedClause(skippedDates(trends))}, which does not mean you were inactive.`
    }`.trim(),
    metricLine(activityTrendDurationLabels[source], { daysWithValue: durationMetric.daysWithValue, total: durationMetric.totalS, withValue: durationMetric.withValue }, summary.count, source, formatDuration),
    metricLine('Distance', { daysWithValue: summary.distance.daysWithValue, total: summary.distance.totalM, withValue: summary.distance.withValue }, summary.count, source, formatKilometres),
  ];
  if ('summaries' in summary) {
    const { current, pending, stale } = summary.summaries;
    lines.push(
      `GPS summaries: ${current} current, ${pending} still being prepared, ${stale} being updated after new data. Only a current summary gives a duration or distance.`,
    );
  }
  return lines;
}

export interface ActivityTrendTableRow {
  count: string;
  dateLabel: string;
  distance: string;
  distanceDetail: string | null;
  duration: string;
  durationDetail: string | null;
  localDate: string;
  /** False when nothing was logged on the date. */
  logged: boolean;
  summaryDetail: string | null;
}

export const NONE_LOGGED = 'None logged';
/** A date the zone skipped: it had no hours, so "none logged" would suggest a day that could have held entries. */
export const SKIPPED_DATE = 'Date skipped';
export const UNKNOWN = 'Unknown';

function cell(day: ActivityTrendDisplayDay, metric: Metric, source: ActivityHistorySource, format: (value: number) => string): { detail: string | null; value: string } {
  if (day.count === 0) return { detail: null, value: '–' };
  if (metric.withValue === 0) return { detail: `${day.count === 1 ? 'Not recorded' : `Not recorded for any of ${items(source, day.count)}`}`, value: UNKNOWN };
  return { detail: metric.withValue === day.count ? null : `From ${metric.withValue} of ${items(source, day.count)}`, value: format(metric.total!) };
}

/** One row per date of the range, newest first. */
export function activityTableRows(trends: ActivityTrends): ActivityTrendTableRow[] {
  const source = trends.source;
  return displayDays(trends)
    .map((day) => {
      const duration = cell(day, day.duration, source, formatDuration);
      const distance = cell(day, day.distance, source, formatKilometres);
      const states = day.summaries;
      const unknownStates = states === null ? [] : [states.pending > 0 ? `${states.pending} being prepared` : null, states.stale > 0 ? `${states.stale} being updated` : null].filter((part) => part !== null);
      return {
        count: day.skipped ? SKIPPED_DATE : day.count === 0 ? NONE_LOGGED : String(day.count),
        dateLabel: formatCheckInDate(day.localDate),
        distance: distance.value,
        distanceDetail: distance.detail,
        duration: duration.value,
        durationDetail: duration.detail,
        localDate: day.localDate,
        logged: day.count > 0,
        summaryDetail: unknownStates.length === 0 ? null : `Summary ${unknownStates.join(', ')}`,
      };
    })
    .toReversed();
}

/**
 * The dates of the range that are not 24 hours long in the zone, said once each. A date the zone skipped entirely is not
 * a clock change within a day: it is said to have had no hours, so nothing could be logged on it.
 */
export function dayLengthNotes(trends: ActivityTrends): string[] {
  const zone = trends.applied.timeZone;
  return trends.days.flatMap((day) => {
    const hours = (Date.parse(day.endsAt) - Date.parse(day.startsAt)) / 3_600_000;
    if (hours === 0) {
      return [
        `${formatCheckInDate(day.localDate)} did not happen in ${zone}: its clocks went from the end of the day before straight to the day after, so this date had no hours and nothing can be logged on it.`,
      ];
    }
    return hours === 24 ? [] : [`${formatCheckInDate(day.localDate)} has ${String(hours)} hours in ${zone} because the clocks change.`];
  });
}

export type ActivityChartMark =
  | { kind: 'bar'; height: number; label: string; localDate: string; path: string; x: number }
  /** Recorded, and the recorded total is 0: a dot on the baseline. */
  | { kind: 'zero'; label: string; localDate: string; x: number }
  /** Items were logged but none records this measure: an open marker above the baseline, never a bar. */
  | { kind: 'unknown'; label: string; localDate: string; x: number }
  /** Nothing was logged: a short mark under the axis. */
  | { kind: 'none'; label: string; localDate: string; x: number };

export interface ActivityChartGeometry {
  height: number;
  marks: ActivityChartMark[];
  plot: { bottom: number; left: number; right: number; top: number };
  width: number;
  xLabels: Array<{ anchor: 'end' | 'middle' | 'start'; text: string; x: number }>;
  yTicks: Array<{ label: string; y: number }>;
}

export const ACTIVITY_CHART_WIDTH = 640;
export const ACTIVITY_CHART_HEIGHT = 220;

const shortDate = (localDate: string) => {
  const [, month, day] = localDate.split('-');
  return `${Number(day)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(month) - 1] ?? ''}`;
};

/** The value of a measure on a date: null when nothing was logged or the value is unknown. */
function measureOf(day: ActivityTrendDisplayDay, measure: ActivityTrendMeasure): number | null {
  if (day.count === 0) return null;
  if (measure === 'count') return day.count;
  return (measure === 'duration' ? day.duration : day.distance).total;
}

export function formatMeasure(measure: ActivityTrendMeasure, value: number): string {
  return measure === 'count' ? String(value) : measure === 'duration' ? formatDuration(value) : formatKilometres(value);
}

/** A bar per date with a value, anchored to a zero baseline (counts, durations and distances all start at 0). */
export function activityChartGeometry(trends: ActivityTrends, measure: ActivityTrendMeasure): ActivityChartGeometry {
  const source = trends.source;
  const all = displayDays(trends);
  const values = all.flatMap((day) => {
    const value = measureOf(day, measure);
    return value === null ? [] : [value];
  });
  const max = Math.max(0, ...values);
  const top = max === 0 ? 1 : max;
  const tickLabels = values.length === 0 ? [] : ['0', formatMeasure(measure, top)];
  const longest = Math.max(1, ...tickLabels.map((label) => label.length));
  const plot = { bottom: ACTIVITY_CHART_HEIGHT - 30, left: Math.min(160, Math.max(40, 18 + longest * 10)), right: ACTIVITY_CHART_WIDTH - 16, top: 14 };
  const slot = (plot.right - plot.left) / all.length;
  const barWidth = Math.max(2, Math.min(24, slot - 2)); // a 2px surface gap between neighbouring bars
  const xOf = (index: number) => plot.left + slot * (index + 0.5);
  const yOf = (value: number) => plot.bottom - (value / top) * (plot.bottom - plot.top);
  const label = activityTrendMeasureLabels(source)[measure];
  const marks: ActivityChartMark[] = all.map((day, index) => {
    const x = xOf(index);
    const date = formatCheckInDate(day.localDate);
    if (day.skipped) return { kind: 'none', label: `${date}: skipped in this time zone, no hours to log`, localDate: day.localDate, x };
    if (day.count === 0) return { kind: 'none', label: `${date}: none logged`, localDate: day.localDate, x };
    const value = measureOf(day, measure);
    if (value === null) return { kind: 'unknown', label: `${date}: ${label.toLowerCase()} unknown for ${items(source, day.count)}`, localDate: day.localDate, x };
    const coverage = measure === 'count' ? '' : (measure === 'duration' ? day.duration : day.distance).withValue === day.count ? '' : ` (from ${(measure === 'duration' ? day.duration : day.distance).withValue} of ${items(source, day.count)})`;
    const text = `${date}: ${formatMeasure(measure, value)}${coverage}`;
    if (value === 0) return { kind: 'zero', label: text, localDate: day.localDate, x };
    const y = yOf(value);
    const height = plot.bottom - y;
    const half = barWidth / 2;
    const radius = Math.min(4, half, height);
    // A bar with 4px rounded top corners, square on the baseline.
    const path = `M${(x - half).toFixed(1)},${plot.bottom.toFixed(1)}V${(y + radius).toFixed(1)}Q${(x - half).toFixed(1)},${y.toFixed(1)} ${(x - half + radius).toFixed(1)},${y.toFixed(1)}H${(x + half - radius).toFixed(1)}Q${(x + half).toFixed(1)},${y.toFixed(1)} ${(x + half).toFixed(1)},${(y + radius).toFixed(1)}V${plot.bottom.toFixed(1)}Z`;
    return { height, kind: 'bar', label: text, localDate: day.localDate, path, x };
  });
  const yTicks = tickLabels.length === 0 ? [] : [{ label: tickLabels[0]!, y: plot.bottom }, { label: tickLabels[1]!, y: plot.top }];
  const first = all[0]!.localDate;
  const last = all.at(-1)!.localDate;
  const xLabels: ActivityChartGeometry['xLabels'] =
    all.length === 1
      ? [{ anchor: 'middle', text: shortDate(first), x: xOf(0) }]
      : [
          { anchor: 'start', text: shortDate(first), x: plot.left },
          { anchor: 'end', text: shortDate(last), x: plot.right },
        ];
  return { height: ACTIVITY_CHART_HEIGHT, marks, plot, width: ACTIVITY_CHART_WIDTH, xLabels, yTicks };
}

/** The chart's accessible description: what it shows and where every value is listed. */
export function activityChartDescription(trends: ActivityTrends, measure: ActivityTrendMeasure): string {
  const label = activityTrendMeasureLabels(trends.source)[measure];
  const marks = activityChartGeometry(trends, measure).marks;
  const count = (kind: ActivityChartMark['kind']) => marks.filter((mark) => mark.kind === kind).length;
  return `${label} of ${selectionLabel(trends.source, trends.applied.type)} per date over ${days(trends.range.days)}: ${count('bar') + count('zero')} with a value, ${count('unknown')} with items but an unknown value, ${count('none')} with nothing logged${skippedClause(skippedDates(trends))}. The table below lists every date.`;
}

/** "Computed 12 Nov 2026, 11:00 from your own records ...", in the zone the dates are read in. */
export function activityComputedLine(trends: ActivityTrends): string {
  const at = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: trends.applied.timeZone }).format(new Date(trends.provenance.computedAt));
  return `Computed ${at} from your own records in one consistent read (${trends.provenance.policyVersion}); nothing is stored.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Comparison with the previous 28 dates (ADR-0090). The server computes every total, change and percentage and says, per
// metric, whether a change is given and why not; the browser only formats those values and words the reasons. A change
// is never computed here.
// ---------------------------------------------------------------------------------------------------------------------

type Comparison = NonNullable<ActivityTrends['comparison']>;
type ComparisonSummary = NonNullable<Comparison['previous']['summary']>;
type AnySummary = ComparisonSummary | ActivityTrends['summary'];
type Change = Comparison['metrics']['count']['change'];

export interface ActivityComparisonCell {
  detail: string | null;
  value: string;
}

export interface ActivityComparisonRow {
  change: ActivityComparisonCell & { status: Change['status'] };
  current: ActivityComparisonCell;
  label: string;
  measure: ActivityTrendMeasure;
  previous: ActivityComparisonCell;
}

export interface ActivityComparisonView {
  /** Sentences that apply to every measure (an unfinished or shortened period), then the coverage caveat. */
  notes: string[];
  /** "16 Oct 2026 – 12 Nov 2026 (28 dates)" for each period; the previous one may be out of range. */
  periods: { current: string; previous: string };
  rows: ActivityComparisonRow[];
}

/** U+2212 MINUS SIGN for a negative change, "+" for a positive one, nothing for zero. */
const signOf = (value: number) => (value > 0 ? '+' : value < 0 ? '−' : '');

/** A signed change in a measure's own format: "+2", "−30:00", "+6.00 km", "0". */
export function formatSignedChange(measure: ActivityTrendMeasure, value: number): string {
  return `${signOf(value)}${formatMeasure(measure, Math.abs(value))}`;
}

/** A server-computed percentage with its one decimal: "+50.0%", "−12.3%", "0.0%". */
export function formatPercentChange(percent: number): string {
  return `${signOf(percent)}${Math.abs(percent).toFixed(1)}%`;
}

const shortLongDate = (localDate: string) => `${shortDate(localDate)} ${localDate.slice(0, 4)}`;
const periodLabel = (period: { days: number; endDate: string; startDate: string }) =>
  `${shortLongDate(period.startDate)} – ${shortLongDate(period.endDate)} (${period.days === 1 ? '1 date' : `${period.days} dates`})`;

function durationOf(summary: AnySummary) {
  return 'enteredDuration' in summary ? summary.enteredDuration : 'elapsedDuration' in summary ? summary.elapsedDuration : summary.observedDuration;
}

function metricOf(comparison: Comparison, measure: ActivityTrendMeasure) {
  const { metrics } = comparison;
  if (measure === 'count') return metrics.count;
  if (measure === 'distance') return metrics.distance;
  return 'enteredDuration' in metrics ? metrics.enteredDuration : 'elapsedDuration' in metrics ? metrics.elapsedDuration : metrics.observedDuration;
}

const statesOf = (summary: AnySummary | null) => (summary !== null && 'summaries' in summary ? summary.summaries : { current: 0, pending: 0, stale: 0 });

/** A period's value of a measure with its coverage: how many of its items record it. */
function valueCell(source: ActivityHistorySource, measure: ActivityTrendMeasure, summary: AnySummary): ActivityComparisonCell {
  if (measure === 'count') return { detail: summary.count === 0 ? NONE_LOGGED : null, value: String(summary.count) };
  if (summary.count === 0) return { detail: NONE_LOGGED, value: '–' };
  const metric = measure === 'duration' ? { total: durationOf(summary).totalS, withValue: durationOf(summary).withValue } : { total: summary.distance.totalM, withValue: summary.distance.withValue };
  const states = statesOf(summary);
  const waiting = [states.pending > 0 ? `${states.pending} being prepared` : null, states.stale > 0 ? `${states.stale} being updated` : null].filter((part) => part !== null);
  const suffix = waiting.length === 0 ? '' : ` (summary ${waiting.join(', ')})`;
  if (metric.withValue === 0 || metric.total === null) return { detail: `None of ${items(source, summary.count)} records it${suffix}`, value: UNKNOWN };
  const coverage =
    metric.withValue === summary.count
      ? summary.count === 1
        ? `From the 1 ${itemNoun(source, 1)}`
        : `From all ${items(source, summary.count)}`
      : `From ${metric.withValue} of ${items(source, summary.count)}`;
  return { detail: `${coverage}${suffix}`, value: formatMeasure(measure, metric.total) };
}

/** The reasons particular to one measure (the period reasons are said once, as notes). */
function metricReasonSentences(
  reasons: readonly ActivityTrendsComparisonReason[],
  source: ActivityHistorySource,
  current: AnySummary,
  previous: AnySummary | null,
  measure: ActivityTrendMeasure,
): string[] {
  const missing = (summary: AnySummary) =>
    summary.count - (measure === 'duration' ? durationOf(summary).withValue : summary.distance.withValue) - statesOf(summary).pending - statesOf(summary).stale;
  const verb = (count: number, one: string, many: string) => `${count} ${itemNoun(source, count)} ${count === 1 ? one : many}`;
  return reasons.flatMap((reason): string[] => {
    switch (reason) {
      case 'current_period_no_entries':
        return ['Nothing was logged in this period, so it has no total.'];
      case 'previous_period_no_entries':
        return ['Nothing was logged in the previous period, so it has no total.'];
      case 'current_values_missing':
        return [`${verb(missing(current), 'does', 'do')} not record it in this period.`];
      case 'previous_values_missing':
        return previous === null ? [] : [`${verb(missing(previous), 'does', 'do')} not record it in the previous period.`];
      case 'current_summaries_pending':
        return [`${verb(statesOf(current).pending, 'has', 'have')} a GPS summary still being prepared in this period.`];
      case 'previous_summaries_pending':
        return [`${verb(statesOf(previous).pending, 'has', 'have')} a GPS summary still being prepared in the previous period.`];
      case 'current_summaries_stale':
        return [`${verb(statesOf(current).stale, 'has', 'have')} a GPS summary being updated after new data in this period.`];
      case 'previous_summaries_stale':
        return [`${verb(statesOf(previous).stale, 'has', 'have')} a GPS summary being updated after new data in the previous period.`];
      default:
        return [];
    }
  });
}

function changeCell(change: Change, measure: ActivityTrendMeasure, sentences: string[]): ActivityComparisonCell & { status: Change['status'] } {
  if (change.status === 'unavailable') return { detail: sentences.length === 0 ? null : sentences.join(' '), status: 'unavailable', value: 'Not compared' };
  const absolute = formatSignedChange(measure, change.absolute);
  if (change.percent === null) return { detail: 'No percentage: the previous total is 0.', status: 'available', value: absolute };
  return { detail: null, status: 'available', value: `${absolute} (${formatPercentChange(change.percent)})` };
}

/** The period notes: why nothing or only part is compared, then what coverage can and cannot say. */
function periodNotes(comparison: Comparison): string[] {
  const notes = comparison.periodReasons.flatMap((reason): string[] => {
    switch (reason) {
      case 'current_period_in_progress':
        return ['This period includes today, so it can still change. Changes are shown only for periods that have ended: choose an end date before today to compare.'];
      case 'current_period_shortened':
        return [`This period starts on 1 Jan 2000, the earliest date, so it has ${comparison.current.period.days} of 28 dates and is not compared.`];
      case 'previous_period_out_of_range':
        return [
          `The previous 28 dates (${shortLongDate(comparison.previous.requestedStartDate)} – ${shortLongDate(comparison.previous.requestedEndDate)}) are before 1 Jan 2000, the earliest date, so there is nothing to compare with.`,
        ];
      case 'previous_period_shortened':
        return [`The previous period is cut short by 1 Jan 2000 (${comparison.previous.period?.days ?? 0} of 28 dates), so it is not compared as a full period.`];
      default:
        return [];
    }
  });
  return [...notes, 'Coverage counts only what was logged: a total from all entries does not mean that every activity was logged.'];
}

/** The comparison section: both periods, each measure's values with coverage, and a signed change or why there is none. */
export function activityComparisonView(trends: ActivityTrends): ActivityComparisonView | null {
  const comparison = trends.comparison;
  if (comparison === undefined) return null;
  const source = trends.source;
  const labels = activityTrendMeasureLabels(source);
  const previous = comparison.previous.summary;
  const rows = ACTIVITY_TREND_MEASURES.map((measure): ActivityComparisonRow => {
    const { change } = metricOf(comparison, measure);
    const sentences = change.status === 'unavailable' ? metricReasonSentences(change.reasons, source, trends.summary, previous, measure) : [];
    return {
      change: changeCell(change, measure, sentences),
      current: valueCell(source, measure, trends.summary),
      label: labels[measure],
      measure,
      previous: previous === null ? { detail: 'Before 1 Jan 2000', value: '–' } : valueCell(source, measure, previous),
    };
  });
  return {
    notes: periodNotes(comparison),
    periods: {
      current: periodLabel(comparison.current.period),
      previous: comparison.previous.period === null ? 'none (before 1 Jan 2000)' : periodLabel(comparison.previous.period),
    },
    rows,
  };
}
