const metricNamePattern = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u;
const labelNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;
const DEFAULT_MAX_SERIES = 100;
const MAX_LABEL_VALUE_LENGTH = 96;
const OVERFLOW_LABEL_VALUE = '_overflow';

export type Labels = Readonly<Record<string, string>>;

export interface MetricDefinition {
  help: string;
  labelNames?: readonly string[];
  /** Upper bound on distinct label combinations; excess folds into one overflow series. */
  maxSeries?: number;
  name: string;
}

export interface HistogramDefinition extends MetricDefinition {
  buckets: readonly number[];
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function escapeHelp(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : value > 0 ? '+Inf' : value < 0 ? '-Inf' : 'NaN';
}

abstract class Metric<Series> {
  protected readonly labelNames: readonly string[];
  protected readonly series = new Map<string, { labelValues: readonly string[]; value: Series }>();
  readonly #maxSeries: number;

  public constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly type: 'counter' | 'gauge' | 'histogram',
    definition: MetricDefinition,
    private readonly onOverflow: (metric: string) => void,
  ) {
    if (!metricNamePattern.test(name)) {
      throw new TypeError(`Invalid metric name: ${name}`);
    }
    this.labelNames = [...(definition.labelNames ?? [])];
    for (const label of this.labelNames) {
      if (!labelNamePattern.test(label) || label === 'le') {
        throw new TypeError(`Invalid label name: ${label}`);
      }
    }
    this.#maxSeries = definition.maxSeries ?? DEFAULT_MAX_SERIES;
  }

  public abstract renderSeries(): string[];

  protected abstract createSeries(): Series;

  protected seriesFor(labels: Labels): Series {
    const keys = Object.keys(labels);
    if (
      keys.length !== this.labelNames.length ||
      !this.labelNames.every((label) => Object.hasOwn(labels, label))
    ) {
      throw new TypeError(`${this.name} expects labels: ${this.labelNames.join(', ') || '(none)'}`);
    }
    let labelValues = this.labelNames.map((label) =>
      String(labels[label]).slice(0, MAX_LABEL_VALUE_LENGTH),
    );
    let key = labelValues.join('\u0000');
    let entry = this.series.get(key);
    if (entry === undefined) {
      if (this.series.size >= this.#maxSeries && this.labelNames.length > 0) {
        this.onOverflow(this.name);
        labelValues = this.labelNames.map(() => OVERFLOW_LABEL_VALUE);
        key = labelValues.join('\u0000');
        entry = this.series.get(key);
      }
      if (entry === undefined) {
        entry = { labelValues, value: this.createSeries() };
        this.series.set(key, entry);
      }
    }
    return entry.value;
  }

  protected labelText(labelValues: readonly string[], extra?: string): string {
    const pairs = this.labelNames.map(
      (label, index) => `${label}="${escapeLabelValue(labelValues[index] ?? '')}"`,
    );
    if (extra !== undefined) {
      pairs.push(extra);
    }
    return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
  }

