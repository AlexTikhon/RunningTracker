import { canonicalUuidSchema } from '@running-tracker/contracts';
import { z } from 'zod';

// Microsecond UTC instants, exactly as PostgreSQL stores timestamptz: replay compares the record's creation instant
// for equality, so no precision may be lost on the way through the file.
const utcMicrosecondPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

export const erasureLedgerFileNamePattern = /^erasure-ledger-[0-9A-Za-z._-]+\.ndjson$/u;

/**
 * The owner-only entities whose erasures are journaled (ADR-0073, ADR-0074, ADR-0078). The next one is added here and
 * in SQL.
 */
export const erasureEntityTypes = ['activity', 'daily_metric', 'daily_movement'] as const;

/**
 * One exported erasure. Identifiers and timestamps only: no record content. `seq` is the source database's outbox
 * sequence, kept for diagnostics; it restarts after a restore, so it is never a key.
 */
const erasureEntrySchema = z.strictObject({
  entityType: z.enum(erasureEntityTypes),
  erasedAt: z.string().regex(utcMicrosecondPattern),
  orgId: canonicalUuidSchema,
  ownerUserId: canonicalUuidSchema,
  recordCreatedAt: z.string().regex(utcMicrosecondPattern),
  recordId: canonicalUuidSchema,
  seq: z.string().regex(/^[1-9]\d{0,18}$/u),
  v: z.literal(1),
});

export type ErasureLedgerEntry = z.infer<typeof erasureEntrySchema>;

function isCalendarInstant(value: string): boolean {
  // Date has millisecond precision: compare the instant up to milliseconds, and the digits after it are already
  // constrained by the pattern.
  const milliseconds = `${value.slice(0, 23)}Z`;
  const parsed = new Date(milliseconds);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === milliseconds;
}

/** One JSON object per line, newline-terminated, in the order given. */
export function serializeErasureLedgerEntries(entries: readonly ErasureLedgerEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(erasureEntrySchema.parse(entry))}\n`).join('');
}

/**
 * Strict reader. An erasure that is silently skipped would let deleted health data return, so any malformed line,
 * unknown key or entity type, bad UUID or non-canonical instant rejects the whole file instead of being ignored.
 */
export function parseErasureLedgerFile(fileName: string, contents: string): ErasureLedgerEntry[] {
  if (contents.length > 0 && !contents.endsWith('\n')) {
    throw new Error(`Erasure ledger ${fileName} is truncated (missing final newline)`);
  }
  const lines = contents.split('\n');
  lines.pop();
  return lines.map((line, index) => {
    const lineNumber = index + 1;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      throw new Error(`Erasure ledger ${fileName} line ${lineNumber} is not valid JSON`);
    }
    const parsed = erasureEntrySchema.safeParse(parsedJson);
    if (!parsed.success || !isCalendarInstant(parsed.data.erasedAt) || !isCalendarInstant(parsed.data.recordCreatedAt)) {
      throw new Error(`Erasure ledger ${fileName} line ${lineNumber} is not a valid entry`);
    }
    return parsed.data;
  });
}
