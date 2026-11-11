import {
  GPX_IMPORT_MAX_POINTS,
  GPX_IMPORT_MAX_SEGMENTS,
  GPX_IMPORT_METRICS_VERSION,
  type GpxUnsupportedReason,
} from '@running-tracker/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GpxImportError, readGpxActivity } from './gpx-activity.js';

// Synthetic tracks on the equator (no real person's location): along the equator, 0.001 degrees of longitude is
// 6 378 137 m x 0.001 x pi / 180 = 111.319 491 m on the WGS84 ellipsoid, so expected distances are exact by hand.
const EQUATOR_M_PER_MILLIDEGREE = (6_378_137 * 0.001 * Math.PI) / 180;
const NOW_MS = Date.parse('2026-11-10T12:00:00Z');
const T0 = Date.parse('2026-11-08T07:00:00Z');
// Marker values that must never reappear in an error message.
const MARKER_LON = '10.123457';
const MARKER_TIME = '2026-11-08T07:00:00Z';

interface Point {
  readonly lat?: string;
  readonly lon?: string;
  readonly time?: string | null;
  readonly inner?: string;
}

const at = (seconds: number) => new Date(T0 + seconds * 1_000).toISOString();
const equator = (millidegrees: number, seconds: number): Point => ({
  lat: '0',
  lon: (10 + millidegrees / 1_000).toFixed(6),
  time: at(seconds),
});

function trkpt(point: Point): string {
  const lat = point.lat === undefined ? '' : ` lat="${point.lat}"`;
  const lon = point.lon === undefined ? '' : ` lon="${point.lon}"`;
  const time = point.time === null || point.time === undefined ? '' : `<time>${point.time}</time>`;
  return `<trkpt${lat}${lon}><ele>12.5</ele>${time}${point.inner ?? ''}</trkpt>`;
}

