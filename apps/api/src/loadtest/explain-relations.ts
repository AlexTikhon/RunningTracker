import type { Pool } from 'pg';

type Queryable = Pick<Pool, 'query'>;

export interface TableStats {
  autovacuumCount: number;
  deadTuples: number;
  heapBytes: number;
  indexBytes: number;
  indexScans: number;
  lastAutoanalyze: string | null;
  lastAutovacuum: string | null;
  liveTuples: number;
  name: string;
  sequentialScans: number;
  toastBytes: number;
  totalBytes: number;
}

export interface IndexStats {
  accessMethod: string;
  bytes: number;
  name: string;
  scans: number;
  table: string;
  tuplesRead: number;
}

export interface SettingValue {
  name: string;
  setting: string;
  unit: string | null;
}

export interface RelationStats {
  indexes: IndexStats[];
  settings: SettingValue[];
  tables: TableStats[];
}

/** The settings that change how PostgreSQL plans, caches, and writes; recorded beside every measurement. */
export const reportedSettings = [
  'autovacuum',
  'default_statistics_target',
  'effective_cache_size',
  'fsync',
  'jit',
  'maintenance_work_mem',
  'max_connections',
  'max_parallel_workers_per_gather',
  'random_page_cost',
  'shared_buffers',
  'synchronous_commit',
  'track_io_timing',
  'wal_level',
  'work_mem',
] as const;

interface TableRow {
  autovacuum_count: string | null;
  heap_bytes: string;
  index_bytes: string;
  idx_scan: string | null;
  last_autoanalyze: Date | null;
  last_autovacuum: Date | null;
  n_dead_tup: string | null;
  n_live_tup: string | null;
  name: string;
  seq_scan: string | null;
  toast_bytes: string;
  total_bytes: string;
}

interface IndexRow {
  access_method: string;
  bytes: string;
  idx_scan: string | null;
  idx_tup_read: string | null;
  name: string;
  table_name: string;
}

const tablesSql = `
  SELECT class.relname AS name,
         pg_relation_size(class.oid)::text AS heap_bytes,
         COALESCE(pg_relation_size(NULLIF(class.reltoastrelid, 0)), 0)::text AS toast_bytes,
         pg_indexes_size(class.oid)::text AS index_bytes,
         pg_total_relation_size(class.oid)::text AS total_bytes,
         stat.n_live_tup::text,
         stat.n_dead_tup::text,
         stat.seq_scan::text,
         stat.idx_scan::text,
         stat.autovacuum_count::text,
         stat.last_autovacuum,
         stat.last_autoanalyze
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  LEFT JOIN pg_stat_all_tables AS stat ON stat.relid = class.oid
  WHERE namespace.nspname = 'public' AND class.relkind IN ('r', 'p')
  ORDER BY pg_total_relation_size(class.oid) DESC, class.relname`;

const indexesSql = `
  SELECT index_class.relname AS name,
         table_class.relname AS table_name,
         access_method.amname AS access_method,
         pg_relation_size(index_class.oid)::text AS bytes,
         stat.idx_scan::text,
         stat.idx_tup_read::text
  FROM pg_index AS index
  JOIN pg_class AS index_class ON index_class.oid = index.indexrelid
  JOIN pg_class AS table_class ON table_class.oid = index.indrelid
  JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
  JOIN pg_am AS access_method ON access_method.oid = index_class.relam
  LEFT JOIN pg_stat_all_indexes AS stat ON stat.indexrelid = index.indexrelid
  WHERE namespace.nspname = 'public'
  ORDER BY pg_relation_size(index_class.oid) DESC, index_class.relname`;

function whole(value: string | null): number {
  return value === null ? 0 : Number(value);
}

function instant(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * Real on-disk sizes and tuple counters straight from the catalogs and statistics views. `n_dead_tup` and the
 * scan counters are cumulative estimates maintained by the statistics collector, not exact counts.
 */
export async function collectRelationStats(pool: Queryable): Promise<RelationStats> {
  const tables = await pool.query<TableRow>(tablesSql);
  const indexes = await pool.query<IndexRow>(indexesSql);
  const settings = await pool.query<SettingValue>(
    'SELECT name, setting, unit FROM pg_settings WHERE name = ANY($1::text[]) ORDER BY name',
    [reportedSettings],
  );
  return {
    indexes: indexes.rows.map((row) => ({
      accessMethod: row.access_method,
      bytes: whole(row.bytes),
      name: row.name,
      scans: whole(row.idx_scan),
      table: row.table_name,
      tuplesRead: whole(row.idx_tup_read),
    })),
    settings: settings.rows.map(({ name, setting, unit }) => ({ name, setting, unit })),
    tables: tables.rows.map((row) => ({
      autovacuumCount: whole(row.autovacuum_count),
      deadTuples: whole(row.n_dead_tup),
      heapBytes: whole(row.heap_bytes),
      indexBytes: whole(row.index_bytes),
      indexScans: whole(row.idx_scan),
      lastAutoanalyze: instant(row.last_autoanalyze),
      lastAutovacuum: instant(row.last_autovacuum),
      liveTuples: whole(row.n_live_tup),
      name: row.name,
      sequentialScans: whole(row.seq_scan),
      toastBytes: whole(row.toast_bytes),
      totalBytes: whole(row.total_bytes),
    })),
  };
}
