import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { Pool } from 'pg';

import { planDataset } from './dataset-plan.js';
import { startApiProcess, type ApiTarget } from './load-api-process.js';
import {
  cleanupLoadRuns,
  datasetInstantWarning,
  readDatabaseVersions,
  resolveDatasetAsOf,
  verifyDatasetMatchesPlan,
} from './load-dataset-check.js';
import { createLockSampler } from './load-lock-sampler.js';
import { runLoadScenario } from './load-orchestrator.js';
import {
  resultSchemaName,
  resultSchemaVersion,
  writeResultFile,
  type LoadFailure,
  type LoadRunResult,
} from './load-result.js';
import { parseLoadArguments } from './load-run-arguments.js';
import { planLoadScenario, workloadProfiles } from './load-scenario.js';
import { assertConnectedIdentity, loadRunnerDatabaseSuffixes, parseLoadTarget } from './load-target.js';

type PoolLike = Pick<Pool, 'end' | 'query'>;

export interface LoadCliDependencies {
  argv: readonly string[];
  createPool?: (connectionString: string, applicationName: string) => PoolLike;
  env: Record<string, string | undefined>;
  gitCommit?: () => string | null;
  log?: (line: string) => void;
  now?: () => Date;
  runScenario?: typeof runLoadScenario;
  signal?: AbortSignal;
  startApi?: typeof startApiProcess;
  write?: (line: string) => void;
}

export interface LoadCliOutcome {
  exitCode: 0 | 1;
  resultPath: string | null;
}

const allowedOrigin = 'http://127.0.0.1:5173';

function currentGitCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * `npm run load:run`: validates the dedicated load database, checks that it holds exactly the planned
 * dataset, starts the real API against it, runs the concurrent scenario, removes only the runs the scenario
 * created, and writes one sanitized JSON result. Every refusal happens before anything is started.
 */
export async function runLoadCli(dependencies: LoadCliDependencies): Promise<LoadCliOutcome> {
  const log = dependencies.log ?? ((line: string) => console.error(line));
  const write = dependencies.write ?? ((line: string) => console.info(line));
  const now = dependencies.now ?? (() => new Date());
  const args = parseLoadArguments(dependencies.argv);
  const target = parseLoadTarget(dependencies.env, loadRunnerDatabaseSuffixes);
  const workload = workloadProfiles[args.profile.name];
  if (!workload) {
    throw new Error(`No workload is defined for profile ${args.profile.name}`);
  }
  const createPool =
    dependencies.createPool ??
    ((connectionString: string, applicationName: string): PoolLike =>
      new Pool({ application_name: applicationName, connectionString, max: 2 }));

  const ownerPool = createPool(target.owner.connectionString, 'running-tracker-load-owner');
  let api: ApiTarget | undefined;
  try {
    // The URLs say where the connections should land; ask each live session where it did.
    await assertConnectedIdentity(ownerPool, { database: target.database, user: target.owner.user }, loadRunnerDatabaseSuffixes);
    for (const role of [target.runtime, target.maintenance]) {
      const pool = createPool(role.connectionString, 'running-tracker-load-identity');
      try {
        await assertConnectedIdentity(pool, { database: target.database, user: role.user }, loadRunnerDatabaseSuffixes);
      } finally {
        await pool.end();
      }
    }

    const asOf = args.asOf ?? (await resolveDatasetAsOf(ownerPool, args.profile, args.seed));
    const dataset = planDataset(args.profile, args.seed, asOf);
    const scenario = planLoadScenario(dataset, args.tiles ? workload : { ...workload, tileStreams: 0 });

    if (args.cleanupOnly) {
      const removed = await cleanupLoadRuns(ownerPool, scenario);
      await verifyDatasetMatchesPlan(ownerPool, dataset);
      write(JSON.stringify({ cleanedUpRuns: removed, dataset: 'verified' }));
      return { exitCode: 0, resultPath: null };
    }

    await verifyDatasetMatchesPlan(ownerPool, dataset);
    const versions = await readDatabaseVersions(ownerPool);
    log(`dataset ${args.profile.name} (seed ${args.seed}, as of ${dataset.asOf}) verified; starting the API`);

    const startedAt = now();
    api = await (dependencies.startApi ?? startApiProcess)({
      environment: dependencies.env,
      origin: allowedOrigin,
      target,
      userIds: dataset.users.map((user) => user.id),
    });
    const { report, secrets } = await (dependencies.runScenario ?? runLoadScenario)({
      api,
      log,
      plan: scenario,
      // The owner pool reads only the lock catalogs; the API and its roles are untouched.
      sampleLocks: createLockSampler(ownerPool),
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
    const serverLog = api.logSummary();
    const configuration = api.configuration;
    await api.stop();
    api = undefined;

    let deletedRuns = 0;
    let failure: LoadFailure | null = report.failure;
    const warnings = [...report.warnings];
    const instantWarning = datasetInstantWarning(asOf, startedAt);
    if (instantWarning) {
      warnings.push(instantWarning);
      log(`warning: ${instantWarning}`);
    }
    if (args.cleanup) {
      deletedRuns = await cleanupLoadRuns(ownerPool, scenario);
      try {
        await verifyDatasetMatchesPlan(ownerPool, dataset);
      } catch {
        warnings.push('The dataset did not match the plan after cleanup; reseed before the next run');
        failure ??= { kind: 'load-runner', message: 'The dataset was not restored by cleanup', phase: 'cleanup' };
      }
    } else {
      warnings.push('Cleanup was skipped: the load runs remain and the next run will refuse until --cleanup-only');
    }

    const result: LoadRunResult = {
      ...report,
      asOf: dataset.asOf,
      cleanup: { deletedRuns, enabled: args.cleanup },
      configuration,
      failure,
      finishedAt: now().toISOString(),
      gitCommit: (dependencies.gitCommit ?? currentGitCommit)(),
      node: process.version,
      postgis: versions.postgis,
      postgres: versions.postgres,
      profile: args.profile.name,
      schema: resultSchemaName,
      schemaVersion: resultSchemaVersion,
      seed: args.seed,
      serverLog,
      startedAt: startedAt.toISOString(),
      status: failure === null ? 'ok' : 'failed',
      target: { database: target.database, host: target.host, port: target.port },
      warnings,
    };
    const resultPath = await writeResultFile(args.resultsDir, result, secrets);
    write(
      JSON.stringify({
        failure: result.failure,
        freshLatencyMs: result.freshLatency.summaryMs,
        ingestionMs: result.ingestionSummaryMs,
        resultPath,
        status: result.status,
        summaryPublication: {
          archiveRevisionVisibleMs: result.summaryPublication.archiveRevisionVisibleMs,
          finishAckedMs: result.summaryPublication.finishAckedMs,
          summaryVisibleMs: result.summaryPublication.summaryVisibleMs,
        },
        warnings: result.warnings,
        workload: result.workload,
      }),
    );
    return { exitCode: result.status === 'ok' ? 0 : 1, resultPath };
  } finally {
    await api?.stop();
    await ownerPool.end();
  }
}
