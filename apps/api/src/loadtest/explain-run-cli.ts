import { execFileSync } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import process from 'node:process';
import { Pool } from 'pg';

import { planDataset } from './dataset-plan.js';
import { collectExplain, type ExplainCollection } from './explain-collect.js';
import { collectRelationStats, type RelationStats } from './explain-relations.js';
import { parseExplainArguments } from './explain-run-arguments.js';
import { planExplainStatements } from './explain-statements.js';
import { readDatabaseVersions, resolveDatasetAsOf, verifyDatasetMatchesPlan } from './load-dataset-check.js';
import { writeResultFile } from './load-result.js';
import { assertConnectedIdentity, loadRunnerDatabaseSuffixes, parseLoadTarget } from './load-target.js';
import { percentile } from './load-stats.js';

type PoolLike = Pick<Pool, 'connect' | 'end' | 'query'>;

export const explainSchemaName = 'running-tracker.explain-result';
export const explainSchemaVersion = 1;

export interface HostEnvironment {
  cpuCount: number;
  cpuModel: string;
  /** Size of the volume that holds the working directory (and so the results), when the platform reports it. */
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  osRelease: string;
  platform: string;
  totalMemoryBytes: number;
}

export interface ExplainRunResult extends ExplainCollection {
  asOf: string;
  finishedAt: string;
  gitCommit: string | null;
  host: HostEnvironment;
  node: string;
  postgis: string;
  postgres: string;
  /** Kept for the shared result writer: `explain-<profile>`, so the file name cannot collide with a load run. */
  profile: string;
  relations: RelationStats;
  repetitions: number;
  schema: typeof explainSchemaName;
  schemaVersion: typeof explainSchemaVersion;
  seed: number;
  startedAt: string;
  target: { database: string; host: string; port: string };
}

export interface ExplainCliDependencies {
  argv: readonly string[];
  collect?: typeof collectExplain;
  createPool?: (connectionString: string, applicationName: string) => PoolLike;
  env: Record<string, string | undefined>;
  gitCommit?: () => string | null;
  log?: (line: string) => void;
  now?: () => Date;
  signal?: AbortSignal;
  write?: (line: string) => void;
}

export interface ExplainCliOutcome {
  exitCode: 0 | 1;
  resultPath: string | null;
}

function currentGitCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

async function hostEnvironment(): Promise<HostEnvironment> {
  const processors = cpus();
  const disk = await statfs(process.cwd()).catch(() => undefined);
  return {
    ...(disk ? { diskFreeBytes: disk.bavail * disk.bsize, diskTotalBytes: disk.blocks * disk.bsize } : {}),
    cpuCount: processors.length,
    cpuModel: processors[0]?.model.trim() ?? 'unknown',
    osRelease: release(),
    platform: platform(),
    totalMemoryBytes: totalmem(),
  };
}

function median(values: readonly number[]): number | null {
  return values.length === 0 ? null : percentile(values, 50);
}

function digest(collection: ExplainCollection): Record<string, unknown>[] {
  return collection.statements.map((measurement) => {
    const first = measurement.executions[0];
    return {
      bytes: measurement.response?.bytes ?? null,
      error: measurement.error,
      firstMs: first?.executionMs ?? null,
      medianMs: median(measurement.executions.map(({ executionMs }) => executionMs)),
      name: measurement.name,
      sequentialScans: first?.sequentialScans.map(({ relation }) => relation) ?? [],
      sharedHit: first?.buffers.sharedHit ?? null,
      sharedRead: first?.buffers.sharedRead ?? null,
    };
  });
}

/**
 * `npm run load:explain`: validates the dedicated load database and that it holds exactly the planned dataset,
 * explains the planned hot statements under their real roles (every one rolled back), measures response
 * sizes, records relation and index sizes, verifies the dataset again, and writes one sanitized JSON result.
 */
