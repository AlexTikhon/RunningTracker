import { describe, expect, it } from 'vitest';

import { createLogger, describeError } from './logger.js';

function capture(): { lines: string[]; write: (level: string, line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (_level, line) => void lines.push(line) };
}

const clock = { utcNow: () => new Date('2033-01-10T00:00:00.000Z') };

describe('P11.1 structured logger', () => {
  it('writes one JSON line with time, level, event, and allow-listed technical fields', () => {
    const sink = capture();
    const logger = createLogger({ clock, write: sink.write });

    logger.info('http.request', {
      durationMs: 12.5,
      method: 'POST',
      requestId: '7c0f2d36-3b8f-4d40-8a55-0e5a3c9b6f11',
      route: '/api/orgs/:uuid/runs/:uuid/points',
      status: 200,
    });

    expect(sink.lines).toHaveLength(1);
    expect(JSON.parse(sink.lines[0] ?? '')).toEqual({
      durationMs: 12.5,
      event: 'http.request',
      level: 'info',
      method: 'POST',
      requestId: '7c0f2d36-3b8f-4d40-8a55-0e5a3c9b6f11',
      route: '/api/orgs/:uuid/runs/:uuid/points',
      status: 200,
      time: '2033-01-10T00:00:00.000Z',
    });
    expect(sink.lines[0]).not.toContain('\n');
  });

  it('drops every field that is not allow-listed and reports only how many were dropped', () => {
    const sink = capture();
    const logger = createLogger({ clock, write: sink.write });

    logger.warn('probe', {
      accuracyM: 4,
      authorization: 'Bearer secret-token',
      body: { points: [{ latitude: 51.5, longitude: -0.12 }] },
      cookie: 'rt_session=abc',
      latitude: 51.5,
      longitude: -0.12,
      password: 'hunter2',
      payload: '{}',
      requestId: 'r1',
      sessionToken: 'abc',
      token: 'abc',
    });

    const entry = JSON.parse(sink.lines[0] ?? '') as Record<string, unknown>;
    expect(entry).toEqual({
      droppedFields: 10,
      event: 'probe',
      level: 'warn',
      requestId: 'r1',
      time: '2033-01-10T00:00:00.000Z',
    });
    const text = sink.lines[0] ?? '';
    for (const secret of ['secret-token', 'rt_session', '51.5', '-0.12', 'hunter2', 'latitude']) {
      expect(text).not.toContain(secret);
    }
  });

  it('cannot be tricked into overriding reserved keys or emitting non-primitive values', () => {
    const sink = capture();
    const logger = createLogger({ clock, write: sink.write });

    logger.error('real.event', {
      event: 'forged',
      level: 'debug',
      outcome: { nested: 'object' } as unknown as string,
      requestId: 'a'.repeat(500),
      status: Number.NaN,
      task: 'ok',
      time: 'forged',
    });

    const entry = JSON.parse(sink.lines[0] ?? '') as Record<string, unknown>;
    expect(entry.event).toBe('real.event');
    expect(entry.level).toBe('error');
    expect(entry.time).toBe('2033-01-10T00:00:00.000Z');
    expect(entry.task).toBe('ok');
    expect(entry).not.toHaveProperty('outcome');
    expect(entry).not.toHaveProperty('status');
    expect((entry.requestId as string).length).toBeLessThanOrEqual(200);
    expect(entry.droppedFields).toBe(5);
  });

  it('never fails the caller when the sink throws or a getter throws', () => {
    const logger = createLogger({
      clock,
      write: () => {
        throw new Error('disk full');
      },
    });
    expect(() => logger.error('x', { requestId: 'r' })).not.toThrow();

    const sink = capture();
    const safe = createLogger({ clock, write: sink.write });
    const hostile = {
      get requestId(): string {
        throw new Error('boom');
      },
    };
    expect(() => safe.info('x', hostile)).not.toThrow();
  });

  it('describes an error by class name and short code only, never by message or stack', () => {
    const pgLike = Object.assign(new Error('duplicate key value (org=…, seq=…) postgresql://u:p@h/db'), {
      code: '23505',
    });

    expect(describeError(pgLike)).toEqual({ errorCode: '23505', errorName: 'Error' });
    expect(describeError(new TypeError('secret'))).toEqual({ errorName: 'TypeError' });
    expect(describeError('string with secret')).toEqual({ errorName: 'UnknownError' });
    expect(describeError(Object.assign(new Error('x'), { code: 'not a short code because it has spaces' }))).toEqual({
      errorName: 'Error',
    });
  });

  it('honours the configured minimum level', () => {
    const sink = capture();
    const logger = createLogger({ clock, minLevel: 'warn', write: sink.write });

    logger.info('quiet');
    logger.warn('loud');
    logger.error('louder');

    expect(sink.lines.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual([
      'loud',
      'louder',
    ]);
  });
});
