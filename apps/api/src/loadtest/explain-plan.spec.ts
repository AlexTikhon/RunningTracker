import { describe, expect, it } from 'vitest';

import { summarizePlan } from './explain-plan.js';

// The shape PostgreSQL 17 returns for EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), reduced to the fields used.
function buildExplain(overrides: Record<string, unknown> = {}): unknown {
  return [
    {
      Plan: {
        'Node Type': 'Limit',
        'Actual Total Time': 12.5,
        'Actual Rows': 3,
        'Actual Loops': 1,
        'Shared Hit Blocks': 90,
        'Shared Read Blocks': 10,
        'Shared Dirtied Blocks': 2,
        'Shared Written Blocks': 1,
        'Temp Read Blocks': 0,
        'Temp Written Blocks': 0,
        Plans: [
          {
            'Node Type': 'Sort',
            'Actual Total Time': 12.0,
            'Actual Rows': 3,
            'Actual Loops': 1,
            'Sort Space Used': 48,
            'Sort Space Type': 'Memory',
            'Shared Hit Blocks': 90,
            'Shared Read Blocks': 10,
            Plans: [
              {
                'Node Type': 'Seq Scan',
                'Relation Name': 'run_summaries',
                'Actual Total Time': 4.0,
                'Actual Rows': 5,
                'Actual Loops': 2,
                'Rows Removed by Filter': 995,
                'Shared Hit Blocks': 60,
                'Shared Read Blocks': 10,
              },
              {
                'Node Type': 'Index Scan',
                'Relation Name': 'run_points',
                'Index Name': 'run_points_pkey',
                'Actual Total Time': 0.5,
                'Actual Rows': 1,
                'Actual Loops': 40,
                'Shared Hit Blocks': 30,
                'Shared Read Blocks': 0,
              },
            ],
          },
        ],
      },
      Planning: { 'Shared Hit Blocks': 7, 'Shared Read Blocks': 1 },
      'Planning Time': 0.8,
      'Execution Time': 12.9,
      ...overrides,
    },
  ];
}

describe('summarizePlan', () => {
  it('reports planning and execution time and the whole-plan buffer counters from the root node', () => {
    const summary = summarizePlan(buildExplain());

    expect(summary.planningMs).toBe(0.8);
    expect(summary.executionMs).toBe(12.9);
    expect(summary.buffers).toEqual({
      sharedDirtied: 2,
      sharedHit: 90,
      sharedRead: 10,
      sharedWritten: 1,
      tempRead: 0,
      tempWritten: 0,
    });
    expect(summary.planningBuffers).toEqual({ sharedHit: 7, sharedRead: 1 });
  });

  it('lists sequential scans with their multiplied rows and the rows discarded by the filter', () => {
    const summary = summarizePlan(buildExplain());

    expect(summary.sequentialScans).toEqual([
      { actualRows: 10, loops: 2, relation: 'run_summaries', rowsRemovedByFilter: 1990 },
    ]);
  });

  it('lists each index used with its relation and total loops', () => {
    const summary = summarizePlan(buildExplain());

    expect(summary.indexScans).toEqual([
      { actualRows: 40, index: 'run_points_pkey', loops: 40, relation: 'run_points' },
    ]);
  });

  it('attributes time to a node exclusive of its children and orders the heaviest first', () => {
    const summary = summarizePlan(buildExplain());

    // Sort: 12.0 - (4.0 * 2 + 0.5 * 40) = -16 is clamped; the children dominate, so the scans lead.
    expect(summary.heaviestNodes.map((node) => [node.nodeType, node.exclusiveMs])).toEqual([
      ['Index Scan', 20],
      ['Seq Scan', 8],
      ['Limit', 0.5],
      ['Sort', 0],
    ]);
  });

  it('limits the heaviest nodes to five', () => {
    const children = Array.from({ length: 8 }, (_, index) => ({
      'Node Type': 'Result',
      'Actual Total Time': index + 1,
      'Actual Rows': 1,
      'Actual Loops': 1,
    }));
    const summary = summarizePlan([
      {
        Plan: { 'Node Type': 'Append', 'Actual Total Time': 100, 'Actual Rows': 8, 'Actual Loops': 1, Plans: children },
        'Planning Time': 0,
        'Execution Time': 100,
      },
    ]);

    expect(summary.heaviestNodes).toHaveLength(5);
    expect(summary.heaviestNodes[0]?.exclusiveMs).toBe(64);
    expect(summary.nodeCount).toBe(9);
  });

  it('reports sort space and whether the statement used JIT', () => {
    const plain = summarizePlan(buildExplain());
    const jitted = summarizePlan(buildExplain({ JIT: { Functions: 4 } }));

    expect(plain.jit).toBe(false);
    expect(jitted.jit).toBe(true);
    expect(plain.sortSpace).toEqual([{ kilobytes: 48, spaceType: 'Memory' }]);
  });

  it('reports WAL volume from the root node and constraint trigger time from the document', () => {
    const explain = buildExplain({
      Triggers: [{ 'Trigger Name': 'RI_ConstraintTrigger_c_1', Calls: 100, Time: 3.25 }],
    });
    const root = (explain as { Plan: Record<string, unknown> }[])[0]?.Plan;
    Object.assign(root ?? {}, { 'WAL Bytes': 4096, 'WAL FPI': 3, 'WAL Records': 210 });

    const summary = summarizePlan(explain);

    expect(summary.wal).toEqual({ bytes: 4096, fullPageImages: 3, records: 210 });
    expect(summary.triggers).toEqual([{ calls: 100, name: 'RI_ConstraintTrigger_c_1', totalMs: 3.25 }]);
  });

  it('reports no WAL and no triggers for a read-only statement', () => {
    const summary = summarizePlan(buildExplain());

    expect(summary.wal).toEqual({ bytes: 0, fullPageImages: 0, records: 0 });
    expect(summary.triggers).toEqual([]);
  });

  it('treats absent buffer counters as zero', () => {
    const summary = summarizePlan([
      { Plan: { 'Node Type': 'Result', 'Actual Total Time': 0.1, 'Actual Rows': 1, 'Actual Loops': 1 }, 'Planning Time': 0, 'Execution Time': 0.1 },
    ]);

    expect(summary.buffers.sharedHit).toBe(0);
    expect(summary.planningBuffers).toEqual({ sharedHit: 0, sharedRead: 0 });
  });

  it.each([[null], [{}], [[]], [[{ 'Execution Time': 1 }]], ['plan']])('rejects a malformed explain document %j', (input) => {
    expect(() => summarizePlan(input)).toThrow(/EXPLAIN/);
  });
});