export async function runExplainCli(dependencies: ExplainCliDependencies): Promise<ExplainCliOutcome> {
  const log = dependencies.log ?? ((line: string) => console.error(line));
  const write = dependencies.write ?? ((line: string) => console.info(line));
  const now = dependencies.now ?? (() => new Date());
  const args = parseExplainArguments(dependencies.argv);
  const target = parseLoadTarget(dependencies.env, loadRunnerDatabaseSuffixes);
  const createPool =
    dependencies.createPool ??
    ((connectionString: string, applicationName: string): PoolLike =>
      new Pool({ application_name: applicationName, connectionString, max: 2 }));

  const ownerPool = createPool(target.owner.connectionString, 'running-tracker-explain-owner');
  const runtimePool = createPool(target.runtime.connectionString, 'running-tracker-explain-runtime');
  const maintenancePool = createPool(target.maintenance.connectionString, 'running-tracker-explain-maintenance');
  try {
    // The URLs say where the connections should land; ask each live session where it did.
    for (const [pool, role] of [
      [ownerPool, target.owner],
      [runtimePool, target.runtime],
      [maintenancePool, target.maintenance],
    ] as const) {
      await assertConnectedIdentity(pool, { database: target.database, user: role.user }, loadRunnerDatabaseSuffixes);
    }

    const asOf = args.asOf ?? (await resolveDatasetAsOf(ownerPool, args.profile, args.seed));
    const dataset = planDataset(args.profile, args.seed, asOf);
    await verifyDatasetMatchesPlan(ownerPool, dataset);
    const versions = await readDatabaseVersions(ownerPool);
    log(`dataset ${args.profile.name} (seed ${args.seed}, as of ${dataset.asOf}) verified`);

    const startedAt = now();
    // Sizes and dead tuples of the pristine dataset, before any measurement touches it.
    const relations = await collectRelationStats(ownerPool);
    const plan = planExplainStatements(dataset, { now: startedAt });
    const collection = await (dependencies.collect ?? collectExplain)({
      maintenancePool: maintenancePool as Pool,
      keepPlans: args.keepPlans,
      onProgress: (name) => log(`explaining ${name}`),
      ownerPool: ownerPool as Pool,
      plan,
      repetitions: args.repetitions,
      runtimePool: runtimePool as Pool,
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
    await verifyDatasetMatchesPlan(ownerPool, dataset);

    // Raw plans can quote literal parameter values, so they never travel inside the summary document.
    const plans = collection.statements.map(({ name, plan }) => ({ name, plan }));
    const result: ExplainRunResult = {
      ...collection,
      statements: collection.statements.map((measurement) => ({ ...measurement, plan: null })),
      asOf: dataset.asOf,
      finishedAt: now().toISOString(),
      gitCommit: (dependencies.gitCommit ?? currentGitCommit)(),
      host: await hostEnvironment(),
      node: process.version,
      postgis: versions.postgis,
      postgres: versions.postgres,
      profile: `explain-${args.profile.name}`,
      relations,
      repetitions: args.repetitions,
      schema: explainSchemaName,
      schemaVersion: explainSchemaVersion,
      seed: args.seed,
      startedAt: startedAt.toISOString(),
      target: { database: target.database, host: target.host, port: target.port },
    };
    const resultPath = await writeResultFile(args.resultsDir, result, []);
    const plansPath = args.keepPlans
      ? await writeResultFile(
          args.resultsDir,
          { plans, profile: `explain-plans-${args.profile.name}`, schema: 'running-tracker.explain-plans', startedAt: result.startedAt },
          [],
        )
      : null;
    const failed = collection.statements.filter(({ error }) => error !== null);
    write(
      JSON.stringify({ failedStatements: failed.map(({ name }) => name), plansPath, resultPath, statements: digest(collection) }),
    );
    return { exitCode: failed.length === 0 ? 0 : 1, resultPath };
  } finally {
    await Promise.all([ownerPool.end(), runtimePool.end(), maintenancePool.end()]);
  }
}
