import {
  TCX_IMPORT_MAX_BYTES,
  TCX_IMPORT_MAX_DEPTH,
  TCX_IMPORT_MAX_ELEMENTS,
  TCX_IMPORT_MAX_LAPS,
  TCX_IMPORT_MAX_TEXT_LENGTH,
  TCX_IMPORT_METRICS_VERSION,
  tcxImportSummarySchema,
  tcxRoundHalfUp,
  type TcxUnsupportedReason,
} from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { canonicalDecimal, parseTcxDecimal, parseTcxInstant, readTcxActivity, TcxImportError } from './tcx-activity.js';

// Synthetic TCX documents (ADR-0091): no real person's activity, place or device. The marker values below must never
// reappear in an error message: errors name a reason and a lap position, never the file's content.
const NOW_MS = Date.parse('2026-11-13T12:00:00Z');
const TCD = 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2';
const AX = 'http://www.garmin.com/xmlschemas/ActivityExtension/v2';
const MARKER_NOTE = 'Marker note 7f3a';
const MARKER_CREATOR = 'Marker Watch 9000';
const MARKER_LAT = '52.2297001';

interface Lap {
  readonly start?: string | null;
  readonly total?: string | null;
  readonly distance?: string | null;
  /** Extra content inside the lap (after the totals). */
  readonly inner?: string;
}

const trackpoints = (start: string) => `<Track>
  <Trackpoint><Time>${start}</Time><Position><LatitudeDegrees>${MARKER_LAT}</LatitudeDegrees><LongitudeDegrees>21.0122</LongitudeDegrees></Position>
    <AltitudeMeters>101.2</AltitudeMeters><DistanceMeters>0</DistanceMeters><HeartRateBpm><Value>131</Value></HeartRateBpm>
    <Extensions><ns3:TPX xmlns:ns3="${AX}"><ns3:Speed>3.1</ns3:Speed></ns3:TPX></Extensions></Trackpoint>
</Track>`;

function lapXml(lap: Lap): string {
  const start = lap.start === null ? '' : ` StartTime="${lap.start ?? '2026-11-12T07:00:00Z'}"`;
  const total = lap.total === null ? '' : `<TotalTimeSeconds>${lap.total ?? '600'}</TotalTimeSeconds>`;
  const distance = lap.distance === null ? '' : `<DistanceMeters>${lap.distance ?? '2000'}</DistanceMeters>`;
  return `<Lap${start}>${total}${distance}<Calories>120</Calories><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>${lap.inner ?? ''}</Lap>`;
}

function tcx(
  laps: readonly Lap[],
  options: { activityExtra?: string; afterActivities?: string; beforeActivities?: string; id?: string | null; root?: string; header?: string } = {},
): string {
  const id = options.id === null ? '' : `<Id>${options.id ?? '2026-11-12T07:00:00Z'}</Id>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
${options.header ?? ''}${options.root ?? `<TrainingCenterDatabase xmlns="${TCD}">`}
  ${options.beforeActivities ?? ''}
  <Activities>
    <Activity Sport="Biking">
      ${id}
      ${laps.map(lapXml).join('\n      ')}
      <Notes>${MARKER_NOTE}</Notes>
      <Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Name>${MARKER_CREATOR}</Name></Creator>
      ${options.activityExtra ?? ''}
    </Activity>
  </Activities>
  ${options.afterActivities ?? ''}
</TrainingCenterDatabase>`;
}

const bytes = (text: string) => Buffer.from(text, 'utf8');
const read = (text: string) => readTcxActivity(bytes(text), NOW_MS);
const TWO_LAPS: Lap[] = [
  { distance: '2000.5', start: '2026-11-12T07:00:00Z', total: '600.25' },
  { distance: '1999.25', start: '2026-11-12T07:10:01Z', total: '300.25' },
];

function refusal(text: string | Uint8Array): { message: string; reason: TcxUnsupportedReason } {
  try {
    readTcxActivity(typeof text === 'string' ? bytes(text) : text, NOW_MS);
  } catch (error) {
    if (error instanceof TcxImportError) return { message: error.message, reason: error.reason };
    throw error;
  }
  throw new Error('Expected the file to be refused');
}

