import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  migrationAction,
  migrationChecksum,
  normalizeMigrationSql,
} from './migration-checksum.mjs';

const migration = 'CREATE EXTENSION IF NOT EXISTS postgis;\nSELECT 1;\n';

test('LF and Windows checkout bytes produce the same migration checksum', () => {
  const windowsCheckout = migration.replaceAll('\n', '\r\n');

  assert.equal(migrationChecksum(windowsCheckout), migrationChecksum(migration));
  assert.equal(normalizeMigrationSql(windowsCheckout), migration);
});

test('an unchanged applied migration is skipped', () => {
  assert.equal(migrationAction('0000.sql', migration, migrationChecksum(migration)).action, 'skip');
});

test('a real SQL change remains rejected', () => {
  assert.throws(
    () => migrationAction('0000.sql', `${migration}SELECT 2;\n`, migrationChecksum(migration)),
    /Applied migration 0000\.sql has changed/u,
  );
});
