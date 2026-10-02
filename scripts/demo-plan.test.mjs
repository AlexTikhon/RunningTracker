import assert from 'node:assert/strict';
import test from 'node:test';

import {
  demoIds,
  demoRoute,
  extractSessionCookie,
  parseDemoRunArguments,
  requireDevelopmentDatabase,
} from './demo-plan.mjs';

test('the demo identities are distinct canonical UUIDs', () => {
  const values = Object.values(demoIds);
  assert.equal(new Set(values).size, values.length);
  for (const value of values) {
    assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('the route is a deterministic loop of consecutive points two seconds apart', () => {
  const start = Date.parse('2026-10-02T10:00:00.000Z');
  const first = demoRoute({ count: 60, startMs: start });
  const second = demoRoute({ count: 60, startMs: start });
  assert.deepEqual(first, second);
  assert.equal(first.length, 60);
  assert.deepEqual(
    first.map((point) => point.seq),
    Array.from({ length: 60 }, (_, index) => String(index + 1)),
  );
  first.forEach((point, index) => {
    assert.equal(Date.parse(point.recordedAt), start + index * 2_000);
    assert.equal(point.segmentId, 0);
    assert.ok(point.longitude >= -180 && point.longitude <= 180);
    assert.ok(point.latitude >= -90 && point.latitude <= 90);
    assert.ok(point.accuracyM > 0 && point.accuracyM <= 10);
    assert.deepEqual(Object.keys(point).sort(), [
      'accuracyM',
      'latitude',
      'longitude',
      'recordedAt',
      'segmentId',
      'seq',
    ]);
  });
});

test('consecutive route points are a plausible running distance apart', () => {
  const route = demoRoute({ count: 60, startMs: 0 });
  const metresPerDegreeLatitude = 111_320;
  for (let index = 1; index < route.length; index += 1) {
    const previous = route[index - 1];
    const current = route[index];
    const north = (current.latitude - previous.latitude) * metresPerDegreeLatitude;
    const east =
      (current.longitude - previous.longitude) *
      metresPerDegreeLatitude *
      Math.cos((current.latitude * Math.PI) / 180);
    const speed = Math.hypot(north, east) / 2;
    assert.ok(speed > 2 && speed < 6, `speed ${speed} m/s at step ${index}`);
  }
});

test('a route rejects counts outside the ingestion batch and run limits', () => {
  assert.throws(() => demoRoute({ count: 0, startMs: 0 }), RangeError);
  assert.throws(() => demoRoute({ count: 2.5, startMs: 0 }), RangeError);
  assert.throws(() => demoRoute({ count: 5_001, startMs: 0 }), RangeError);
});

test('run arguments default to the local API and a two minute run', () => {
  assert.deepEqual(parseDemoRunArguments([]), {
    apiUrl: 'http://127.0.0.1:3000',
    origin: 'http://127.0.0.1:5173',
    points: 60,
  });
});

test('run arguments accept overrides and reject anything unknown', () => {
  assert.deepEqual(
    parseDemoRunArguments(['--points', '10', '--api-url', 'http://127.0.0.1:4000/', '--origin', 'http://localhost:5173']),
    { apiUrl: 'http://127.0.0.1:4000', origin: 'http://localhost:5173', points: 10 },
  );
  assert.throws(() => parseDemoRunArguments(['--points']), /--points/);
  assert.throws(() => parseDemoRunArguments(['--points', 'abc']), /--points/);
  assert.throws(() => parseDemoRunArguments(['--points', '0']), /--points/);
  assert.throws(() => parseDemoRunArguments(['--api-url', 'ftp://x']), /--api-url/);
  assert.throws(() => parseDemoRunArguments(['--api-url', 'http://user:pw@127.0.0.1:3000']), /--api-url/);
  assert.throws(() => parseDemoRunArguments(['--unknown']), /--unknown/);
});

test('the driver only talks to a loopback API', () => {
  assert.throws(() => parseDemoRunArguments(['--api-url', 'http://example.com']), /loopback/);
  assert.doesNotThrow(() => parseDemoRunArguments(['--api-url', 'http://localhost:3000']));
});

test('the session cookie is the single name=value pair, nothing else', () => {
  assert.equal(
    extractSessionCookie([
      'running_tracker_session=abc123; Path=/; HttpOnly; SameSite=Strict',
    ]),
    'running_tracker_session=abc123',
  );
  assert.throws(() => extractSessionCookie([]), /session cookie/);
  assert.throws(() => extractSessionCookie(['other=1; Path=/']), /session cookie/);
});

test('seeding is allowed only into the plain development database as the owner', () => {
  const ok = 'postgresql://running_tracker_owner:owner_local_only@127.0.0.1:5433/running_tracker';
  assert.doesNotThrow(() => requireDevelopmentDatabase(ok));
  assert.throws(
    () => requireDevelopmentDatabase(ok.replace('running_tracker_owner', 'running_tracker_runtime')),
    /running_tracker_owner/,
  );
  assert.throws(() => requireDevelopmentDatabase(ok.replace('127.0.0.1', 'db.example.com')), /loopback/);
  assert.throws(() => requireDevelopmentDatabase(ok.replace(/\/running_tracker$/, '/running_tracker_test')), /running_tracker/);
  assert.throws(() => requireDevelopmentDatabase(ok.replace(/\/running_tracker$/, '/prod')), /running_tracker/);
  assert.throws(() => requireDevelopmentDatabase(undefined), /MIGRATION_DATABASE_URL/);
});