const reasonOf = (text: string | Uint8Array) => refusal(text).reason;

describe('readTcxActivity: the supported subset (ADR-0091)', () => {
  it('sums the laps exactly and rounds once, half up; the start is the first lap; no GPS position is needed', () => {
    const activity = read(tcx(TWO_LAPS));
    expect(activity.summary).toEqual({
      distanceM: 4000,
      lapCount: 2,
      lapTotals: { distanceMeters: '3999.75', totalTimeSeconds: '900.5' },
      metricsVersion: TCX_IMPORT_METRICS_VERSION,
      reportedDurationS: 901,
      startedAt: '2026-11-12T07:00:00.000Z',
    });
    expect(activity.startedAtMs).toBe(Date.parse('2026-11-12T07:00:00Z'));
    expect(activity.fingerprint).toHaveLength(32);
    expect(tcxImportSummarySchema.parse(activity.summary)).toEqual(activity.summary);
  });

  it('gives the same summary and fingerprint with or without trackpoints, positions, heart rate and extensions', () => {
    const plain = read(tcx(TWO_LAPS));
    const tracked = read(tcx(TWO_LAPS.map((lap) => ({ ...lap, inner: trackpoints(lap.start!) }))));
    expect(tracked.summary).toEqual(plain.summary);
    expect(tracked.fingerprint.equals(plain.fingerprint)).toBe(true);
  });

  it('decides rounding from the decimal text, never from a binary approximation', () => {
    // As a double 2.49999999999999999 is 2.5 and would round to 3; the exact value rounds to 2.
    expect(read(tcx([{ total: '2.49999999999999999' }])).summary.reportedDurationS).toBe(2);
    // 0.1 + 0.2 + 0.2 is exactly 0.5: rounded up to 1 second.
    const fractions = read(
      tcx([
        { start: '2026-11-12T07:00:00Z', total: '0.1' },
        { start: '2026-11-12T07:00:01Z', total: '0.2' },
        { start: '2026-11-12T07:00:02Z', total: '0.2' },
      ]),
    ).summary;
    expect([fractions.lapTotals.totalTimeSeconds, fractions.reportedDurationS]).toEqual(['0.5', 1]);
    // Garmin-style float artefacts are summed exactly: 3 x 1609.3399658203125 = 4828.0198974609375 m.
    const miles = read(
      tcx([0, 1, 2].map((index) => ({ distance: '1609.3399658203125', start: `2026-11-12T07:0${String(index)}:00Z`, total: '60' }))),
    ).summary;
    expect([miles.lapTotals.distanceMeters, miles.distanceM]).toEqual(['4828.0198974609375', 4828]);
    expect(read(tcx([{ distance: '0.5', total: '1.4999' }])).summary).toMatchObject({ distanceM: 1, reportedDurationS: 1 });
    expect(read(tcx([{ distance: '0', total: '1' }])).summary.distanceM).toBe(0);
  });

  it('accepts decimal spellings and surrounding XML whitespace, which do not change the fingerprint', () => {
    const canonical = read(tcx([{ distance: '2000', total: '600' }]));
    for (const [total, distance] of [
      ['600.000', '2000.0'],
      ['+600', '+2000.'],
      [' \n\t600\r\n ', ' 2000 '],
      ['0600', '02000'],
    ] as const) {
      const variant = read(tcx([{ distance, total }]));
      expect(variant.summary).toEqual(canonical.summary);
      expect(variant.fingerprint.equals(canonical.fingerprint)).toBe(true);
    }
    expect(read(tcx([{ distance: '.5', total: '600' }])).summary.lapTotals.distanceMeters).toBe('0.5');
  });

  it('keeps the fingerprint for an equal instant in another zone spelling, another Id, notes, creator or Sport', () => {
    const base = read(tcx(TWO_LAPS));
    const variant = read(
      tcx(
        [
          { ...TWO_LAPS[0], start: '2026-11-12T08:00:00.000+01:00' },
          { ...TWO_LAPS[1], start: '2026-11-12T02:10:01-05:00' },
        ],
        { id: '2026-11-12T09:00:00Z' },
      )
        .replace(MARKER_NOTE, 'Other notes')
        .replace(MARKER_CREATOR, 'Other device')
        .replace('Sport="Biking"', 'Sport="Running"'),
    );
    expect(variant.fingerprint.equals(base.fingerprint)).toBe(true);
  });

  it('changes the fingerprint with any lap start, value, split or count', () => {
    const base = read(tcx(TWO_LAPS)).fingerprint;
    const changed = [
      tcx([{ ...TWO_LAPS[0], start: '2026-11-12T07:00:00.001Z' }, TWO_LAPS[1]!]),
      tcx([{ ...TWO_LAPS[0], total: '600.26' }, TWO_LAPS[1]!]),
      tcx([{ ...TWO_LAPS[0], distance: '2000.51' }, TWO_LAPS[1]!]),
      tcx([TWO_LAPS[0]!]),
      // The same totals as one lap: another split, another activity.
      tcx([{ distance: '3999.75', start: '2026-11-12T07:00:00Z', total: '900.5' }]),
    ];
    for (const file of changed) expect(read(file).fingerprint.equals(base)).toBe(false);
  });

  it('identifies elements by namespace, with any prefix, aliases and a restored default namespace', () => {
    const base = read(tcx(TWO_LAPS));
    const prefixed = tcx(TWO_LAPS, { root: `<t:TrainingCenterDatabase xmlns:t="${TCD}">` })
      .replace(/<(\/?)(Activities|Activity|Id|Lap|TotalTimeSeconds|DistanceMeters|Calories|Intensity|TriggerMethod|Notes|Creator|Name)(?=[\s/>])/gu, '<$1t:$2')
      .replace('</TrainingCenterDatabase>', '</t:TrainingCenterDatabase>');
    expect(read(prefixed).summary).toEqual(base.summary);
    // Two prefixes bound to the same namespace are the same elements.
    const aliases = prefixed.replace(`xmlns:t="${TCD}"`, `xmlns:t="${TCD}" xmlns:u="${TCD}"`).replaceAll('<t:Lap', '<u:Lap').replaceAll('</t:Lap>', '</u:Lap>');
    expect(read(aliases).summary).toEqual(base.summary);
    // A foreign element named Lap, TotalTimeSeconds or Activity never counts.
    const foreign = tcx(TWO_LAPS, {
      activityExtra: `<Lap xmlns="urn:foreign" StartTime="2026-11-12T09:00:00Z"><TotalTimeSeconds>9999</TotalTimeSeconds></Lap>`,
      afterActivities: `<Extensions><Activities xmlns="urn:foreign"><Activity><Lap/></Activity></Activities></Extensions>`,
    });
    expect(read(foreign).summary).toEqual(base.summary);
    // xmlns="" puts a lap in no namespace: not a TCX lap, so the activity has none.
    expect(reasonOf(tcx([{ inner: '' }]).replace('<Lap ', '<Lap xmlns="" '))).toBe('no_laps');
    // A foreign TotalTimeSeconds inside a lap does not stand in for the TCX one.
    expect(reasonOf(tcx([{ total: null, inner: '<TotalTimeSeconds xmlns="urn:foreign">600</TotalTimeSeconds>' }]))).toBe('field_missing');
  });

  it('skips courses, workouts, folders, author and extensions whole (a CourseLap is also named Lap)', () => {
    const base = read(tcx(TWO_LAPS));
    const extra = read(
      tcx(TWO_LAPS, {
        afterActivities: `<Workouts/><Courses><Course><Name>c</Name><Lap><TotalTimeSeconds>1</TotalTimeSeconds><DistanceMeters>1</DistanceMeters></Lap></Course></Courses>
  <Author><Name>${MARKER_CREATOR}</Name></Author><Extensions><x:Any xmlns:x="urn:x"/></Extensions>`,
        beforeActivities: '<Folders><History><Running/><Biking/><Other/><MultiSport/></History></Folders>',
      }),
    );
    expect(extra.summary).toEqual(base.summary);
    expect(extra.fingerprint.equals(base.fingerprint)).toBe(true);
  });
});

