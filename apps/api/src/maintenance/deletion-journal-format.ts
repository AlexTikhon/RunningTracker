import { z } from 'zod';

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const utcMillisecondPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const deletionJournalFileNamePattern = /^deletion-journal-[0-9A-Za-z._-]+\.ndjson$/u;

/**
 * One exported deletion. Identifiers and timestamps only: no coordinates, no
 * run payload, no session data. `seq` is the source database's outbox sequence,
 * kept for diagnostics; it restarts after a restore, so it is never a key.
 */
const journalEntrySchema = z.strictObject({
  deletedAt: z.string().regex(utcMillisecondPattern),
  orgId: z.string().regex(canonicalUuidPattern),
  ownerUserId: z.string().regex(canonicalUuidPattern),
  runId: z.string().regex(canonicalUuidPattern),
  seq: z.string().regex(/^[1-9]\d{0,18}$/u),
  v: z.literal(1),
});

export type DeletionJournalEntry = z.infer<typeof journalEntrySchema>;

function isCalendarInstant(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

/** One JSON object per line, newline-terminated, in the order given. */
export function serializeDeletionJournalEntries(
  entries: readonly DeletionJournalEntry[],
): string {
  return entries.map((entry) => `${JSON.stringify(journalEntrySchema.parse(entry))}\n`).join('');
}

/**
 * Strict reader. A deletion record that is silently skipped would let deleted
 * data return, so any malformed line, unknown key, bad UUID or non-canonical
 * instant rejects the whole file instead of being ignored.
 */
export function parseDeletionJournalFile(
  fileName: string,
  contents: string,
): DeletionJournalEntry[] {
  if (contents.length > 0 && !contents.endsWith('\n')) {
    throw new Error(`Deletion journal ${fileName} is truncated (missing final newline)`);
  }

  const entries: DeletionJournalEntry[] = [];
  const lines = contents.split('\n');
  lines.pop();
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      throw new Error(`Deletion journal ${fileName} line ${lineNumber} is not valid JSON`);
    }
    const parsed = journalEntrySchema.safeParse(parsedJson);
    if (!parsed.success || !isCalendarInstant(parsed.data.deletedAt)) {
      throw new Error(`Deletion journal ${fileName} line ${lineNumber} is not a valid entry`);
    }
    entries.push(parsed.data);
  });
  return entries;
}
