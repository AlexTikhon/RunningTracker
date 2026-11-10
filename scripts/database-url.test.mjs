import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertConnectedIdentity, parseDatabaseUrl } from './database-url.mjs';

const owner = 'postgresql://running_tracker_owner:secret@127.0.0.1:5433/running_tracker_test';
const asOwner = { expectedUser: 'running_tracker_owner', requireTestDatabase: true };

describe('migration and bootstrap connection URLs (F05)', () => {
  it('accepts an owner URL and returns its decoded user and database', () => {
    const parsed = parseDatabaseUrl(`${owner}?sslmode=disable&application_name=x`, 'TEST_MIGRATION_DATABASE_URL', asOwner);
    assert.equal(parsed.user, 'running_tracker_owner');
    assert.equal(parsed.database, 'running_tracker_test');
  });

  for (const parameter of ['user=running_tracker', 'host=10.0.0.9', 'port=5432', 'database=postgres', 'dbname=postgres']) {
    it(`refuses an identity override in the query string (${parameter})`, () => {
      assert.throws(
        () => parseDatabaseUrl(`${owner}?${parameter}`, 'TEST_MIGRATION_DATABASE_URL', asOwner),
        /TEST_MIGRATION_DATABASE_URL must not override connection identity in query parameters/u,
      );
    });
  }

  it('refuses another login, another protocol, a malformed URL, a missing value and a non-test database', () => {
    assert.throws(
      () => parseDatabaseUrl(owner.replace('running_tracker_owner', 'running_tracker'), 'V', asOwner),
      /V must authenticate as running_tracker_owner/u,
    );
    assert.throws(() => parseDatabaseUrl(owner.replace('postgresql:', 'mysql:'), 'V', asOwner), /postgres or postgresql protocol/u);
    assert.throws(() => parseDatabaseUrl('not a url', 'V', asOwner), /V must be a valid PostgreSQL URL/u);
    assert.throws(() => parseDatabaseUrl(undefined, 'V', asOwner), /V is required/u);
    assert.throws(() => parseDatabaseUrl(owner.replace('_test', ''), 'V', asOwner), /V must target a database ending in _test/u);
    assert.throws(
      () => parseDatabaseUrl(owner.replace(':secret', ''), 'V', { ...asOwner, requirePassword: true }),
      /V must include the role password/u,
    );
  });

  it('refuses to go on unless the server reports the expected login and database', async () => {
    const reporting = (role_name, database_name) => ({ query: async () => ({ rows: [{ database_name, role_name }] }) });
    const expected = { database: 'running_tracker_test', user: 'running_tracker_owner' };

    await assertConnectedIdentity(reporting('running_tracker_owner', 'running_tracker_test'), expected, 'V');
    await assert.rejects(
      assertConnectedIdentity(reporting('running_tracker', 'running_tracker_test'), expected, 'V'),
      /V connected as role running_tracker to database running_tracker_test, not as running_tracker_owner to running_tracker_test; nothing was changed/u,
    );
    await assert.rejects(assertConnectedIdentity(reporting('running_tracker_owner', 'postgres'), expected, 'V'), /nothing was changed/u);
    // A URL without a user checks the database only.
    await assertConnectedIdentity(reporting('anyone', 'running_tracker_test'), { ...expected, user: '' }, 'V');
  });
});
