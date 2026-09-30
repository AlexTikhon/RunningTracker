/** Buffer counters of the whole plan (the root node's counters already include every child). */
export interface PlanBuffers {
  sharedDirtied: number;
  sharedHit: number;
  sharedRead: number;
  sharedWritten: number;
  tempRead: number;
  tempWritten: number;
}

export interface SequentialScan {
  actualRows: number;
  loops: number;
  relation: string;
  rowsRemovedByFilter: number;
}

export interface IndexScan {
  actualRows: number;
  index: string;
  loops: number;
  relation: string | null;
}

export interface HeavyNode {
  actualRows: number;
  exclusiveMs: number;
  index: string | null;
  loops: number;
  nodeType: string;
  relation: string | null;
}

export interface SortSpace {
  kilobytes: number;
  spaceType: string;
}

export interface TriggerTime {
  calls: number;
  name: string;
  totalMs: number;
}

export interface WalUsage {
  bytes: number;
  fullPageImages: number;
  records: number;
}

export interface PlanSummary {
  buffers: PlanBuffers;
  executionMs: number;
  /** Slowest nodes by time not attributable to their children, at most five. */
  heaviestNodes: HeavyNode[];
  indexScans: IndexScan[];
  jit: boolean;
  nodeCount: number;
  planningBuffers: { sharedHit: number; sharedRead: number };
  planningMs: number;
  sequentialScans: SequentialScan[];
  sortSpace: SortSpace[];
  /** Referential-integrity and other trigger time; PostgreSQL reports it outside the plan tree. */
  triggers: TriggerTime[];
  wal: WalUsage;
}

type Json = Record<string, unknown>;

const heaviestNodeLimit = 5;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(node: Json, name: string): number {
  const value = node[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringField(node: Json, name: string): string | null {
  const value = node[name];
  return typeof value === 'string' ? value : null;
}

function triggerDocuments(value: unknown): Json[] {
  const entries: unknown[] = Array.isArray(value) ? value : [];
  return entries.filter(isRecord);
}

function childNodes(node: Json): Json[] {
  const plans = node.Plans;
  return Array.isArray(plans) ? plans.filter(isRecord) : [];
}

interface Walk {
  heavy: HeavyNode[];
  index: IndexScan[];
  nodes: number;
  sequential: SequentialScan[];
  sort: SortSpace[];
}

/** PostgreSQL reports node time as a per-loop average, so the node's own total is time multiplied by loops. */
function totalMs(node: Json): number {
  return numberField(node, 'Actual Total Time') * Math.max(1, numberField(node, 'Actual Loops'));
}

function walk(node: Json, state: Walk): void {
  const loops = Math.max(1, numberField(node, 'Actual Loops'));
  const children = childNodes(node);
  const childTotal = children.reduce((sum, child) => sum + totalMs(child), 0);
  const nodeType = stringField(node, 'Node Type') ?? 'Unknown';
  const relation = stringField(node, 'Relation Name');
  const index = stringField(node, 'Index Name');
  const actualRows = numberField(node, 'Actual Rows') * loops;

  state.nodes += 1;
  state.heavy.push({
    actualRows,
    // Rounded to microseconds so binary floating-point residue does not leak into reports.
    exclusiveMs: Math.round(Math.max(0, totalMs(node) - childTotal) * 1_000) / 1_000,
    index,
    loops,
    nodeType,
    relation,
  });

  if (nodeType === 'Seq Scan' && relation !== null) {
    state.sequential.push({
      actualRows,
      loops,
      relation,
      rowsRemovedByFilter: numberField(node, 'Rows Removed by Filter') * loops,
    });
  }
  if (index !== null && nodeType.includes('Index')) {
    state.index.push({ actualRows, index, loops, relation });
  }
  const sortSpaceType = stringField(node, 'Sort Space Type');
  if (sortSpaceType !== null) {
    state.sort.push({ kilobytes: numberField(node, 'Sort Space Used'), spaceType: sortSpaceType });
  }
  for (const child of children) {
    walk(child, state);
  }
}

/**
 * Reduces one EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) document to the figures the P11.4 report needs.
 * The plan itself is not kept: it can contain literal values, and the summary is what gets compared.
 */
export function summarizePlan(explain: unknown): PlanSummary {
  const documents: unknown[] = Array.isArray(explain) ? explain : [];
  const document = documents[0];
  if (!isRecord(document) || !isRecord(document.Plan)) {
    throw new Error('The value is not an EXPLAIN (FORMAT JSON) document with a Plan');
  }
  const root = document.Plan;
  const state: Walk = { heavy: [], index: [], nodes: 0, sequential: [], sort: [] };
  walk(root, state);

  const planning = isRecord(document.Planning) ? document.Planning : {};
  return {
    buffers: {
      sharedDirtied: numberField(root, 'Shared Dirtied Blocks'),
      sharedHit: numberField(root, 'Shared Hit Blocks'),
      sharedRead: numberField(root, 'Shared Read Blocks'),
      sharedWritten: numberField(root, 'Shared Written Blocks'),
      tempRead: numberField(root, 'Temp Read Blocks'),
      tempWritten: numberField(root, 'Temp Written Blocks'),
    },
    executionMs: numberField(document, 'Execution Time'),
    heaviestNodes: state.heavy
      .toSorted((left, right) => right.exclusiveMs - left.exclusiveMs)
      .slice(0, heaviestNodeLimit),
    indexScans: state.index,
    jit: isRecord(document.JIT),
    nodeCount: state.nodes,
    planningBuffers: {
      sharedHit: numberField(planning, 'Shared Hit Blocks'),
      sharedRead: numberField(planning, 'Shared Read Blocks'),
    },
    planningMs: numberField(document, 'Planning Time'),
    sequentialScans: state.sequential,
    sortSpace: state.sort,
    triggers: triggerDocuments(document.Triggers).map((trigger) => ({
      calls: numberField(trigger, 'Calls'),
      name: stringField(trigger, 'Trigger Name') ?? 'unknown',
      totalMs: numberField(trigger, 'Time'),
    })),
    wal: {
      bytes: numberField(root, 'WAL Bytes'),
      fullPageImages: numberField(root, 'WAL FPI'),
      records: numberField(root, 'WAL Records'),
    },
  };
}
