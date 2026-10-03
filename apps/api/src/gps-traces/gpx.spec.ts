import { describe, expect, it } from 'vitest';

import { parseGpx } from './gpx.js';
import { RawTraceError } from './raw-trace.js';

// Obviously private synthetic input: no real person's location. The marker values must never reappear in a message.
const PRIVATE_LAT = '52.229676';
const PRIVATE_LON = '21.012229';

interface PointSpec {
  readonly lat?: string | undefined;
  readonly lon?: string | undefined;
  readonly time?: string | undefined;
  readonly extensions?: string | undefined;
  readonly body?: string | undefined;
}

function trkpt(point: PointSpec): string {
  const attributes = [
    point.lat === undefined ? '' : ` lat="${point.lat}"`,
    point.lon === undefined ? '' : ` lon="${point.lon}"`,
  ].join('');
  const time = point.time === undefined ? '' : `<time>${point.time}</time>`;
  return `<trkpt${attributes}><ele>111.5</ele>${time}${point.extensions ?? ''}${point.body ?? ''}</trkpt>`;
}

function gpx(points: readonly PointSpec[], options: { header?: string; segments?: number } = {}): string {
  const segments = options.segments ?? 1;
  const perSegment = Math.ceil(points.length / segments);
  const chunks = Array.from({ length: segments }, (_, index) =>
    points.slice(index * perSegment, (index + 1) * perSegment),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
${options.header ?? ''}<gpx version="1.1" creator="Some Device 123" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata><name>Alex's morning run</name><author><name>Alex Example</name></author><time>2026-03-04T05:06:07Z</time></metadata>
  <wpt lat="${PRIVATE_LAT}" lon="${PRIVATE_LON}"><name>Home</name></wpt>
  <trk><name>Run</name>${chunks.map((chunk) => `<trkseg>${chunk.map(trkpt).join('\n')}</trkseg>`).join('')}</trk>
</gpx>`;
}

const GOOD: PointSpec[] = [
  { lat: PRIVATE_LAT, lon: PRIVATE_LON, time: '2026-03-04T05:06:07Z' },
  { lat: '52.229686', lon: '21.012239', time: '2026-03-04T05:06:08Z' },
  { lat: '52.229696', lon: '21.012249', time: '2026-03-04T05:06:09.500Z' },
];

function rejection(text: string): string {
  try {
    parseGpx(text);
  } catch (error) {
    expect(error).toBeInstanceOf(RawTraceError);
    return (error as Error).message;
  }
  throw new Error('The GPX file was accepted');
}

describe('GPX parsing', () => {
  it('reads latitude, longitude and time, and nothing else', () => {
    const trace = parseGpx(gpx(GOOD));
    expect(trace.points).toEqual([
      { latitude: 52.229676, longitude: 21.012229, timeMs: Date.parse('2026-03-04T05:06:07Z') },
      { latitude: 52.229686, longitude: 21.012239, timeMs: Date.parse('2026-03-04T05:06:08Z') },
      { latitude: 52.229696, longitude: 21.012249, timeMs: Date.parse('2026-03-04T05:06:09.500Z') },
    ]);
    // Metadata, waypoints, names, authors and the creator never reach the model.
    expect(JSON.stringify(trace)).not.toMatch(/Alex|Home|Device|morning|111\.5/u);
  });

  it('accepts offsets, fractional seconds, single quotes, comments and CDATA', () => {
    const text = `<gpx version='1.1'><!-- <trkpt lat="1" lon="1"> in a comment --><trk><trkseg>
      <trkpt lat='10.5' lon='20.5'><time>2026-03-04T07:06:07.123456+02:00</time></trkpt>
      <trkpt lat='10.5001' lon='20.5001'><time><![CDATA[2026-03-04T05:06:08Z]]></time></trkpt>
    </trkseg></trk></gpx>`;
    const trace = parseGpx(text);
    expect(trace.points.map((point) => point.timeMs)).toEqual([
      Date.parse('2026-03-04T05:06:07.123Z'),
      Date.parse('2026-03-04T05:06:08.000Z'),
    ]);
  });

  it('reads accuracy in metres from an extension element, with or without a namespace prefix', () => {
    const trace = parseGpx(
      gpx([
        { ...(GOOD[0] as PointSpec), extensions: '<extensions><gpxtpx:TrackPointExtension><gpxtpx:accuracy>4.5</gpxtpx:accuracy></gpxtpx:TrackPointExtension></extensions>' },
        { ...(GOOD[1] as PointSpec), extensions: '<extensions><accuracy>6</accuracy></extensions>' },
      ]),
    );
    expect(trace.points.map((point) => point.accuracyM)).toEqual([4.5, 6]);
  });

  it('does not treat HDOP as metres', () => {
    const trace = parseGpx(gpx(GOOD.map((point) => ({ ...point, body: '<hdop>1.2</hdop>' }))));
    expect(trace.points.every((point) => point.accuracyM === undefined)).toBe(true);
  });

  it('rejects accuracy that is present on some points only', () => {
    const points = [
      { ...(GOOD[0] as PointSpec), extensions: '<extensions><accuracy>4</accuracy></extensions>' },
      GOOD[1] as PointSpec,
    ];
    expect(rejection(gpx(points))).toMatch(/accuracy.*every point or none/u);
  });

  it('rejects a negative or non-numeric accuracy', () => {
    for (const value of ['-1', 'abc']) {
      const points = GOOD.map((point) => ({ ...point, extensions: `<extensions><accuracy>${value}</accuracy></extensions>` }));
      expect(rejection(gpx(points))).toMatch(/trkpt #1.*accuracy/u);
    }
  });

  it('rejects DTDs and entity declarations instead of expanding them', () => {
    const header = '<!DOCTYPE gpx [<!ENTITY a "x">]>\n';
    expect(rejection(gpx(GOOD, { header }))).toMatch(/DOCTYPE|DTD/u);
  });

  it('rejects documents that are not GPX, malformed, or empty of track points', () => {
    expect(rejection('<kml></kml>')).toMatch(/not a GPX/u);
    expect(rejection('not xml at all')).toMatch(/XML/u);
    expect(rejection('<gpx><trk><trkseg><trkpt lat="1" lon="1"></trkseg></trk></gpx>')).toMatch(/malformed/iu);
    expect(rejection('<gpx><trk><trkseg></trkseg></trk></gpx>')).toMatch(/no track points/u);
    expect(rejection('<gpx><wpt lat="1" lon="2"/></gpx>')).toMatch(/no track points/u);
    expect(rejection('')).toMatch(/XML|empty/iu);
  });

  it('rejects a single track point: a trace needs at least two', () => {
    expect(rejection(gpx([GOOD[0] as PointSpec]))).toMatch(/at least 2/u);
  });

  it('rejects several track segments rather than silently joining them', () => {
    expect(rejection(gpx(GOOD, { segments: 2 }))).toMatch(/2 track segments.*one continuous/u);
  });

  it('rejects a point without coordinates or with unparsable or out-of-range coordinates', () => {
    expect(rejection(gpx([{ ...(GOOD[0] as PointSpec), lat: undefined }, GOOD[1] as PointSpec]))).toMatch(/trkpt #1.*lat/u);
    expect(rejection(gpx([GOOD[0] as PointSpec, { ...(GOOD[1] as PointSpec), lon: undefined }]))).toMatch(/trkpt #2.*lon/u);
    expect(rejection(gpx([{ ...(GOOD[0] as PointSpec), lat: 'north' }, GOOD[1] as PointSpec]))).toMatch(/trkpt #1.*lat/u);
    expect(rejection(gpx([{ ...(GOOD[0] as PointSpec), lat: 'NaN' }, GOOD[1] as PointSpec]))).toMatch(/trkpt #1.*lat/u);
    expect(rejection(gpx([{ ...(GOOD[0] as PointSpec), lat: '91' }, GOOD[1] as PointSpec]))).toMatch(/trkpt #1.*latitude.*range/u);
    expect(rejection(gpx([GOOD[0] as PointSpec, { ...(GOOD[1] as PointSpec), lon: '180.5' }]))).toMatch(/trkpt #2.*longitude.*range/u);
  });

  it('rejects the exact (0, 0) coordinate, which is how receivers report "no fix"', () => {
    expect(rejection(gpx([{ ...(GOOD[0] as PointSpec), lat: '0', lon: '0.0' }, GOOD[1] as PointSpec]))).toMatch(/trkpt #1.*0, 0/u);
  });

  it('rejects missing, unparsable and timezone-less timestamps', () => {
    const { time: _time, ...withoutTime } = GOOD[1] as PointSpec;
    void _time;
    expect(rejection(gpx([GOOD[0] as PointSpec, withoutTime]))).toMatch(/trkpt #2.*time/u);
    for (const time of ['yesterday', '2026-13-04T05:06:07Z', '2026-02-30T05:06:07Z', '2026-03-04T05:06:07', '2026-03-04 05:06:07Z']) {
      expect(rejection(gpx([GOOD[0] as PointSpec, { ...(GOOD[1] as PointSpec), time }])), time).toMatch(/trkpt #2.*time/u);
    }
  });

  it('rejects duplicate timestamps and time that goes backwards, naming the points', () => {
    const duplicate = [GOOD[0] as PointSpec, { ...(GOOD[1] as PointSpec), time: (GOOD[0] as PointSpec).time as string }];
    expect(rejection(gpx(duplicate))).toMatch(/trkpt #2.*same time.*trkpt #1/u);
    const backwards = [GOOD[1] as PointSpec, GOOD[0] as PointSpec];
    expect(rejection(gpx(backwards))).toMatch(/trkpt #2.*before.*trkpt #1/u);
  });

  it('never repeats raw coordinates or times in an error message', () => {
    const messages = [
      rejection(gpx([{ ...(GOOD[0] as PointSpec), lat: '91.123456' }, GOOD[1] as PointSpec])),
      rejection(gpx([GOOD[1] as PointSpec, GOOD[0] as PointSpec])),
      rejection(gpx([{ ...(GOOD[0] as PointSpec), lat: 'private-52.229676' }, GOOD[1] as PointSpec])),
      rejection(gpx([{ ...(GOOD[0] as PointSpec), time: '2026-03-04T05:06:07' }, GOOD[1] as PointSpec])),
    ];
    for (const message of messages) {
      expect(message).not.toMatch(/52\.2296|21\.0122|91\.1234|2026-03-04|05:06:0/u);
    }
  });
});
