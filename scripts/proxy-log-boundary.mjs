import { randomBytes } from 'node:crypto';

// Canary probes for the proxy's log boundary (ADR-0062), shared by the profile verifiers. Every check returns a
// count, never the text that matched, so a failing run cannot print a contaminated log sample.

export function createCanary(label) {
  return `${label}${randomBytes(12).toString('hex')}`;
}

export function percentEncodeAll(value) {
  return [...Buffer.from(value)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
}

// Every form a canary can take in a log line: as sent, and percent-encoded byte by byte in either case. Canaries
// are letters and digits, so an escaped quote or backslash next to one never splits it.
export function canaryForms(value) {
  const encoded = percentEncodeAll(value);
  return [value, encoded, encoded.toUpperCase()];
}

export function countExposed(text, canaries) {
  return canaries.filter((canary) => canaryForms(canary).some((form) => text.includes(form))).length;
}

const lines = (text) => text.replaceAll('\r', '').split('\n').filter((line) => line.length > 0);

// The only lines the error-log sanitizer writes: a validated nginx prefix (or its own tag) and an allow-listed
// event with numeric or identifier details. Free text never matches.
const LEVEL = '(?:emerg|alert|crit|error|warn|notice|info|debug)';
export const SANITIZED_ERROR_LINE = new RegExp(
  `^(?:\\d{4}/\\d\\d/\\d\\d \\d\\d:\\d\\d:\\d\\d \\[${LEVEL}\\] \\d+#\\d+: (?:\\*\\d+ )?|nginx: \\[${LEVEL}\\] |nginx-error-log: )` +
    'event=[a-z][a-z_]*(?: [a-z][a-z_]*=[A-Za-z0-9_./-]+)*$',
  'u',
);

export function unsanitizedLineCount(errorStream) {
  return lines(errorStream).filter((line) => !SANITIZED_ERROR_LINE.test(line)).length;
}

// Sanitized error lines that went to the access stream instead of stderr.
export function misroutedErrorLineCount(accessStream) {
  return lines(accessStream).filter((line) => SANITIZED_ERROR_LINE.test(line)).length;
}

// Sanitized error events by connection number (nginx's `*N`, the access log's `connection=N`).
export function errorEvents(errorStream) {
  return lines(errorStream).flatMap((line) => {
    const match = /^\S+ \S+ \[(\w+)\] \d+#\d+: \*(\d+) event=([a-z_]+)/u.exec(line);
    return match ? [{ connection: match[2], event: match[3], level: match[1] }] : [];
  });
}

// Access entries with the sanitized error events of their connection. nginx writes the error entry first, but it
// reaches Docker after the access entry because it passes through the sanitizer, so callers poll for the pair.
export function correlate(streams) {
  const events = errorEvents(streams.error);
  return accessEntries(streams.access).map((entry) => ({
    ...entry,
    events: events.filter((event) => event.connection === entry.connection).map((event) => event.event),
  }));
}

// Access log entries in the query-free format; `connection` is undefined for a format without it.
export function accessEntries(accessStream) {
  return lines(accessStream).flatMap((line) => {
    const match = /"(\S+) (\S+) (\S+)" (\d{3}) \d+ upstream=\S+ request_time=[\d.]+(?: connection=(\d+))?$/u.exec(line);
    return match ? [{ connection: match[5], method: match[1], path: match[2], status: Number(match[4]) }] : [];
  });
}
