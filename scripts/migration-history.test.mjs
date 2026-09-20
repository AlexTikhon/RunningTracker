import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prepareMigrations, validateMigrationHistory } from './migration-history.mjs';

const migrations = prepareMigrations([
  { file: '0000.sql', sql: 'SELECT 0;\n' },
  { file: '0001.sql', sql: 'SELECT 1;\n' },
  { file: '0002.sql', sql: 'SELECT 2;\n' },
]);

test('valid history returns only the unapplied suffix', () => {
  const pending = validateMigrationHistory(migrations, [
    { id: '0000.sql', checksum: migrations[0].checksum },
  ]);

  assert.deepEqual(
    pending.map(({ file }) => file),
    ['0001.sql', '0002.sql'],
  );
});

test('a deleted applied migration fails preflight before a pending migration is returned', () => {
  assert.throws(
    () => validateMigrationHistory(migrations.slice(1), [{ id: '0000.sql', checksum: 'unused' }]),
    /missing from the repository/u,
  );
});

test('a changed applied migration fails preflight', () => {
  assert.throws(
    () => validateMigrationHistory(migrations, [{ id: '0000.sql', checksum: 'changed' }]),
    /has changed/u,
  );
});

test('an inserted migration before applied history fails preflight', () => {
  const withBackfill = prepareMigrations([
    { file: '0000.sql', sql: 'SELECT 0;\n' },
    { file: '0000a.sql', sql: 'SELECT 0.5;\n' },
    { file: '0001.sql', sql: 'SELECT 1;\n' },
    { file: '0002.sql', sql: 'SELECT 2;\n' },
  ]);

  assert.throws(
    () =>
      validateMigrationHistory(withBackfill, [
        { id: '0000.sql', checksum: withBackfill[0].checksum },
        { id: '0001.sql', checksum: migrations[1].checksum },
      ]),
    /out of order/u,
  );
});

test('applied rows recorded out of lexical order fail preflight', () => {
  assert.throws(
    () =>
      validateMigrationHistory(migrations, [
        { id: '0001.sql', checksum: migrations[1].checksum },
        { id: '0000.sql', checksum: migrations[0].checksum },
      ]),
    /out of order/u,
  );
});
