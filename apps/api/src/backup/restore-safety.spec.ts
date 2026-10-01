import { describe, expect, it } from 'vitest';

import {
  assertDatabaseMayBeDropped,
  assertDrillDatabaseName,
  assertRecoveryComplete,
  createRecoveryTracker,
  deriveDrillDatabases,
  drillDatabasePrefix,
  parseDrillConfiguration,
  recoverySteps,
} from './restore-safety.js';

const base = {
  BACKUP_ENCRYPTION_KEY_FILE: '/keys/backup.key',
  RESTORE_DRILL_ADMIN_URL: 'postgresql://running_tracker:admin_pw@127.0.0.1:5433/postgres',
  RESTORE_DRILL_MAINTENANCE_URL:
    'postgresql://running_tracker_maintenance:maint_pw@127.0.0.1:5433/running_tracker_restore_drill',
  RESTORE_DRILL_OWNER_URL:
    'postgresql://running_tracker_owner:owner_pw@127.0.0.1:5433/running_tracker_restore_drill',
  RESTORE_DRILL_RUNTIME_URL:
    'postgresql://running_tracker_runtime:runtime_pw@127.0.0.1:5433/running_tracker_restore_drill',
};

describe('drill database names', () => {
  it('accepts the dedicated prefix with an optional lowercase suffix', () => {
    for (const name of [
      'running_tracker_restore_drill',
      'running_tracker_restore_drill_20261001t101500_source',
      'running_tracker_restore_drill_a1',
    ]) {
      expect(() => assertDrillDatabaseName(name), name).not.toThrow();
    }
    expect(drillDatabasePrefix).toBe('running_tracker_restore_drill');
  });

  it('refuses the development, test, load-test, maintenance and production-like databases', () => {
    for (const name of [
      'running_tracker',
      'running_tracker_test',
      'running_tracker_load_test',
      'postgres',
      'template0',
      'template1',
      'production',
      'running_tracker_prod',
    ]) {
      expect(() => assertDrillDatabaseName(name), name).toThrow('restore drill');
    }
  });

  it('refuses look-alikes: wrong case, extra characters, separators, injection, or a name that is too long', () => {
    for (const name of [
      'running_tracker_restore_drill_',
      'running_tracker_restore_drill-x',
      'running_tracker_restore_drill_X',
      'running_tracker_restore_drill x',
      'running_tracker_restore_drill"; DROP DATABASE running_tracker; --',
      'xrunning_tracker_restore_drill',
      'running_tracker_restore_drill_test/../running_tracker',
      `running_tracker_restore_drill_${'a'.repeat(40)}`,
      '',
    ]) {
      expect(() => assertDrillDatabaseName(name), name).toThrow('restore drill');
    }
  });

  it('applies the same rule before any database is dropped', () => {
    expect(() => assertDatabaseMayBeDropped('running_tracker_restore_drill_x_target')).not.toThrow();
    for (const name of ['running_tracker', 'running_tracker_test', 'running_tracker_load_test', 'postgres']) {
      expect(() => assertDatabaseMayBeDropped(name), name).toThrow('Refusing to drop');
    }
  });
});

