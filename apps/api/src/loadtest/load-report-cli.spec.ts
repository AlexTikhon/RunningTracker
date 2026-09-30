import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseReportArguments, runReportCli } from './load-report-cli.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'rt-report-'));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

function loadResult(startedAt: string, extra: Record<string, unknown> = {}) {
  return {
    asOf: '2026-09-30T00:00:00.000Z',
    configuration: { DB_POOL_MAX: 10 },
    failure: null,
    freshLatency: { samples: [{ latencyMs: 1_000, sampleId: 1 }], summaryMs: {}, unresolved: 0 },
    freshPoints: [{ bridge: false, sampleId: 1 }],
    gitCommit: 'abc',
    http: { ingestion: [{ endMs: 40, kind: 'fresh', startMs: 0, status: 200, unexpected: false }], lifecycle: [], polls: [], tiles: [] },
    metrics: { after: [], before: [], snapshots: [] },
    observers: [],
    profile: 'ordinary',
    schema: 'running-tracker.load-result',
    schemaVersion: 1,
    seed: 42,
    serverLog: { byEvent: {}, errorLines: 0, warnLines: 0 },
    startedAt,
    status: 'ok',
    summaryPublication: { archiveRevisionVisibleMs: 61_000, finishAckedMs: 1_000, summaryVisibleMs: 61_500, timedOut: false },
    workload: { tileBursts: 2, tileRequests: 2 },
    ...extra,
  };
}

function explainResult(startedAt: string, profile: string) {
  return {
    activatedRuns: 10,
    asOf: '2026-09-30T00:00:00.000Z',
    gitCommit: 'abc',
    host: { cpuCount: 4, cpuModel: 'CPU', osRelease: '1', platform: 'win32', totalMemoryBytes: 8 * 2 ** 30 },
    node: 'v24',
    postgis: '3.5',
    postgres: 'PostgreSQL 17',
    profile: `explain-${profile}`,
    relations: { indexes: [], settings: [], tables: [] },
    repetitions: 3,
    schema: 'running-tracker.explain-result',
    schemaVersion: 1,
    seed: 42,
    startedAt,
    statements: [],
    target: { database: 'x_load_test', host: '127.0.0.1', port: '5433' },
  };
}

async function put(name: string, value: unknown): Promise<void> {
  await writeFile(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

describe('parseReportArguments', () => {
  it('needs nothing but has defaults, and validates the instant filter', () => {
    const parsed = parseReportArguments([]);

    expect(parsed.since).toBeUndefined();
    expect(parsed.out).toBeUndefined();
    expect(() => parseReportArguments(['--since', 'yesterday'])).toThrow(/--since/u);
    expect(() => parseReportArguments(['--bogus', 'x'])).toThrow(/Unknown argument/u);
    expect(() => parseReportArguments(['--out'])).toThrow(/requires a value/u);
    expect(parseReportArguments(['--since', '2026-09-30T09:00:00.000Z']).since?.toISOString()).toBe('2026-09-30T09:00:00.000Z');
  });
});

describe('runReportCli', () => {
  it('reads load and explain results, ignores other files, filters by start time, and writes the report', async () => {
    await put('old.json', loadResult('2026-09-30T07:00:00.000Z', { profile: 'stress' }));
    await put('new-1.json', loadResult('2026-09-30T09:10:00.000Z'));
    await put('new-2.json', loadResult('2026-09-30T09:20:00.000Z'));
    await put('explain-old.json', explainResult('2026-09-30T09:00:00.000Z', 'ordinary'));
    await put('explain-new.json', explainResult('2026-09-30T09:30:00.000Z', 'ordinary'));
    await put('plans.json', { schema: 'running-tracker.explain-plans', startedAt: '2026-09-30T09:30:00.000Z' });
    await put('broken.json', '{ not json');
    await put('note.txt', 'ignored');
    const out = join(directory, 'report.md');

    const outcome = await runReportCli({
      argv: ['--results-dir', directory, '--out', out, '--since', '2026-09-30T09:00:00.000Z'],
      log: () => undefined,
    });

    const text = await readFile(out, 'utf8');
    expect(outcome.loadResults).toBe(2);
    expect(outcome.explainResults).toBe(1);
    expect(text).toContain('2 runs');
    expect(text).not.toContain('stress —');
    expect(text).toContain('explain-new.json');
    expect(text).not.toContain('explain-old.json');
    expect(text).toContain('new-1.json');
  });

  it('keeps only the newest explain result per profile', async () => {
    await put('a.json', loadResult('2026-09-30T09:10:00.000Z'));
    await put('e1.json', explainResult('2026-09-30T09:00:00.000Z', 'ordinary'));
    await put('e2.json', explainResult('2026-09-30T09:40:00.000Z', 'ordinary'));
    await put('e3.json', explainResult('2026-09-30T09:05:00.000Z', 'stress'));
    const out = join(directory, 'r.md');

    const outcome = await runReportCli({ argv: ['--results-dir', directory, '--out', out], log: () => undefined });

    expect(outcome.explainResults).toBe(3 - 1);
    const text = await readFile(out, 'utf8');
    expect(text).toContain('e2.json');
    expect(text).toContain('e3.json');
    expect(text).not.toContain('e1.json');
  });

  it('refuses when no load result matches, and never writes a file', async () => {
    await put('e.json', explainResult('2026-09-30T09:00:00.000Z', 'ordinary'));
    const out = join(directory, 'none.md');

    await expect(runReportCli({ argv: ['--results-dir', directory, '--out', out], log: () => undefined })).rejects.toThrow(
      /No load result/u,
    );
    await expect(readFile(out, 'utf8')).rejects.toThrow();
  });

  it('accepts results written before lock sampling existed', async () => {
    await put('legacy.json', loadResult('2026-09-30T09:10:00.000Z'));
    const out = join(directory, 'legacy.md');

    const outcome = await runReportCli({ argv: ['--results-dir', directory, '--out', out], log: () => undefined });

    expect(outcome.loadResults).toBe(1);
  });
});