describe('readTcxActivity: refusals, never repairs', () => {
  const cases: [string, string | Uint8Array, TcxUnsupportedReason][] = [
    ['an empty file', '', 'not_xml'],
    ['text that is not XML', 'lap 1 600 s', 'malformed_xml'],
    ['invalid UTF-8', Buffer.from([0x3c, 0x61, 0xff, 0x3e]), 'not_utf8'],
    ['a NUL character', `${tcx(TWO_LAPS)}\u0000`, 'not_utf8'],
    ['a declared Latin-1 encoding', tcx(TWO_LAPS).replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'), 'not_utf8'],
    ['a DOCTYPE with an external entity', tcx(TWO_LAPS, { header: '<!DOCTYPE TrainingCenterDatabase [<!ENTITY x SYSTEM "http://127.0.0.1:9/never">]>' }), 'declaration'],
    ['an entity declaration later in the file', tcx(TWO_LAPS).replace('<Activities>', '<Activities><!ENTITY y "z">'), 'declaration'],
    ['an undeclared prefix', tcx(TWO_LAPS).replace('<Activities>', '<Activities><p:Thing/>'), 'malformed_xml'],
    ['a misbound xml prefix', tcx(TWO_LAPS).replace('<Activities>', '<Activities xmlns:xml="urn:x">'), 'malformed_xml'],
    ['an unterminated tag', tcx(TWO_LAPS).replace('</TrainingCenterDatabase>', '</TrainingCenterDatabase'), 'malformed_xml'],
    ['mismatched tags', tcx(TWO_LAPS).replace('</Activities>', '</Activity></Activities>'), 'malformed_xml'],
    ['a GPX file', `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk/></gpx>`, 'not_tcx'],
    ['TCX v1', tcx(TWO_LAPS, { root: '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v1">' }), 'not_tcx_v2'],
    ['no namespace', tcx(TWO_LAPS, { root: '<TrainingCenterDatabase>' }), 'not_tcx_v2'],
    ['two Activities elements', tcx(TWO_LAPS, { afterActivities: '<Activities/>' }), 'structure'],
    ['no activity (a courses-only file)', tcx(TWO_LAPS).replace(/<Activities>[\s\S]*<\/Activities>/u, '<Courses/>'), 'activity_count'],
    ['two activities', tcx(TWO_LAPS).replace('</Activities>', '<Activity Sport="Other"><Id>2026-11-12T09:00:00Z</Id></Activity></Activities>'), 'activity_count'],
    ['a multisport session', tcx(TWO_LAPS).replace('</Activities>', '<MultiSportSession><Id>2026-11-12T09:00:00Z</Id></MultiSportSession></Activities>'), 'multisport'],
    ['no Id', tcx(TWO_LAPS, { id: null }), 'activity_id'],
    ['two Ids', tcx(TWO_LAPS, { activityExtra: '<Id>2026-11-12T07:00:00Z</Id>' }), 'activity_id'],
    ['an Id without a zone', tcx(TWO_LAPS, { id: '2026-11-12T07:00:00' }), 'activity_id'],
    ['no laps', tcx([]), 'no_laps'],
    ['a lap without StartTime', tcx([{ start: null }]), 'start_time_missing'],
    ['a StartTime without a zone', tcx([{ start: '2026-11-12T07:00:00' }]), 'start_time_invalid'],
    ['a StartTime with microseconds', tcx([{ start: '2026-11-12T07:00:00.000001Z' }]), 'start_time_invalid'],
    ['an impossible StartTime', tcx([{ start: '2026-02-30T07:00:00Z' }]), 'start_time_invalid'],
    ['a date-only StartTime', tcx([{ start: '2026-11-12' }]), 'start_time_invalid'],
    ['laps that start at the same time', tcx([TWO_LAPS[0]!, { ...TWO_LAPS[1], start: '2026-11-12T07:00:00Z' }]), 'lap_order'],
    ['laps out of order (never reordered)', tcx([TWO_LAPS[1]!, TWO_LAPS[0]!]), 'lap_order'],
    ['a lap without TotalTimeSeconds', tcx([{ total: null }]), 'field_missing'],
    ['a lap without DistanceMeters', tcx([{ distance: null }]), 'field_missing'],
    ['two TotalTimeSeconds', tcx([{ inner: '<TotalTimeSeconds>1</TotalTimeSeconds>' }]), 'field_duplicate'],
    ['two DistanceMeters', tcx([{ inner: '<DistanceMeters>1</DistanceMeters>' }]), 'field_duplicate'],
    ['an element inside a value', tcx([{ total: '<b>600</b>' }]), 'structure'],
    ['a value that is too long', tcx([{ total: `1${'0'.repeat(TCX_IMPORT_MAX_TEXT_LENGTH)}` }]), 'text_too_long'],
    ['a StartTime that is too long', tcx([{ start: `2026-11-12T07:00:00.${'0'.repeat(TCX_IMPORT_MAX_TEXT_LENGTH)}Z` }]), 'text_too_long'],
    ['a start before 2000', tcx([{ start: '1999-12-31T23:59:59Z' }]), 'start_before_minimum'],
    ['a start more than a day ahead', tcx([{ start: '2026-11-14T12:00:01Z' }]), 'start_in_future'],
    ['a zero total time', tcx([{ total: '0' }]), 'duration_out_of_range'],
    ['a total time that rounds to 0', tcx([{ total: '0.4999' }]), 'duration_out_of_range'],
    ['a total time that rounds above 48 hours', tcx([{ total: '172800.5' }]), 'duration_out_of_range'],
    ['an enormous total time', tcx([{ total: '9'.repeat(60) }]), 'duration_out_of_range'],
    ['a distance that rounds above 1000 km', tcx([{ distance: '1000000.5' }]), 'distance_out_of_range'],
  ];

  it.each(cases)('refuses %s', (_label, file, reason) => {
    expect(reasonOf(file)).toBe(reason);
  });

  it.each(['-1', '-0', '-0.0', '1e3', '1E-2', 'NaN', 'INF', '-INF', '', ' ', '1.2.3', '12a', '0x10', '1,5', '∞', '١٢'])(
    'refuses %j as a lap value',
    (value) => {
      expect(reasonOf(tcx([{ total: value }]))).toBe('number_invalid');
      expect(reasonOf(tcx([{ distance: value }]))).toBe('number_invalid');
    },
  );

  it('accepts the boundaries of the totals', () => {
    expect(read(tcx([{ distance: '1000000.4999', total: '172800.4999' }])).summary).toMatchObject({ distanceM: 1_000_000, reportedDurationS: 172_800 });
    expect(read(tcx([{ total: '0.5' }])).summary.reportedDurationS).toBe(1);
    expect(read(tcx([{ start: '2000-01-01T00:00:00Z' }])).summary.startedAt).toBe('2000-01-01T00:00:00.000Z');
    expect(read(tcx([{ start: '2026-11-14T12:00:00Z' }])).summary.startedAt).toBe('2026-11-14T12:00:00.000Z');
    expect(read(tcx([{ start: '2026-11-12T07:00:00.120000Z' }])).summary.startedAt).toBe('2026-11-12T07:00:00.120Z');
  });

  it('never quotes the file in a message', () => {
    const files = [
      tcx([{ total: `-${MARKER_LAT}` }]),
      tcx([{ distance: MARKER_NOTE }]),
      tcx([{ start: MARKER_CREATOR }]),
      tcx([{ inner: trackpoints('2026-11-12T07:00:00Z') }, { start: '2026-11-12T06:00:00Z', inner: trackpoints('x') }]),
      tcx(TWO_LAPS, { id: MARKER_NOTE }),
    ];
    for (const file of files) {
      const { message } = refusal(file);
      for (const marker of [MARKER_LAT, MARKER_NOTE, MARKER_CREATOR, '2026-11-12', '06:00']) expect(message).not.toContain(marker);
    }
    expect(refusal(tcx([TWO_LAPS[0]!, { ...TWO_LAPS[1], total: 'x' }])).message).toMatch(/^lap 2: TotalTimeSeconds/u);
  });
});

describe('readTcxActivity: resource limits', () => {
  const laps = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ distance: '1', start: new Date(Date.parse('2026-11-12T00:00:00Z') + index * 1_000).toISOString(), total: '1' }));

  it(`accepts ${String(TCX_IMPORT_MAX_LAPS)} laps and refuses one more`, () => {
    expect(read(tcx(laps(TCX_IMPORT_MAX_LAPS))).summary).toMatchObject({ distanceM: TCX_IMPORT_MAX_LAPS, lapCount: TCX_IMPORT_MAX_LAPS, reportedDurationS: TCX_IMPORT_MAX_LAPS });
    expect(reasonOf(tcx(laps(TCX_IMPORT_MAX_LAPS + 1)))).toBe('too_many_laps');
  });

  it(`refuses nesting deeper than ${String(TCX_IMPORT_MAX_DEPTH)} levels, also inside skipped content`, () => {
    // The root is level 1 and Extensions level 2, so this nests exactly to the limit, then one level more.
    const nest = (levels: number) => `${'<x:n>'.repeat(levels)}${'</x:n>'.repeat(levels)}`;
    const within = tcx(TWO_LAPS, { afterActivities: `<Extensions xmlns:x="urn:x">${nest(TCX_IMPORT_MAX_DEPTH - 2)}</Extensions>` });
    expect(read(within).summary.lapCount).toBe(2);
    const deeper = tcx(TWO_LAPS, { afterActivities: `<Extensions xmlns:x="urn:x">${nest(TCX_IMPORT_MAX_DEPTH - 1)}</Extensions>` });
    expect(reasonOf(deeper)).toBe('too_deep');
  });

  it(`refuses more than ${String(TCX_IMPORT_MAX_ELEMENTS)} elements, counted while reading`, () => {
    const used = (text: string) => text.match(/<[A-Za-z]/gu)!.length;
    const base = tcx(TWO_LAPS, { afterActivities: '<Extensions></Extensions>' });
    const room = TCX_IMPORT_MAX_ELEMENTS - used(base);
    const at = base.replace('<Extensions></Extensions>', `<Extensions>${'<e/>'.repeat(room)}</Extensions>`);
    expect(read(at).summary.lapCount).toBe(2);
    expect(reasonOf(at.replace('<Extensions>', '<Extensions><e/>'))).toBe('too_many_elements');
  });

  it('refuses a body above the byte limit before reading it', () => {
    expect(() => readTcxActivity(new Uint8Array(TCX_IMPORT_MAX_BYTES + 1), NOW_MS)).toThrow(RangeError);
  });

  it('refuses a hostile 10 MiB tag quickly', () => {
    const started = performance.now();
    expect(reasonOf(`<TrainingCenterDatabase ${'x'.repeat(TCX_IMPORT_MAX_BYTES - 64)}>`)).toBe('malformed_xml');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('TCX decimals and instants', () => {
  it('parses non-negative decimals exactly and spells them canonically', () => {
    const spell = (text: string) => {
      const parsed = parseTcxDecimal(text);
      return parsed === null ? null : canonicalDecimal(parsed);
    };
    expect(['0', '00.000', '+0', '12', '012.50', '.5', '5.', '1609.3399658203125'].map(spell)).toEqual(['0', '0', '0', '12', '12.5', '0.5', '5', '1609.3399658203125']);
    expect(spell('-0')).toBeNull();
    expect(spell('1e2')).toBeNull();
  });

  it('rounds canonical decimals half up', () => {
    expect(['0.5', '1.4999999999999999999', '2.5', '172800.4999', '0'].map(tcxRoundHalfUp)).toEqual([1, 1, 3, 172_800, 0]);
  });

  it('accepts instants with a zone and at most millisecond precision only', () => {
    expect(parseTcxInstant('2026-11-12T07:00:00Z')).toBe(Date.parse('2026-11-12T07:00:00Z'));
    expect(parseTcxInstant(' 2026-11-12T08:00:00.5+01:00 ')).toBe(Date.parse('2026-11-12T07:00:00.500Z'));
    expect(parseTcxInstant('2026-11-12T07:00:00.123000Z')).toBe(Date.parse('2026-11-12T07:00:00.123Z'));
    for (const text of ['2026-11-12T07:00:00', '2026-11-12T07:00:00.1234Z', '2026-11-12T24:00:00Z', '2026-11-12T07:00:00+24:00', ' 2026-11-12T07:00:00Z']) {
      expect(parseTcxInstant(text)).toBeNull();
    }
  });
});
