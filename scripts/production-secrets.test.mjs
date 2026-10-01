import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildProductionSecrets, writeProductionSecrets } from './production-secrets.mjs';

test('P12.2 secrets: every role gets its own URL-safe password and the URLs name the right roles', () => {
  const secrets = buildProductionSecrets({ randomBytes });

  assert.deepEqual(Object.keys(secrets).sort(), [
    'bootstrap-database-url',
    'cursor-signing-key',
    'maintenance-database-url',
    'migration-database-url',
    'postgres-password',
    'runtime-database-url',
  ]);

  const expectedUsers = {
    'bootstrap-database-url': 'running_tracker_admin',
    'maintenance-database-url': 'running_tracker_maintenance',
    'migration-database-url': 'running_tracker_owner',
    'runtime-database-url': 'running_tracker_runtime',
  };
  const passwords = new Set([secrets['postgres-password']]);
  for (const [name, user] of Object.entries(expectedUsers)) {
    const url = new URL(secrets[name]);
    assert.equal(url.protocol, 'postgresql:');
    assert.equal(url.username, user);
    assert.equal(url.hostname, 'postgres');
    assert.equal(url.pathname, '/running_tracker');
    assert.match(url.password, /^[0-9a-f]{64}$/u, `${name} password must be 256 random bits as hex`);
    passwords.add(url.password);
  }
  // The bootstrap URL reuses the superuser password; the other three are independent.
  assert.equal(new URL(secrets['bootstrap-database-url']).password, secrets['postgres-password']);
  assert.equal(passwords.size, 4);
});

test('P12.2 secrets: the cursor key is canonical unpadded base64url of at least 32 bytes', () => {
  const { 'cursor-signing-key': key } = buildProductionSecrets({ randomBytes });

  assert.match(key, /^[A-Za-z0-9_-]+$/u);
  const decoded = Buffer.from(key, 'base64url');
  assert.ok(decoded.length >= 32);
  assert.equal(decoded.toString('base64url'), key);
});

test('P12.2 secrets: two generations never share a value', () => {
  const first = buildProductionSecrets({ randomBytes });
  const second = buildProductionSecrets({ randomBytes });

  for (const name of Object.keys(first)) {
    assert.notEqual(first[name], second[name], name);
  }
});

test('P12.2 secrets: files are written once, readable by containers but confined to a private directory', () => {
  const parent = mkdtempSync(join(tmpdir(), 'running-tracker-secrets-'));
  try {
    const directory = join(parent, 'secrets');
    const written = writeProductionSecrets(directory, { randomBytes });

    assert.equal(written.length, 6);
    const runtimeUrl = readFileSync(join(directory, 'runtime-database-url'), 'utf8');
    assert.match(runtimeUrl, /^postgresql:\/\/running_tracker_runtime:[0-9a-f]{64}@postgres:5432\/running_tracker\n$/u);
    if (process.platform !== 'win32') {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(join(directory, 'runtime-database-url')).mode & 0o777, 0o444);
    }

    assert.throws(
      () => writeProductionSecrets(directory, { randomBytes }),
      /already exists.*--force/su,
    );
    assert.equal(readFileSync(join(directory, 'runtime-database-url'), 'utf8'), runtimeUrl);

    writeFileSync(join(directory, 'unrelated'), 'keep');
    writeProductionSecrets(directory, { force: true, randomBytes });
    assert.notEqual(readFileSync(join(directory, 'runtime-database-url'), 'utf8'), runtimeUrl);
    assert.equal(readFileSync(join(directory, 'unrelated'), 'utf8'), 'keep');
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});

test('P12.2 secrets: rotating roles changes only the three application logins', () => {
  const parent = mkdtempSync(join(tmpdir(), 'running-tracker-rotate-'));
  try {
    const directory = join(parent, 'secrets');
    writeProductionSecrets(directory, { randomBytes });
    const read = (name) => readFileSync(join(directory, name), 'utf8');
    const before = Object.fromEntries(
      [
        'postgres-password',
        'bootstrap-database-url',
        'cursor-signing-key',
        'migration-database-url',
        'runtime-database-url',
        'maintenance-database-url',
      ].map((name) => [name, read(name)]),
    );

    const rotated = writeProductionSecrets(directory, { randomBytes, rotateRoles: true });

    assert.deepEqual(rotated.sort(), [
      'maintenance-database-url',
      'migration-database-url',
      'runtime-database-url',
    ]);
    for (const name of ['postgres-password', 'bootstrap-database-url', 'cursor-signing-key']) {
      assert.equal(read(name), before[name], `${name} must survive a role rotation`);
    }
    for (const [name, user] of [
      ['migration-database-url', 'running_tracker_owner'],
      ['runtime-database-url', 'running_tracker_runtime'],
      ['maintenance-database-url', 'running_tracker_maintenance'],
    ]) {
      assert.notEqual(read(name), before[name], `${name} must change`);
      assert.equal(new URL(read(name).trim()).username, user);
    }
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});

test('P12.2 secrets: rotating roles needs an existing set', () => {
  const parent = mkdtempSync(join(tmpdir(), 'running-tracker-rotate-'));
  try {
    assert.throws(
      () => writeProductionSecrets(join(parent, 'empty'), { randomBytes, rotateRoles: true }),
      /rotate.*existing/isu,
    );
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});