describe('drill configuration', () => {
  it('parses loopback URLs for the administrator and the three application roles', () => {
    const configuration = parseDrillConfiguration(base);
    expect(configuration.host).toBe('127.0.0.1');
    expect(configuration.port).toBe('5433');
    expect(configuration.admin.user).toBe('running_tracker');
    expect(configuration.keyFile).toBe('/keys/backup.key');
    expect(configuration.dockerContainer).toBeUndefined();
  });

  it('derives source and target names and URLs on the same server, never reusing a configured database', () => {
    const configuration = parseDrillConfiguration({ ...base, BACKUP_PG_DOCKER_CONTAINER: 'pg-1' });
    const derived = deriveDrillDatabases(configuration, '20261001t101500');

    expect(derived.source.database).toBe('running_tracker_restore_drill_20261001t101500_source');
    expect(derived.target.database).toBe('running_tracker_restore_drill_20261001t101500_target');
    expect(configuration.dockerContainer).toBe('pg-1');
    for (const side of [derived.source, derived.target]) {
      expect(new URL(side.ownerUrl).pathname).toBe(`/${side.database}`);
      expect(new URL(side.runtimeUrl).pathname).toBe(`/${side.database}`);
      expect(new URL(side.maintenanceUrl).pathname).toBe(`/${side.database}`);
      expect(new URL(side.adminUrl).pathname).toBe(`/${side.database}`);
      expect(decodeURIComponent(new URL(side.ownerUrl).username)).toBe('running_tracker_owner');
    }
  });

  it('refuses a suffix that would not make a valid drill name', () => {
    const configuration = parseDrillConfiguration(base);
    for (const suffix of ['', 'UP', 'a b', 'a-b', 'x'.repeat(30), '../x']) {
      expect(() => deriveDrillDatabases(configuration, suffix), suffix).toThrow();
    }
  });

  it('refuses remote targets for every URL', () => {
    for (const name of [
      'RESTORE_DRILL_ADMIN_URL',
      'RESTORE_DRILL_OWNER_URL',
      'RESTORE_DRILL_RUNTIME_URL',
      'RESTORE_DRILL_MAINTENANCE_URL',
    ]) {
      const url = new URL(base[name as keyof typeof base]);
      url.hostname = 'db.example.com';
      expect(() => parseDrillConfiguration({ ...base, [name]: url.toString() }), name).toThrow(
        `${name} must point at a loopback host`,
      );
    }
    for (const host of ['localhost', '[::1]']) {
      const url = new URL(base.RESTORE_DRILL_ADMIN_URL);
      url.hostname = host;
      expect(() =>
        parseDrillConfiguration({
          ...base,
          RESTORE_DRILL_ADMIN_URL: url.toString(),
          RESTORE_DRILL_MAINTENANCE_URL: base.RESTORE_DRILL_MAINTENANCE_URL.replace('127.0.0.1', host),
          RESTORE_DRILL_OWNER_URL: base.RESTORE_DRILL_OWNER_URL.replace('127.0.0.1', host),
          RESTORE_DRILL_RUNTIME_URL: base.RESTORE_DRILL_RUNTIME_URL.replace('127.0.0.1', host),
        }),
      ).not.toThrow();
    }
  });

  it('refuses a role URL that targets the normal, test, or load-test database', () => {
    for (const database of ['running_tracker', 'running_tracker_test', 'running_tracker_load_test', 'production']) {
      expect(() =>
        parseDrillConfiguration({
          ...base,
          RESTORE_DRILL_OWNER_URL: `postgresql://running_tracker_owner:owner_pw@127.0.0.1:5433/${database}`,
        }),
      ).toThrow('RESTORE_DRILL_OWNER_URL must name a restore drill database');
    }
  });

  it('refuses the wrong login for each application role and an application login as administrator', () => {
    expect(() =>
      parseDrillConfiguration({
        ...base,
        RESTORE_DRILL_OWNER_URL: base.RESTORE_DRILL_OWNER_URL.replace('running_tracker_owner', 'running_tracker_runtime'),
      }),
    ).toThrow('RESTORE_DRILL_OWNER_URL must authenticate as running_tracker_owner');
    expect(() =>
      parseDrillConfiguration({
        ...base,
        RESTORE_DRILL_RUNTIME_URL: base.RESTORE_DRILL_RUNTIME_URL.replace('running_tracker_runtime', 'running_tracker_owner'),
      }),
    ).toThrow('RESTORE_DRILL_RUNTIME_URL must authenticate as running_tracker_runtime');
    expect(() =>
      parseDrillConfiguration({
        ...base,
        RESTORE_DRILL_MAINTENANCE_URL: base.RESTORE_DRILL_MAINTENANCE_URL.replace(
          'running_tracker_maintenance',
          'running_tracker_runtime',
        ),
      }),
    ).toThrow('RESTORE_DRILL_MAINTENANCE_URL must authenticate as running_tracker_maintenance');
    for (const role of ['running_tracker_owner', 'running_tracker_runtime', 'running_tracker_maintenance']) {
      expect(() =>
        parseDrillConfiguration({
          ...base,
          RESTORE_DRILL_ADMIN_URL: `postgresql://${role}:pw@127.0.0.1:5433/postgres`,
        }),
      ).toThrow('RESTORE_DRILL_ADMIN_URL must authenticate as the PostgreSQL administrator');
    }
  });

  it('requires the administrator URL to name a server maintenance database, not an application database', () => {
    expect(() =>
      parseDrillConfiguration({
        ...base,
        RESTORE_DRILL_ADMIN_URL: 'postgresql://running_tracker:admin_pw@127.0.0.1:5433/running_tracker',
      }),
    ).toThrow('RESTORE_DRILL_ADMIN_URL must name the server maintenance database postgres');
  });

  it('refuses URLs that disagree about the server or that override identity through parameters', () => {
    expect(() =>
      parseDrillConfiguration({
        ...base,
        RESTORE_DRILL_OWNER_URL: base.RESTORE_DRILL_OWNER_URL.replace(':5433', ':5434'),
      }),
    ).toThrow('must name the same host and port');
    expect(() =>
      parseDrillConfiguration({
        ...base,
        RESTORE_DRILL_RUNTIME_URL: `${base.RESTORE_DRILL_RUNTIME_URL}?host=db.example.com`,
      }),
    ).toThrow('must not override connection identity');
    expect(() =>
      parseDrillConfiguration({
        ...base,
        RESTORE_DRILL_ADMIN_URL: `${base.RESTORE_DRILL_ADMIN_URL}?dbname=running_tracker`,
      }),
    ).toThrow('must not override connection identity');
  });

  it('requires every URL and the key file, naming only the variable', () => {
    for (const name of [
      'RESTORE_DRILL_ADMIN_URL',
      'RESTORE_DRILL_OWNER_URL',
      'RESTORE_DRILL_RUNTIME_URL',
      'RESTORE_DRILL_MAINTENANCE_URL',
    ]) {
      const rest = Object.fromEntries(Object.entries(base).filter(([key]) => key !== name));
      expect(() => parseDrillConfiguration(rest), name).toThrow(`${name} is required`);
    }
    const withoutKey = Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'BACKUP_ENCRYPTION_KEY_FILE'));
    expect(() => parseDrillConfiguration(withoutKey)).toThrow('BACKUP_ENCRYPTION_KEY_FILE is required');
  });

  it('never puts a password in a configuration error', () => {
    for (const bad of [
      { RESTORE_DRILL_OWNER_URL: 'postgresql://running_tracker_runtime:owner_pw@127.0.0.1:5433/running_tracker_restore_drill' },
      { RESTORE_DRILL_OWNER_URL: 'postgresql://running_tracker_owner:owner_pw@db.example.com:5433/running_tracker_restore_drill' },
      { RESTORE_DRILL_OWNER_URL: 'postgresql://running_tracker_owner:owner_pw@127.0.0.1:5433/running_tracker' },
      { RESTORE_DRILL_OWNER_URL: 'not a url owner_pw' },
    ]) {
      const error = (() => {
        try {
          parseDrillConfiguration({ ...base, ...bad });
          return undefined;
        } catch (caught) {
          return caught as Error;
        }
      })();
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).not.toContain('owner_pw');
    }
  });

  it('refuses an unsafe Docker container name', () => {
    expect(() => parseDrillConfiguration({ ...base, BACKUP_PG_DOCKER_CONTAINER: '--privileged' })).toThrow(
      'BACKUP_PG_DOCKER_CONTAINER',
    );
  });
});

