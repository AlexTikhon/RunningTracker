import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Runs the real evaluation CLI (`run-search-evaluation-main.ts`) in a child process, with its transport replaced by
// test/support/mock-ollama-transport.ts. Offline: no model, no key, no network; the only address the mock serves is
// the adapter's fixed loopback one, and it only answers from the synthetic dataset.

const apiDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mainPath = join(apiDirectory, 'src', 'evaluation', 'run-search-evaluation-main.ts');
const preload = pathToFileURL(join(apiDirectory, 'test', 'support', 'mock-ollama-transport.ts')).href;

interface CliRun {
  code: number;
  report: Record<string, unknown> | null;
  requests: Array<{ blocked?: string; caseId?: string | null; url?: string }>;
  stderr: string;
  stdout: string;
}

let workDirectory = '';
let counter = 0;

function environmentFor(mode: string, log: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('RUN_SEARCH_AI_') && !name.startsWith('OPENAI_')) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    MOCK_OLLAMA_LOG: log,
    MOCK_OLLAMA_MODE: mode,
    RUN_SEARCH_AI_MODEL: 'qwen3:8b',
    RUN_SEARCH_AI_PROVIDER: 'ollama',
  };
}

async function runCli(
  args: string[],
  options: { mode?: string; out?: string | null } = {},
): Promise<CliRun> {
  counter += 1;
  const log = join(workDirectory, `requests-${counter}.jsonl`);
  const out = options.out === undefined ? join(workDirectory, `report-${counter}.json`) : options.out;
  const argv = [
    '--import',
    'tsx',
    '--import',
    preload,
    mainPath,
    ...args,
    ...(out === null ? [] : ['--out', out]),
  ];
  const result = await new Promise<{ code: number; stderr: string; stdout: string }>((done) => {
    execFile(
      process.execPath,
      argv,
      { cwd: apiDirectory, env: environmentFor(options.mode ?? 'exact', log), timeout: 90_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        done({ code, stderr, stdout });
      },
    );
  });
  const reportPath = out === null ? null : out;
  return {
    ...result,
    report:
      reportPath !== null && existsSync(reportPath)
        ? (JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>)
        : null,
    requests: existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as CliRun['requests'][number])
      : [],
  };
}

const exactCases = ['en-last-month-min-longest', 'ru-last-month-min-longest', 'en-strict-more-than'];

describe('run-search evaluation CLI: --fail-on-mismatch (offline subprocess, mocked transport)', () => {
  beforeAll(() => {
    workDirectory = mkdtempSync(join(tmpdir(), 'run-search-acceptance-'));
  });

  afterAll(() => {
    rmSync(workDirectory, { force: true, recursive: true });
  });

  it('exits 0 and records a passed verdict when every selected case matched, although the dataset is only partly run', async () => {
    const run = await runCli(['--live', '--cases', exactCases.join(','), '--fail-on-mismatch']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('ACCEPTANCE PASSED');
    expect(run.report).toMatchObject({
      acceptance: {
        failures: [],
        passed: true,
        scope: 'selected-synthetic-cases',
        selectedIds: [...exactCases].sort((a, b) => exactCases.indexOf(a) - exactCases.indexOf(b)),
      },
      aborted: null,
      executedCount: 3,
      outcomeAccuracy: 1,
      partial: true,
    });
    expect(run.requests.filter((entry) => entry.url === '/api/chat')).toHaveLength(3);
    expect(run.requests.some((entry) => entry.blocked !== undefined)).toBe(false);
  }, 120_000);

  it('exits 2 for a valid but wrong search that drops the place of en-location, after writing the report', async () => {
    const run = await runCli(
      ['--live', '--cases', 'en-last-month-min-longest,en-location', '--fail-on-mismatch'],
      { mode: 'drop-location' },
    );

    expect(run.code, run.stderr).toBe(2);
    expect(run.stdout).toContain('ACCEPTANCE FAILED');
    expect(run.stdout).toContain('Report written to');
    expect(run.report).toMatchObject({
      acceptance: { passed: false, scope: 'selected-synthetic-cases' },
      incorrectAcceptances: { ids: ['en-location'], total: 1 },
      outcomeAccuracy: 0.5,
    });
    const acceptance = run.report!.acceptance as { failures: string[]; selectedIds: string[] };
    expect(acceptance.selectedIds).toEqual(['en-last-month-min-longest', 'en-location']);
    expect(acceptance.failures.join('\n')).toContain('en-location');
    expect(acceptance.failures.length).toBeLessThanOrEqual(10);
  }, 120_000);

  it('keeps today\'s behavior without the flag: the same wrong answer exits 0 and the report has no verdict', async () => {
    const run = await runCli(['--live', '--cases', 'en-last-month-min-longest,en-location'], {
      mode: 'drop-location',
    });

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).not.toContain('ACCEPTANCE');
    expect(run.report).toMatchObject({ incorrectAcceptances: { total: 1 }, outcomeAccuracy: 0.5 });
    expect(run.report).not.toHaveProperty('acceptance');
  }, 120_000);

  it('exits 2 for a run that stopped itself on provider failures, with the report written and the reason named', async () => {
    const run = await runCli(
      ['--live', '--cases', [...exactCases, 'en-location', 'en-injection-sql'].join(','), '--fail-on-mismatch'],
      { mode: 'server-error' },
    );

    expect(run.code, run.stderr).toBe(2);
    expect(run.report).toMatchObject({
      aborted: { consecutive: 3, reason: 'provider_error' },
      acceptance: { passed: false },
    });
    const acceptance = run.report!.acceptance as { failures: string[] };
    expect(acceptance.failures.join('\n')).toMatch(/stopped early/iu);
    expect(acceptance.failures.join('\n')).toMatch(/not executed/iu);
  }, 120_000);

  it('exits 1, not 2, when the report cannot be written: it is never a quality failure without a report', async () => {
    const blocker = join(workDirectory, 'a-file-not-a-directory');
    writeFileSync(blocker, 'x', 'utf8');
    const run = await runCli(
      ['--live', '--cases', 'en-last-month-min-longest,en-location', '--fail-on-mismatch'],
      { mode: 'drop-location', out: join(blocker, 'report.json') },
    );

    expect(run.code).toBe(1);
    expect(run.report).toBeNull();
    expect(run.stderr.length).toBeGreaterThan(0);
  }, 120_000);

  it('exits 1 for a configuration error such as an unknown case id, before any request', async () => {
    const run = await runCli(['--live', '--cases', 'en-no-such-case', '--fail-on-mismatch']);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('en-no-such-case');
    expect(run.requests).toEqual([]);
    expect(run.report).toBeNull();
  }, 120_000);

  it('makes no request on a dry run and never claims acceptance', async () => {
    const dry = await runCli(['--dry-run', '--cases', exactCases.join(',')]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('No request was made');
    expect(dry.stdout).not.toMatch(/ACCEPTANCE/u);
    expect(dry.requests).toEqual([]);
    expect(dry.report).toBeNull();

    const gated = await runCli(['--dry-run', '--cases', exactCases.join(','), '--fail-on-mismatch']);
    expect(gated.code).toBe(1);
    expect(gated.stderr).toMatch(/dry run/iu);
    expect(gated.stdout).not.toMatch(/ACCEPTANCE/u);
    expect(gated.requests).toEqual([]);
    expect(gated.report).toBeNull();
  }, 120_000);
});
