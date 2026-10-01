import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createPgToolRunner, parsePgConnection, type SpawnFunction } from './pg-tools.js';

const connection = {
  database: 'running_tracker_restore_drill_x_source',
  host: '127.0.0.1',
  password: 'S3cr3t-Pa$$word',
  port: '5433',
  user: 'running_tracker',
};

interface FakeCall {
  args: string[];
  command: string;
  env: Record<string, string | undefined>;
  stdin: PassThrough;
}

function fakeSpawn(behavior: {
  code?: number;
  error?: NodeJS.ErrnoException;
  stderr?: string;
  stdout?: Buffer | string;
}): { calls: FakeCall[]; spawn: SpawnFunction } {
  const calls: FakeCall[] = [];
  const spawn = ((command: string, args: string[], options: { env: Record<string, string | undefined> }) => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: PassThrough;
      stdin: PassThrough;
      stdout: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    calls.push({ args, command, env: options.env, stdin: child.stdin });
    setImmediate(() => {
      if (behavior.error) {
        child.emit('error', behavior.error);
        return;
      }
      child.stdout.end(behavior.stdout);
      child.stderr.end(behavior.stderr);
      // A real child closes only after its stdio streams ended.
      setImmediate(() => child.emit('close', behavior.code ?? 0, null));
    });
    return child;
  }) as unknown as SpawnFunction;
  return { calls, spawn };
}

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('PostgreSQL connection parsing', () => {
  it('extracts user, password, database, host and port from a URL', () => {
    expect(parsePgConnection('postgresql://u%40x:p%2Fw@127.0.0.1:5433/db_name')).toEqual({
      database: 'db_name',
      host: '127.0.0.1',
      password: 'p/w',
      port: '5433',
      user: 'u@x',
    });
  });

  it('defaults the port and rejects a URL without a database or with another protocol', () => {
    expect(parsePgConnection('postgres://u:p@localhost/db').port).toBe('5432');
    expect(() => parsePgConnection('postgres://u:p@localhost')).toThrow('database');
    expect(() => parsePgConnection('mysql://u:p@localhost/db')).toThrow('PostgreSQL URL');
    expect(() => parsePgConnection('not a url')).toThrow('PostgreSQL URL');
  });

  it('never echoes the URL in an error', () => {
    expect(() => parsePgConnection('mysql://user:hunter2@localhost/db')).not.toThrow(/hunter2/u);
  });
});

describe('PostgreSQL tool runner', () => {
  it('runs a local pg_dump in custom format with the password only in the environment', async () => {
    const { calls, spawn } = fakeSpawn({ stdout: 'ARCHIVE-BYTES' });
    const commands: string[][] = [];
    const runner = createPgToolRunner({ onCommand: (argv) => commands.push(argv), spawn });

    const bytes = await drain(runner.dump(connection));

    expect(bytes.toString()).toBe('ARCHIVE-BYTES');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('pg_dump');
    expect(calls[0]!.args).toEqual([
      '--format=custom',
      '--no-password',
      '--host',
      '127.0.0.1',
      '--port',
      '5433',
      '--username',
      'running_tracker',
      '--dbname',
      'running_tracker_restore_drill_x_source',
    ]);
    expect(calls[0]!.env.PGPASSWORD).toBe(connection.password);
    expect(JSON.stringify(calls[0]!.args)).not.toContain(connection.password);
    expect(JSON.stringify(commands)).not.toContain(connection.password);
    expect(commands[0]!.join(' ')).toContain('pg_dump --format=custom');
  });

  it('runs inside a named container through docker exec, forwarding the password by name only', async () => {
    const { calls, spawn } = fakeSpawn({ stdout: 'x' });
    const runner = createPgToolRunner({ dockerContainer: 'running-tracker-postgres-1', spawn });

    await drain(runner.dump(connection));

    expect(calls[0]!.command).toBe('docker');
    expect(calls[0]!.args.slice(0, 6)).toEqual([
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      'running-tracker-postgres-1',
      'pg_dump',
    ]);
    // Inside the container the server is addressed locally, on its own port.
    expect(calls[0]!.args).toContain('127.0.0.1');
    expect(calls[0]!.args).toContain('5432');
    expect(calls[0]!.args).not.toContain('5433');
    expect(JSON.stringify(calls[0]!.args)).not.toContain(connection.password);
    expect(calls[0]!.env.PGPASSWORD).toBe(connection.password);
  });

  it('rejects a container name that is not a plain identifier', () => {
    const { spawn } = fakeSpawn({});
    for (const name of ['', 'a b', '--privileged', 'x;rm', '-x']) {
      expect(() => createPgToolRunner({ dockerContainer: name, spawn })).toThrow('container name');
    }
  });

  it('fails the dump stream when pg_dump exits non-zero, with scrubbed diagnostics', async () => {
    const { spawn } = fakeSpawn({
      code: 1,
      stderr: `pg_dump: error: connection failed for password ${connection.password}\n`,
      stdout: 'partial',
    });
    const runner = createPgToolRunner({ spawn });

    const error = await drain(runner.dump(connection)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('pg_dump failed with exit code 1');
    expect(message).toContain('connection failed');
    expect(message).not.toContain(connection.password);
  });

  it('reports a missing tool clearly and never falls back silently', async () => {
    const missing = Object.assign(new Error('spawn pg_dump ENOENT'), { code: 'ENOENT' });
    const runner = createPgToolRunner({ spawn: fakeSpawn({ error: missing }).spawn });

    const error = await drain(runner.dump(connection)).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('pg_dump is not available');
    expect((error as Error).message).toContain('BACKUP_PG_DOCKER_CONTAINER');
  });

  it('feeds pg_restore from the input stream and uses one transaction that stops at the first error', async () => {
    const { calls, spawn } = fakeSpawn({});
    const runner = createPgToolRunner({ spawn });

    const done = runner.restore(connection, Readable.from([Buffer.from('ARCHIVE')]));
    const received = drain(calls.length > 0 ? calls[0]!.stdin : await waitForCall(calls));
    await done;

    expect((await received).toString()).toBe('ARCHIVE');
    expect(calls[0]!.command).toBe('pg_restore');
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining(['--format=custom', '--single-transaction', '--exit-on-error', '--no-password']),
    );
    expect(calls[0]!.env.PGPASSWORD).toBe(connection.password);
  });

  it('rejects the restore, not with a broken pipe, when pg_restore fails', async () => {
    const { calls, spawn } = fakeSpawn({ code: 1, stderr: 'pg_restore: error: could not execute query\n' });
    const runner = createPgToolRunner({ spawn });

    const done = runner.restore(connection, Readable.from([Buffer.alloc(1_000_000)]));
    if (calls.length === 0) await waitForCall(calls);
    calls[0]!.stdin.resume();

    await expect(done).rejects.toThrow('pg_restore failed with exit code 1');
  });

  it('reads the tool version', async () => {
    const { calls, spawn } = fakeSpawn({ stdout: 'pg_dump (PostgreSQL) 17.5 (Debian)\n' });
    const runner = createPgToolRunner({ spawn });
    expect(await runner.version('pg_dump')).toBe('pg_dump (PostgreSQL) 17.5 (Debian)');
    expect(calls[0]!.args).toEqual(['--version']);
  });
});

async function waitForCall(calls: FakeCall[]): Promise<PassThrough> {
  while (calls.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return calls[0]!.stdin;
}