describe('recovery gating', () => {
  it('lists the recovery sequence in the SDD order, with permission recovery last', () => {
    expect(recoverySteps).toEqual([
      'application_offline',
      'database_created',
      'roles_and_postgis_bootstrapped',
      'backup_restored',
      'migrations_applied',
      'migration_checksums_verified',
      'journal_copy_readonly',
      'deletions_reapplied',
      'deletion_outcomes_verified',
      'readiness_verified',
      'current_permissions_restored',
    ]);
  });

  it('refuses a step that arrives out of order', () => {
    const tracker = createRecoveryTracker();
    tracker.complete('application_offline');
    expect(() => tracker.complete('backup_restored')).toThrow('out of order');
    expect(() => tracker.complete('application_offline')).toThrow('out of order');
  });

  it('does not allow the application to open until every step, including permission recovery, is done', () => {
    const tracker = createRecoveryTracker();
    expect(() => assertRecoveryComplete(tracker)).toThrow('before the recovery steps are complete');

    for (const step of recoverySteps.slice(0, -1)) tracker.complete(step);
    expect(tracker.completed()).toHaveLength(recoverySteps.length - 1);
    expect(() => assertRecoveryComplete(tracker)).toThrow('current_permissions_restored');
  });

  it('opens only after the final step, which this tool never completes by itself', () => {
    const tracker = createRecoveryTracker();
    for (const step of recoverySteps) tracker.complete(step);
    expect(() => assertRecoveryComplete(tracker)).not.toThrow();
  });
});
