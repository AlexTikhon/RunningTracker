import { systemClock, type Clock } from '../clock.js';

export type LogLevel = 'error' | 'info' | 'warn';

const levelRank: Record<LogLevel, number> = { error: 2, info: 0, warn: 1 };
const MAX_STRING_LENGTH = 200;
const shortCodePattern = /^[A-Za-z0-9_.:-]{1,32}$/u;

/**
 * The only keys a log line may carry. Everything else (coordinates, request
 * bodies, cookies, tokens, error messages) is dropped by construction rather
 * than filtered by pattern, so a new sensitive field is safe by default.
 */
const allowedFields = new Set([
  'count',
  'durationMs',
  'errorCode',
  'errorName',
  'method',
  'orgId',
  'outcome',
  'port',
  'reason',
  'requestId',
  'route',
  'runId',
  'signal',
  'status',
  'task',
  'timeoutMs',
]);

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  error(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  clock: Pick<Clock, 'utcNow'>;
  minLevel?: LogLevel;
  write: (level: LogLevel, line: string) => void;
}

function primitive(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string') {
    return value.slice(0, MAX_STRING_LENGTH);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

export function createLogger({ clock, minLevel = 'info', write }: LoggerOptions): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    if (levelRank[level] < levelRank[minLevel]) {
      return;
    }
    try {
      const entry: Record<string, unknown> = {
        event: String(event).slice(0, MAX_STRING_LENGTH),
        level,
        time: clock.utcNow().toISOString(),
      };
      let dropped = 0;
      for (const key of Object.keys(fields)) {
        let value: string | number | boolean | undefined;
        if (allowedFields.has(key)) {
          try {
            value = primitive(fields[key]);
          } catch {
            value = undefined;
          }
        }
        if (value === undefined) {
          dropped += 1;
        } else {
          entry[key] = value;
        }
      }
      if (dropped > 0) {
        entry.droppedFields = dropped;
      }
      write(level, JSON.stringify(entry));
    } catch {
      // Logging must never change request or job behavior.
    }
  };

  return {
    error: (event, fields) => emit('error', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
  };
}

/** Error class name and a short machine code (for example a SQLSTATE); never message or stack. */
export function describeError(error: unknown): { errorCode?: string; errorName: string } {
  if (!(error instanceof Error)) {
    return { errorName: 'UnknownError' };
  }
  const code = (error as { code?: unknown }).code;
  return {
    errorName: error.name,
    ...(typeof code === 'string' && shortCodePattern.test(code) ? { errorCode: code } : {}),
  };
}

/**
 * Writes through the console methods so container runtimes keep their
 * stdout/stderr split and tests can still silence output with a console spy.
 */
export const consoleSink: LoggerOptions['write'] = (level, line) => {
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.info(line);
  }
};

/** Process-wide default for code paths with no injected logger. */
export const defaultLogger: Logger = createLogger({ clock: systemClock, write: consoleSink });
