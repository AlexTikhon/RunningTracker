import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { PassThrough, pipeline, type Readable } from 'node:stream';

export type SpawnFunction = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface PgConnection {
  database: string;
  host: string;
  password: string;
  port: string;
  user: string;
}

export function parsePgConnection(connectionString: string): PgConnection {
  // Messages never include the URL: it carries a password.
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('The value must be a valid PostgreSQL URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('The value must be a valid PostgreSQL URL (postgres or postgresql protocol)');
  }
  let database: string;
  let user: string;
  let password: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new Error('The PostgreSQL URL contains invalid percent-encoding');
  }
  if (!database) {
    throw new Error('The PostgreSQL URL must name a database');
  }
  return { database, host: url.hostname, password, port: url.port || '5432', user };
}

/** The reverse of parsePgConnection. The result carries the password: never log it. */
export function formatPgConnection(connection: PgConnection): string {
  const host = connection.host.includes(':') ? `[${connection.host}]` : connection.host;
  return `postgresql://${encodeURIComponent(connection.user)}:${encodeURIComponent(connection.password)}@${host}:${connection.port}/${encodeURIComponent(connection.database)}`;
}

export type PgTool = 'pg_dump' | 'pg_restore';

/**
 * Tables whose schema is backed up without their rows (ADR-0080). Authenticated sessions are only meaningful for the
 * running database: a restore must make everyone sign in again, and a backup must not carry live bearer-token digests
 * or CSRF tokens. A name that does not exist yet (a database older than migration 0036) matches nothing.
 */
export const BACKUP_EXCLUDED_TABLE_DATA = ['app_private.auth_sessions'] as const;

export interface PgToolRunner {
  /**
   * pg_dump --format=custom, without the rows of BACKUP_EXCLUDED_TABLE_DATA. The stream errors, rather than just
   * ending, when the dump failed.
   */
  dump(connection: PgConnection): Readable;
  /** Resolves only after pg_restore consumed all of `input` and exited with status 0. */
  restore(connection: PgConnection, input: Readable): Promise<void>;
  version(tool: PgTool): Promise<string>;
}

export interface PgToolRunnerOptions {
  /** Run the tools inside this container (`docker exec`) instead of on this machine. */
  dockerContainer?: string;
  /** Receives every external command line, never including a secret. */
  onCommand?: (argv: string[]) => void;
  spawn?: SpawnFunction;
  /**
   * Upper bound of one pg_dump or pg_restore run (default 15 minutes); `--version` gets 30 seconds. A child that is
   * still running then is killed and the call fails with a timeout error: no caller waits on a stuck tool forever.
   */
  timeoutMs?: number;
}

export const PG_TOOL_DEFAULT_TIMEOUT_MS = 15 * 60_000;
const PG_TOOL_VERSION_TIMEOUT_MS = 30_000;

/** Kills `child` after `ms`; `expired()` tells whether it did. Cleared when the child closes. */
function deadline(child: ChildProcess, ms: number): { expired: () => boolean } {
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    child.kill('SIGKILL');
  }, ms);
  timer.unref?.();
  child.once('close', () => clearTimeout(timer));
  child.once('error', () => clearTimeout(timer));
  return { expired: () => fired };
}

const timedOut = (tool: PgTool, ms: number) => new Error(`${tool} did not finish within ${ms} ms and was stopped`);

const containerNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const stderrTailChars = 2000;

function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join('[redacted]');
  }
  return result;
}

function collectTail(stream: Readable | null, secrets: readonly string[]): () => string {
  let tail = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => {
    tail = (tail + chunk).slice(-stderrTailChars);
  });
  return () => redact(tail, secrets).trim();
}