function gpx(
  segments: readonly (readonly Point[])[],
  options: { header?: string; root?: string; trackExtra?: string; afterTrack?: string } = {},
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
${options.header ?? ''}${options.root ?? '<gpx version="1.1" creator="Synthetic" xmlns="http://www.topografix.com/GPX/1/1">'}
  <metadata><name>Synthetic morning</name><time>${MARKER_TIME}</time></metadata>
  <wpt lat="1.5" lon="${MARKER_LON}"><name>Somewhere</name><time>${MARKER_TIME}</time></wpt>
  <trk><name>Synthetic</name>${options.trackExtra ?? ''}${segments.map((points) => `<trkseg>${points.map(trkpt).join('\n')}</trkseg>`).join('')}</trk>
  ${options.afterTrack ?? ''}
</gpx>`;
}

const GPX_NS = 'http://www.topografix.com/GPX/1/1';
const GARMIN_NS = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1';
const GPX_ELEMENTS = /<(\/?)(gpx|metadata|name|time|wpt|trk|trkseg|trkpt|ele|extensions|rte|rtept|desc)(?=[\s/>])/gu;

/** The same document with every GPX element (not extension content) written with the `g:` prefix. */
const prefixed = (text: string) => text.replace(GPX_ELEMENTS, '<$1g:$2');

const bytes = (text: string) => new TextEncoder().encode(text);
const read = (text: string, nowMs = NOW_MS) => readGpxActivity(bytes(text), nowMs);

function rejection(input: string | Uint8Array, nowMs = NOW_MS): GpxImportError {
  try {
    readGpxActivity(typeof input === 'string' ? bytes(input) : input, nowMs);
  } catch (error) {
    expect(error).toBeInstanceOf(GpxImportError);
    return error as GpxImportError;
  }
  throw new Error('The GPX file was accepted');
}

const TWO_SEGMENTS = [
  [equator(0, 0), equator(1, 10), equator(2, 20)],
  // 8 millidegrees (about 890 m) and 280 s after the first segment ended: not counted as distance.
  [equator(10, 300), equator(11, 310)],
];

describe('GPX activity import reader (ADR-0086)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads one track with several segments into a summary of start, elapsed time and in-segment distance', () => {
    const { startedAtMs, summary } = read(gpx(TWO_SEGMENTS));
    expect(startedAtMs).toBe(T0);
    expect(summary).toEqual({
      // Three edges of 1 millidegree; the 8-millidegree jump between segments is not distance.
      distanceM: Math.round(3 * EQUATOR_M_PER_MILLIDEGREE),
      // First to last point, the 280 s between the segments included: elapsed time, not moving time.
      elapsedDurationS: 310,
      endedAt: at(310),
      metricsVersion: GPX_IMPORT_METRICS_VERSION,
      pointCount: 5,
      segmentCount: 2,
      startedAt: at(0),
    });
    expect(summary.distanceM).toBe(334);
  });

  it('matches the geodesic of the shared trace tools to well under a metre over a longer track', () => {
    // 1 000 points, 5 m/s along the equator for 999 s: 999 edges of 0.045 millidegrees.
    const points = Array.from({ length: 1_000 }, (_, index) => equator(index * 0.045, index));
    const { summary } = read(gpx([points]));
    expect(Math.abs(summary.distanceM - 999 * 0.045 * EQUATOR_M_PER_MILLIDEGREE)).toBeLessThan(1);
  });

  it('rounds elapsed time to the nearest second, half up, and distance to the nearest metre', () => {
    const halfUp = read(gpx([[{ ...equator(0, 0), time: '2026-11-08T07:00:00.000Z' }, { ...equator(0.001, 0), time: '2026-11-08T07:00:01.500Z' }]]));
    expect(halfUp.summary.elapsedDurationS).toBe(2);
    const down = read(gpx([[{ ...equator(0, 0), time: '2026-11-08T07:00:00Z' }, { ...equator(0.001, 0), time: '2026-11-08T07:00:01.499Z' }]]));
    expect(down.summary.elapsedDurationS).toBe(1);
    // Fractions beyond milliseconds are truncated, as for the trace tools; offsets are honoured.
    const offset = read(gpx([[{ ...equator(0, 0), time: '2026-11-08T08:00:00.0004+01:00' }, { ...equator(0, 0), lon: '10.000001', time: '2026-11-08T07:00:05Z' }]]));
    expect(offset.summary).toMatchObject({ elapsedDurationS: 5, startedAt: '2026-11-08T07:00:00.000Z' });
    expect(offset.summary.distanceM).toBe(0);
  });

  it('accepts a byte-order mark, a fully prefixed GPX 1.1 document, CDATA, comments, extensions and skipped elements', () => {
    // Every GPX element carries the prefix: with no default namespace, an unprefixed child would be in no namespace.
    const text = prefixed(
      gpx(
        [[{ ...equator(0, 0), inner: `<extensions><gpxtpx:hr>140</gpxtpx:hr><trkseg>ignored</trkseg></extensions>` }, { ...equator(1, 10), time: `<![CDATA[${at(10)}]]>` }]],
        {
          afterTrack: '<rte><rtept lat="1" lon="1"><time>2020-01-01T00:00:00Z</time></rtept></rte><!-- a comment -->',
          root: `<gpx version="1.1" creator="Synthetic" xmlns:g="${GPX_NS}" xmlns:gpxtpx="${GARMIN_NS}">`,
        },
      ),
    );
    expect(text).toContain('<g:trkpt');
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(text)]);
    const { summary } = readGpxActivity(withBom, NOW_MS);
    expect(summary).toMatchObject({ elapsedDurationS: 10, pointCount: 2, segmentCount: 1 });
  });

  describe('namespaces', () => {
    const one = equator(0, 0);
    const two = equator(1, 10);
    const plain = read(gpx([[one, two]]));

    it('reads the same track from a default-namespace and a fully prefixed document', () => {
      const text = prefixed(gpx([[one, two]], { root: `<gpx version="1.1" creator="Synthetic" xmlns:g="${GPX_NS}">` }));
      const result = read(text);
      expect(result.summary).toEqual(plain.summary);
      expect(result.fingerprint.equals(plain.fingerprint)).toBe(true);
    });

    it('resolves nested prefix declarations and redundant redeclarations of the GPX namespace', () => {
      const text = gpx([[one, two]]).replace(
        /<trk>(.*)<\/trk>/su,
        `<trk xmlns:t="${GPX_NS}"><name>x</name><t:trkseg xmlns="${GPX_NS}">${trkpt(one)}<t:trkpt lat="0" lon="${two.lon as string}"><t:time>${two.time as string}</t:time></t:trkpt></t:trkseg></trk>`,
      );
      expect(read(text).summary).toEqual(plain.summary);
    });

    it('skips legitimate foreign content inside <extensions>, also when it reuses GPX element names', () => {
      const extensions = [
        `<extensions><gpxtpx:TrackPointExtension xmlns:gpxtpx="${GARMIN_NS}"><gpxtpx:hr>140</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>`,
        `<extensions><vendor xmlns="urn:vendor"><time>not a time</time><trkseg><trkpt lat="1" lon="1"/></trkseg></vendor></extensions>`,
        `<extensions><v:data xmlns:v="urn:vendor"><v:trk/><inner xmlns=""><time>x</time></inner></v:data></extensions>`,
      ];
      for (const inner of extensions) {
        const result = read(gpx([[{ ...one, inner }, { ...two, inner }]], { trackExtra: inner }));
        expect(result.summary, inner).toEqual(plain.summary);
        expect(result.fingerprint.equals(plain.fingerprint), inner).toBe(true);
      }
      // A prefix declared on the root is inherited by extension content anywhere below it.
      const inherited = gpx([[{ ...one, inner: '<extensions><gpxtpx:hr>140</gpxtpx:hr></extensions>' }, two]], {
        root: `<gpx version="1.1" creator="Synthetic" xmlns="${GPX_NS}" xmlns:gpxtpx="${GARMIN_NS}">`,
      });
      expect(read(inherited).summary).toEqual(plain.summary);
    });

    const onlyTrack = (replacement: string) => gpx([[one, two]]).replace(/<trk>.*<\/trk>/su, replacement);
    const points = `${trkpt(one)}${trkpt(two)}`;
    const cases: [string, GpxUnsupportedReason, string][] = [
      ['a track in a foreign default namespace', 'track_count', onlyTrack(`<trk xmlns="urn:foreign"><trkseg>${points}</trkseg></trk>`)],
      ['a track with an undeclared prefix', 'malformed_xml', onlyTrack(`<x:trk><x:trkseg>${points}</x:trkseg></x:trk>`)],
      ['a track in no namespace (xmlns="")', 'track_count', onlyTrack(`<trk xmlns=""><trkseg>${points}</trkseg></trk>`)],
      ['a track in the GPX 1.0 namespace under a 1.1 root', 'track_count', onlyTrack(`<trk xmlns="http://www.topografix.com/GPX/1/0"><trkseg>${points}</trkseg></trk>`)],
      [
        'a prefix rebound to a foreign namespace for the track',
        'track_count',
        prefixed(gpx([[one, two]], { root: `<gpx version="1.1" creator="Synthetic" xmlns:g="${GPX_NS}">` })).replace('<g:trk>', '<g:trk xmlns:g="urn:foreign">'),
      ],
      [
        'a prefixed root whose unprefixed children are in no namespace',
        'track_count',
        gpx([[one, two]], { root: `<g:gpx version="1.1" creator="Synthetic" xmlns:g="${GPX_NS}">` }).replace('</gpx>', '</g:gpx>'),
      ],
      [
        'a GPX track inside a foreign element',
        'structure',
        onlyTrack(`<w:wrap xmlns:w="urn:foreign"><trk><trkseg>${points}</trkseg></trk></w:wrap>`),
      ],
      ['a segment in a foreign namespace', 'too_few_points', onlyTrack(`<trk><trkseg xmlns="urn:foreign">${points}</trkseg></trk>`)],
      ['points in a foreign namespace', 'empty_segment', onlyTrack(`<trk><trkseg><trkpt xmlns="urn:foreign" lat="0" lon="10"><time>${at(0)}</time></trkpt></trkseg></trk>`)],
      [
        'a prefixed time in a foreign namespace',
        'time_missing',
        gpx([[{ ...one, time: null, inner: `<t:time xmlns:t="urn:foreign">${at(0)}</t:time>` }, two]]),
      ],
      ['a time in a foreign default namespace', 'time_missing', gpx([[{ ...one, time: null, inner: `<time xmlns="urn:foreign">${at(0)}</time>` }, two]])],
      [
        'a prefix used after the element that declared it has closed',
        'malformed_xml',
        onlyTrack(`<trk><trkseg xmlns:g="${GPX_NS}">${points}</trkseg><g:trkseg>${trkpt(equator(5, 100))}</g:trkseg></trk>`),
      ],
      ['an undeclared prefix inside extensions', 'malformed_xml', gpx([[{ ...one, inner: '<extensions><gpxtpx:hr>140</gpxtpx:hr></extensions>' }, two]])],
      ['an undeclared attribute prefix on a point', 'malformed_xml', gpx([[{ ...one, inner: '' }, two]]).replace('<trkpt lat', '<trkpt x:a="1" lat')],
    ];

    it.each(cases)('refuses %s (%s)', (_label, reason, input) => {
      const error = rejection(input);
      expect(error.reason).toBe(reason);
      expect(error.message).not.toContain(MARKER_LON);
      expect(error.message).not.toMatch(/\d{4}-\d{2}-\d{2}T|10\.00\d|Synthetic|urn:foreign/u);
    });
  });

  describe('fingerprint', () => {
    const base = read(gpx(TWO_SEGMENTS)).fingerprint;

    it('is 32 bytes and ignores formatting, metadata, elevation, names and extensions', () => {
      expect(base).toHaveLength(32);
      const reformatted = gpx(
        TWO_SEGMENTS.map((segment) =>
          segment.map((point) => ({
            ...point,
            inner: '<extensions><hr>150</hr></extensions>',
            lon: `${point.lon as string}000`,
            time: (point.time as string).replace('.000Z', 'Z'),
          })),
        ),
        { trackExtra: '<desc>another description</desc>' },
      ).replace('creator="Synthetic"', 'creator="Other app"');
      expect(read(reformatted).fingerprint.equals(base)).toBe(true);
    });

    it('changes with any point, any time or a segment boundary', () => {
      const moved = TWO_SEGMENTS.map((segment, index) => (index === 1 ? [segment[0]!, { ...segment[1]!, lon: '10.011001' }] : segment));
      const retimed = TWO_SEGMENTS.map((segment, index) => (index === 1 ? [segment[0]!, { ...segment[1]!, time: at(311) }] : segment));
      const joined = [[...TWO_SEGMENTS[0]!, ...TWO_SEGMENTS[1]!]];
      for (const variant of [moved, retimed]) expect(read(gpx(variant)).fingerprint.equals(base)).toBe(false);
      // Joining the segments changes the identity, and the distance now includes the edge between them.
      const together = read(gpx(joined));
      expect(together.fingerprint.equals(base)).toBe(false);
      expect(together.summary.distanceM).toBe(Math.round(11 * EQUATOR_M_PER_MILLIDEGREE));
      const split = [[equator(0, 0), equator(1, 10)], [equator(2, 20)], [equator(10, 300), equator(11, 310)]];
      expect(read(gpx(split)).fingerprint.equals(base)).toBe(false);
    });
  });

  describe('refusals', () => {
    const one = equator(0, 0);
    const two = equator(1, 10);
    const cases: [string, GpxUnsupportedReason, string | Uint8Array][] = [
      ['invalid UTF-8', 'not_utf8', new Uint8Array([...bytes(gpx([[one, two]])).subarray(0, 60), 0xc3, 0x28])],
      ['UTF-16', 'not_utf8', new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x67, 0x00])],
      ['another declared encoding', 'not_utf8', gpx([[one, two]]).replace('encoding="UTF-8"', 'encoding="ISO-8859-1"')],
      ['an empty file', 'not_xml', ''],
      ['plain text', 'malformed_xml', 'lat,lon,time\n1,2,3'],
      ['a DOCTYPE', 'declaration', gpx([[one, two]], { header: '<!DOCTYPE gpx>\n' })],
      [
        'an external entity',
        'declaration',
        gpx([[{ ...one, time: '&xxe;' }, two]], { header: '<!DOCTYPE gpx [<!ENTITY xxe SYSTEM "http://example.invalid/t">]>\n' }),
      ],
      ['a markup declaration', 'declaration', gpx([[one, two]], { trackExtra: '<!ELEMENT trk ANY>' })],
      ['an undeclared entity reference, never expanded', 'time_invalid', gpx([[{ ...one, time: '&now;' }, two]])],
      ['a character reference in a coordinate', 'coordinates', gpx([[{ ...one, lon: '&#49;0.5' }, two]])],
      ['another root element', 'not_gpx', '<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>'],
      ['GPX 1.0', 'not_gpx_1_1', gpx([[one, two]], { root: '<gpx version="1.0" xmlns="http://www.topografix.com/GPX/1/0">' })],
      ['no namespace', 'not_gpx_1_1', gpx([[one, two]], { root: '<gpx version="1.1">' })],
      ['unclosed elements', 'malformed_xml', gpx([[one, two]]).replace('</gpx>', '')],
      ['mismatched tags', 'malformed_xml', gpx([[one, two]]).replace('</trk>', '</trkseg>')],
      ['two root elements', 'malformed_xml', `${gpx([[one, two]])}<gpx xmlns="http://www.topografix.com/GPX/1/1"></gpx>`],
      ['no track', 'track_count', gpx([]).replace(/<trk>.*<\/trk>/su, '')],
      ['two tracks', 'track_count', gpx([[one, two]], { afterTrack: `<trk><trkseg>${trkpt(equator(5, 100))}</trkseg></trk>` })],
      ['a point outside a segment', 'structure', gpx([[one, two]], { trackExtra: trkpt(equator(5, 100)) })],
      ['a track inside metadata', 'structure', gpx([[one, two]]).replace('</metadata>', '<trk/></metadata>')],
      ['two times in one point', 'structure', gpx([[{ ...one, inner: `<time>${at(1)}</time>` }, two]])],
      ['an empty segment', 'empty_segment', gpx([[one, two], []])],
      ['a single point', 'too_few_points', gpx([[one]])],
      ['a missing latitude', 'coordinates', gpx([[{ lon: '10', time: at(0) }, two]])],
      ['an exponent', 'coordinates', gpx([[{ ...one, lat: '1e-3' }, two]])],
      ['a latitude out of range', 'coordinates', gpx([[{ ...one, lat: '90.000001' }, two]])],
      ['a longitude out of range', 'coordinates', gpx([[{ ...one, lon: '-180.5' }, two]])],
      ['the 0,0 position', 'coordinates', gpx([[{ ...one, lat: '0', lon: '0' }, two]])],
      ['a missing time', 'time_missing', gpx([[{ ...one, time: null }, two]])],
      ['a time without a zone', 'time_invalid', gpx([[{ ...one, time: '2026-11-08T07:00:00' }, two]])],
      ['an impossible date', 'time_invalid', gpx([[{ ...one, time: '2026-02-30T07:00:00Z' }, two]])],
      ['a repeated time', 'time_order', gpx([[one, { ...two, time: one.time as string }]])],
      ['time going backwards', 'time_order', gpx([[two, one]])],
      ['overlapping segments', 'time_order', gpx([[one, two], [equator(2, 5), equator(3, 30)]])],
      ['a segment starting at the previous end', 'time_order', gpx([[one, two], [equator(2, 10), equator(3, 30)]])],
      ['a jump within a segment', 'implausible_speed', gpx([[one, equator(100, 10)]])],
      ['a start before 2000', 'start_before_minimum', gpx([[{ ...one, time: '1999-12-31T23:59:59Z' }, { ...two, time: '2000-01-01T00:00:09Z' }]])],
      ['a start more than 24 hours ahead', 'start_in_future', gpx([[{ ...one, time: '2026-11-11T12:00:00.001Z' }, { ...two, time: '2026-11-11T12:00:10Z' }]])],
      ['less than half a second', 'duration_out_of_range', gpx([[one, { ...two, time: '2026-11-08T07:00:00.499Z', lon: '10.000001' }]])],
      ['more than 48 hours', 'duration_out_of_range', gpx([[one, { ...one, lon: '10.000001', time: at(172_800.5) }]])],
    ];

    it.each(cases)('refuses %s (%s)', (_label, reason, input) => {
      const error = rejection(input);
      expect(error.reason).toBe(reason);
      // Never a coordinate, a time or text from the file.
      expect(error.message).not.toContain(MARKER_LON);
      expect(error.message).not.toContain(MARKER_TIME);
      expect(error.message).not.toMatch(/\d{4}-\d{2}-\d{2}T|10\.00\d|Synthetic|example\.invalid/u);
    });

    it('accepts a start exactly 24 hours ahead and exactly 48 hours of elapsed time', () => {
      expect(read(gpx([[{ ...one, time: '2026-11-11T12:00:00Z' }, { ...two, time: '2026-11-11T12:00:10Z' }]])).summary.elapsedDurationS).toBe(10);
      expect(read(gpx([[one, { ...one, lon: '10.000001', time: at(172_800) }]])).summary.elapsedDurationS).toBe(172_800);
    });

    it('refuses a track longer than 1 000 km', () => {
      // 8.99 degrees along the equator (about 1 000.8 km) in 3 hours: below the speed limit, above the distance limit.
      const error = rejection(gpx([[equator(0, 0), equator(8_990, 10_800)]]));
      expect(error.reason).toBe('distance_out_of_range');
    });

    it('fetches nothing and expands nothing that a file references', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      rejection(gpx([[one, two]], { header: '<!DOCTYPE gpx SYSTEM "http://example.invalid/gpx.dtd">\n' }));
      rejection(gpx([[{ ...one, inner: '<link href="http://example.invalid/x"/>', time: '&ext;' }, two]]));
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('limits (no truncation)', () => {
    it(`reads exactly ${String(GPX_IMPORT_MAX_POINTS)} points and refuses one more`, () => {
      const points = Array.from({ length: GPX_IMPORT_MAX_POINTS + 1 }, (_, index) => equator(index * 0.005, index));
      const atLimit = read(gpx([points.slice(0, GPX_IMPORT_MAX_POINTS)]));
      expect(atLimit.summary.pointCount).toBe(GPX_IMPORT_MAX_POINTS);
      expect(rejection(gpx([points])).reason).toBe('too_many_points');
    });

    it(`reads exactly ${String(GPX_IMPORT_MAX_SEGMENTS)} segments and refuses one more`, () => {
      const segments = Array.from({ length: GPX_IMPORT_MAX_SEGMENTS + 1 }, (_, index) => [equator(index, index * 10)]);
      expect(read(gpx(segments.slice(0, GPX_IMPORT_MAX_SEGMENTS))).summary.segmentCount).toBe(GPX_IMPORT_MAX_SEGMENTS);
      expect(rejection(gpx(segments)).reason).toBe('too_many_segments');
    });

    it('refuses to read more bytes than the upload limit allows', () => {
      expect(() => readGpxActivity(new Uint8Array(10 * 1024 * 1024 + 1), NOW_MS)).toThrow(RangeError);
    });
  });
});
