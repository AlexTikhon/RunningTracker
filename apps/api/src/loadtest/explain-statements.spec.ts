import { describe, expect, it } from 'vitest';

import { renderArchiveTileSql } from '../archive/archive-service.js';
import { liveStateSql } from '../live/live-state.js';
import { publishCandidateSql } from '../maintenance/run-summary-publication.js';
import {
  insertPointsSql,
  listRunsSql,
  liveTrackChangesSql,
  liveTrackSnapshotSql,
  rawPointsPageSql,
} from '../runs/run-service.js';
import { geographyAnchors, ordinaryProfile, planDataset, smokeProfile } from './dataset-plan.js';
import { planExplainStatements } from './explain-statements.js';

const asOf = new Date('2026-09-30T00:00:00.000Z');
const now = new Date('2026-09-30T06:00:00.000Z');
const dataset = planDataset(smokeProfile, 42, asOf);
const plan = planExplainStatements(dataset, { now });

function statement(name: string) {
  const found = plan.statements.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`No statement named ${name}`);
  }
  return found;
}

describe('planExplainStatements', () => {
  it('gives every statement a unique name', () => {
    const names = plan.statements.map(({ name }) => name);

    expect(new Set(names).size).toBe(names.length);
  });

  it('measures the production SQL text and never a copy of it', () => {
    expect(statement('run-list/coach-page').sql).toBe(listRunsSql);
    expect(statement('raw-history/first-page').sql).toBe(rawPointsPageSql);
    expect(statement('live-snapshot/first-page').sql).toBe(liveTrackSnapshotSql);
    expect(statement('live-changes/one-batch').sql).toBe(liveTrackChangesSql);
    expect(statement('live-state/ten-active-runs').sql).toBe(liveStateSql);
    expect(statement('ingest/batch-of-100').sql).toBe(insertPointsSql);
    expect(statement('summary/publish-current-run').sql).toBe(publishCandidateSql);
    expect(statement('tile/taveuni-antimeridian/z9').sql).toBe(renderArchiveTileSql);
  });

  it('covers every geography anchor at zoom 9, 11, and 13 with valid wrapped tile coordinates', () => {
    const tiles = plan.statements.filter(({ group }) => group === 'tile');

    expect(tiles).toHaveLength(geographyAnchors.length * 3);
    for (const tile of tiles) {
      const [, z, x, y] = tile.staticValues ?? [];
      expect([9, 11, 13]).toContain(z);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(2 ** Number(z));
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(2 ** Number(z));
    }
  });

  it('reads the tile archive window of 366 days ending an hour after the injected instant', () => {
    const tile = statement('tile/taveuni-antimeridian/z9');

    expect(tile.staticValues?.[4]).toBe('2025-09-29T07:00:00.000Z');
    expect(tile.staticValues?.[5]).toBe('2026-09-30T07:00:00.000Z');
  });

  it('runs every statement under a planned organization member, coaches for shared reads and the owner for writes', () => {
    const memberIds = new Set(dataset.users.map(({ id }) => id));
    const coaches = new Set(dataset.users.filter(({ role }) => role === 'coach').map(({ id }) => id));
    for (const item of plan.statements.filter(({ role }) => role === 'runtime')) {
      expect(item.tenant?.orgId).toBe(dataset.organizationId);
      expect(memberIds.has(item.tenant?.userId ?? '')).toBe(true);
    }
    expect(coaches.has(statement('live-state/ten-active-runs').tenant?.userId ?? '')).toBe(true);
    expect(coaches.has(statement('run-list/coach-page').tenant?.userId ?? '')).toBe(true);
    expect(statement('ingest/batch-of-100').tenant?.userId).toBe(dataset.users[0]?.id);
    expect(statement('summary/publish-current-run').tenant).toBeNull();
    expect(statement('summary/publish-current-run').role).toBe('maintenance');
  });

  it('measures the live-state poll under the same visibility scope the live hub declares', () => {
    expect(statement('live-state/ten-active-runs').tenant?.visibilityScope).toBe('live');
    for (const item of plan.statements) {
      if (item.name !== 'live-state/ten-active-runs') {
        expect(item.tenant?.visibilityScope, item.name).toBeUndefined();
      }
    }
  });

  it('separates statements that need the seeded state from those that need active runs, and rolls back every write', () => {
    const needsActive = plan.statements.filter(({ needs }) => needs === 'active-runs').map(({ name }) => name);
    const rolledBack = plan.statements.filter(({ mode }) => mode === 'rollback').map(({ name }) => name);

    expect(needsActive.toSorted()).toEqual(['ingest/batch-of-100', 'live-state/ten-active-runs']);
    expect(rolledBack.toSorted()).toEqual([
      'ingest/batch-of-100',
      'summary/claim-stale-idle',
      'summary/publish-current-run',
    ]);
  });

  it('activates exactly the most recent run of every member, each with raw points', () => {
    expect(plan.activation.organizationId).toBe(dataset.organizationId);
    expect(plan.activation.runs).toHaveLength(dataset.users.length);
    const newestByUser = new Map<number, string>();
    for (const run of dataset.runs) {
      const current = newestByUser.get(run.userIndex);
      const currentRun = dataset.runs.find(({ id }) => id === current);
      if (!currentRun || Date.parse(run.startedAt) > Date.parse(currentRun.startedAt)) {
        newestByUser.set(run.userIndex, run.id);
      }
    }
    expect(plan.activation.runs.map(({ id }) => id).toSorted()).toEqual([...newestByUser.values()].toSorted());
    for (const activated of plan.activation.runs) {
      expect(dataset.runs.find(({ id }) => id === activated.id)?.hasRaw).toBe(true);
    }
  });

  it('asks for one changed batch by naming the revision just before the newest one', () => {
    const run = dataset.runs[0];
    const changes = statement('live-changes/one-batch');

    expect(changes.staticValues?.[1]).toBe(run?.id);
    expect(changes.staticValues?.[2]).toBe(String((run?.dataRevision ?? 0) - 1));
  });

  it('reads a deep page of a large run after the cursor position that lies 70% into its raw points', () => {
    const run = dataset.runs[0];
    const deep = statement('raw-history/deep-page');

    expect(deep.staticValues?.[3]).toBe(Math.floor((run?.pointCount ?? 0) * 0.7));
  });

  it('pairs each RLS-checked scan with the same SQL as the table owner, which is not subject to row-level security', () => {
    for (const table of ['run-summaries', 'runs', 'run-points']) {
      const owner = statement(`rls-baseline/${table}/owner`);
      const runtime = statement(`rls-baseline/${table}/runtime`);

      expect(owner.role).toBe('owner');
      expect(owner.tenant).toBeNull();
      expect(runtime.role).toBe('runtime');
      expect(runtime.tenant?.orgId).toBe(dataset.organizationId);
      expect(owner.sql).toBe(runtime.sql);
      expect(owner.staticValues).toEqual(runtime.staticValues);
      expect(owner.mode).toBe('read');
      expect(runtime.needs).toBe('seeded');
    }
    expect(statement('rls-baseline/run-points/owner').staticValues).toEqual([dataset.organizationId, dataset.runs[0]?.id]);
  });

  it('is deterministic for the same dataset and instant', () => {
    const again = planExplainStatements(planDataset(smokeProfile, 42, asOf), { now });

    expect(again.statements.map(({ name, staticValues }) => [name, staticValues])).toEqual(
      plan.statements.map(({ name, staticValues }) => [name, staticValues]),
    );
  });

  it('plans against the ordinary profile too', () => {
    const ordinary = planExplainStatements(planDataset(ordinaryProfile, 42, asOf), { now });

    expect(ordinary.statements.length).toBe(plan.statements.length);
  });
});