export function createPgToolRunner(options: PgToolRunnerOptions = {}): PgToolRunner {
  const spawn: SpawnFunction = options.spawn ?? nodeSpawn;
  const container = options.dockerContainer;
  const timeoutMs = options.timeoutMs ?? PG_TOOL_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be a positive integer');
  if (container !== undefined && !containerNamePattern.test(container)) {
    throw new Error('The container name must be a plain Docker container name or ID');
  }

  function unavailable(tool: PgTool): Error {
    return new Error(
      container
        ? 'docker is not available: install Docker or run the PostgreSQL client tools locally'
        : `${tool} is not available: install the PostgreSQL client tools or set BACKUP_PG_DOCKER_CONTAINER to run them inside the database container`,
    );
  }

  function toolArguments(
    tool: PgTool,
    args: string[],
    connection?: PgConnection,
  ): { argv: string[]; command: string; env: NodeJS.ProcessEnv } {
    const connectionArgs = connection
      ? [
          '--no-password',
          // Inside the container the server is reached locally on its own port.
          '--host',
          container ? '127.0.0.1' : connection.host,
          '--port',
          container ? '5432' : connection.port,
          '--username',
          connection.user,
          '--dbname',
          connection.database,
        ]
      : [];
    const toolArgs = [...args, ...connectionArgs];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (connection) env.PGPASSWORD = connection.password;
    const argv = container
      ? ['docker', 'exec', '-i', ...(connection ? ['-e', 'PGPASSWORD'] : []), container, tool, ...toolArgs]
      : [tool, ...toolArgs];
    options.onCommand?.(argv);
    return { argv: argv.slice(1), command: argv[0]!, env };
  }

  function failure(tool: PgTool, code: number | null, tail: string): Error {
    const detail = tail ? `: ${tail}` : '';
    return new Error(`${tool} failed with exit code ${String(code)}${detail}`);
  }

  return {
    dump(connection) {
      const { argv, command, env } = toolArguments(
        'pg_dump',
        ['--format=custom', ...BACKUP_EXCLUDED_TABLE_DATA.map((table) => `--exclude-table-data=${table}`)],
        connection,
      );
      const secrets = [connection.password];
      const output = new PassThrough();
      const child = spawn(command, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const stderr = collectTail(child.stderr, secrets);
      const bound = deadline(child, timeoutMs);
      let settled = false;
      child.stdout?.pipe(output, { end: false });
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        output.destroy(error.code === 'ENOENT' ? unavailable('pg_dump') : new Error('pg_dump could not be started'));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        if (bound.expired()) {
          output.destroy(timedOut('pg_dump', timeoutMs));
        } else if (code === 0) {
          output.end();
        } else {
          output.destroy(failure('pg_dump', code, stderr()));
        }
      });
      return output;
    },

    restore(connection, input) {
      const { argv, command, env } = toolArguments(
        'pg_restore',
        ['--format=custom', '--single-transaction', '--exit-on-error'],
        connection,
      );
      const secrets = [connection.password];
      const child = spawn(command, argv, { env, stdio: ['pipe', 'ignore', 'pipe'] });
      const stderr = collectTail(child.stderr, secrets);
      const bound = deadline(child, timeoutMs);

      return new Promise<void>((resolve, reject) => {
        let killedForInput = false;
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };
        // Resolves with the first error of the input side, or undefined once all input was delivered.
        const inputSettled = new Promise<Error | undefined>((settleInput) => {
          if (!child.stdin) {
            settleInput(new Error('pg_restore has no input stream'));
            return;
          }
          // A tool that exits early closes the pipe; that is reported through the exit code instead.
          child.stdin.on('error', () => undefined);
          pipeline(input, child.stdin, (error) => {
            if (error && !child.killed && child.exitCode === null) {
              killedForInput = true;
              child.kill();
            }
            settleInput(error ?? undefined);
          });
        });

        child.once('error', (error: NodeJS.ErrnoException) => {
          input.destroy();
          finish(error.code === 'ENOENT' ? unavailable('pg_restore') : new Error('pg_restore could not be started'));
        });
        child.once('close', (code) => {
          if (bound.expired()) {
            input.destroy();
            finish(timedOut('pg_restore', timeoutMs));
            return;
          }
          void inputSettled.then((inputError) => {
            if (code !== 0 && !killedForInput) {
              finish(failure('pg_restore', code, stderr()));
            } else if (inputError) {
              finish(inputError);
            } else {
              finish();
            }
          });
        });
      });
    },

    async version(tool) {
      const { argv, command, env } = toolArguments(tool, ['--version']);
      const child = spawn(command, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const stderr = collectTail(child.stderr, []);
      const bound = deadline(child, Math.min(timeoutMs, PG_TOOL_VERSION_TIMEOUT_MS));
      let output = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        output += chunk;
      });
      await new Promise<void>((resolve, reject) => {
        child.once('error', (error: NodeJS.ErrnoException) => {
          reject(error.code === 'ENOENT' ? unavailable(tool) : new Error(`${tool} could not be started`));
        });
        child.once('close', (code) => {
          if (bound.expired()) reject(timedOut(tool, Math.min(timeoutMs, PG_TOOL_VERSION_TIMEOUT_MS)));
          else if (code === 0) resolve();
          else reject(failure(tool, code, stderr()));
        });
      });
      return output.trim();
    },
  };
}