  public render(): string[] {
    return [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} ${this.type}`,
      ...this.renderSeries(),
    ];
  }
}

export class Counter extends Metric<{ value: number }> {
  public inc(labels: Labels = {}, amount = 1): void {
    if (!isNonNegativeFinite(amount)) {
      return;
    }
    this.seriesFor(labels).value += amount;
  }

  protected createSeries(): { value: number } {
    return { value: 0 };
  }

  public renderSeries(): string[] {
    return [...this.series.values()].map(
      ({ labelValues, value }) => `${this.name}${this.labelText(labelValues)} ${formatNumber(value.value)}`,
    );
  }
}

export class Gauge extends Metric<{ value: number }> {
  public set(labels: Labels, value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    this.seriesFor(labels).value = value;
  }

  public inc(labels: Labels = {}, amount = 1): void {
    if (Number.isFinite(amount)) {
      this.seriesFor(labels).value += amount;
    }
  }

  public dec(labels: Labels = {}, amount = 1): void {
    this.inc(labels, -amount);
  }

  protected createSeries(): { value: number } {
    return { value: 0 };
  }

  public renderSeries(): string[] {
    return [...this.series.values()].map(
      ({ labelValues, value }) => `${this.name}${this.labelText(labelValues)} ${formatNumber(value.value)}`,
    );
  }
}

interface HistogramSeries {
  bucketCounts: number[];
  count: number;
  sum: number;
}

export class Histogram extends Metric<HistogramSeries> {
  readonly #buckets: readonly number[];

  public constructor(
    name: string,
    definition: HistogramDefinition,
    onOverflow: (metric: string) => void,
  ) {
    super(name, definition.help, 'histogram', definition, onOverflow);
    const buckets = [...definition.buckets];
    if (buckets.length === 0 || !buckets.every((bound, index) => Number.isFinite(bound) && (index === 0 || bound > (buckets[index - 1] ?? 0)))) {
      throw new TypeError(`${name} buckets must be finite and strictly ascending`);
    }
    this.#buckets = buckets;
  }

  public observe(labels: Labels, value: number): void {
    if (!isNonNegativeFinite(value)) {
      return;
    }
    const series = this.seriesFor(labels);
    series.count += 1;
    series.sum += value;
    for (let index = 0; index < this.#buckets.length; index += 1) {
      if (value <= (this.#buckets[index] ?? Number.POSITIVE_INFINITY)) {
        series.bucketCounts[index] = (series.bucketCounts[index] ?? 0) + 1;
      }
    }
  }

  protected createSeries(): HistogramSeries {
    return { bucketCounts: this.#buckets.map(() => 0), count: 0, sum: 0 };
  }

  public renderSeries(): string[] {
    const rows: string[] = [];
    for (const { labelValues, value } of this.series.values()) {
      this.#buckets.forEach((bound, index) => {
        rows.push(
          `${this.name}_bucket${this.labelText(labelValues, `le="${formatNumber(bound)}"`)} ${value.bucketCounts[index] ?? 0}`,
        );
      });
      rows.push(`${this.name}_bucket${this.labelText(labelValues, 'le="+Inf"')} ${value.count}`);
      rows.push(`${this.name}_sum${this.labelText(labelValues)} ${formatNumber(value.sum)}`);
      rows.push(`${this.name}_count${this.labelText(labelValues)} ${value.count}`);
    }
    return rows;
  }
}

/**
 * Process-local instruments rendered as Prometheus text. Labels must come from
 * bounded, code-defined vocabularies; identifiers, coordinates, and tokens are
 * never label values.
 */
export class MetricsRegistry {
  readonly #collectors: Array<() => void> = [];
  readonly #collectorErrors: Counter;
  readonly #metrics = new Map<string, Metric<unknown>>();
  readonly #overflow: Counter;

  public constructor() {
    this.#overflow = this.counter({
      help: 'Label combinations folded into the overflow series.',
      labelNames: ['metric'],
      maxSeries: 200,
      name: 'metrics_series_overflow_total',
    });
    this.#collectorErrors = this.counter({
      help: 'Collector callbacks that threw while rendering.',
      name: 'metrics_collector_errors_total',
    });
  }

  public counter(definition: MetricDefinition): Counter {
    return this.#register(
      new Counter(definition.name, definition.help, 'counter', definition, (metric) =>
        this.#overflow?.inc({ metric }),
      ),
    );
  }

  public gauge(definition: MetricDefinition): Gauge {
    return this.#register(
      new Gauge(definition.name, definition.help, 'gauge', definition, (metric) =>
        this.#overflow?.inc({ metric }),
      ),
    );
  }

  public histogram(definition: HistogramDefinition): Histogram {
    return this.#register(
      new Histogram(definition.name, definition, (metric) => this.#overflow?.inc({ metric })),
    );
  }

  /** Runs synchronously at render time to refresh gauges from live state. */
  public addCollector(collector: () => void): void {
    this.#collectors.push(collector);
  }

  public render(): string {
    for (const collector of this.#collectors) {
      try {
        collector();
      } catch {
        this.#collectorErrors.inc();
      }
    }
    const blocks = [...this.#metrics.values()].map((metric) => metric.render().join('\n'));
    return `${blocks.join('\n')}\n`;
  }

  #register<Instrument extends Metric<unknown>>(metric: Instrument): Instrument {
    if (this.#metrics.has(metric.name)) {
      throw new Error(`Metric ${metric.name} is already registered`);
    }
    this.#metrics.set(metric.name, metric);
    return metric;
  }
}
