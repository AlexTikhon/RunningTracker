export interface MetricSeries {
  labels: Record<string, string>;
  name: string;
  value: number;
}

const linePattern = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/u;

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let position = 0;
  while (position < text.length) {
    const equals = text.indexOf('=', position);
    if (equals < 0 || text[equals + 1] !== '"') {
      throw new Error('Unparseable metric labels');
    }
    const name = text.slice(position, equals).trim();
    let value = '';
    let cursor = equals + 2;
    for (;;) {
      const character = text[cursor];
      if (character === undefined) {
        throw new Error('Unterminated metric label value');
      }
      if (character === '\\') {
        const escaped = text[cursor + 1];
        value += escaped === 'n' ? '\n' : (escaped ?? '');
        cursor += 2;
        continue;
      }
      if (character === '"') {
        cursor += 1;
        break;
      }
      value += character;
      cursor += 1;
    }
    labels[name] = value;
    position = cursor;
    if (text[position] === ',') {
      position += 1;
    }
  }
  return labels;
}

/** Parses Prometheus text 0.0.4. Series with non-finite values are dropped; malformed lines are an error. */
export function parsePrometheusText(text: string): MetricSeries[] {
  const series: MetricSeries[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = linePattern.exec(line);
    if (!match) {
      throw new Error('Unparseable metrics line');
    }
    const value = Number(match[3]);
    if (!Number.isFinite(value)) {
      continue;
    }
    series.push({ labels: match[2] ? parseLabels(match[2]) : {}, name: match[1] as string, value });
  }
  return series;
}

const histogramSuffixes = ['_bucket', '_count', '_sum'] as const;

/** Keeps series whose name is one of `families` or a histogram component of one. */
export function selectSeries(series: readonly MetricSeries[], families: readonly string[]): MetricSeries[] {
  const wanted = new Set(families);
  return series.filter(
    (entry) =>
      wanted.has(entry.name) ||
      histogramSuffixes.some(
        (suffix) => entry.name.endsWith(suffix) && wanted.has(entry.name.slice(0, -suffix.length)),
      ),
  );
}

export async function scrapeMetrics(url: string, signal?: AbortSignal): Promise<MetricSeries[]> {
  const response = await fetch(url, signal ? { signal } : {});
  if (response.status !== 200) {
    throw new Error(`The metrics endpoint answered ${response.status}`);
  }
  return parsePrometheusText(await response.text());
}
