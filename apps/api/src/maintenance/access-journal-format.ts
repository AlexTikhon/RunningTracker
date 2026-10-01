import { z } from 'zod';

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const utcMillisecondPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const accessJournalFileNamePattern = /^access-journal-[0-9A-Za-z._-]+\.ndjson$/u;

const uuid = z.string().regex(canonicalUuidPattern);
const common = {
  changedAt: z.string().regex(utcMillisecondPattern),
  orgId: uuid,
  seq: z.string().regex(/^[1-9]\d{0,18}$/u),
  userId: uuid,
  v: z.literal(1),
};

/**
 * One exported access restriction. There is deliberately no kind for a grant:
 * the file is unsigned, so the reader must be unable to express anything that
 * adds access. `seq` is the source database's outbox sequence, kept for
 * diagnostics; it restarts after a restore, so it is never a key.
 */
const entrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('membership_deactivated') }),
  z.strictObject({ ...common, kind: z.literal('share_revoked'), runId: uuid }),
  z.strictObject({
    ...common,
    canReadHistory: z.boolean(),
    canReadLive: z.boolean(),
    kind: z.literal('share_narrowed'),
    runId: uuid,
  }),
]);

export type AccessJournalEntry = z.infer<typeof entrySchema>;

function isCalendarInstant(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

/** One JSON object per line, newline-terminated, in the order given. */
export function serializeAccessJournalEntries(entries: readonly AccessJournalEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(entrySchema.parse(entry))}\n`).join('');
}

/**
 * Strict reader. A restriction that is silently skipped would let revoked access
 * return, so any malformed line, unknown kind or key, bad UUID or non-canonical
 * instant rejects the whole file instead of being ignored.
 */
export function parseAccessJournalFile(fileName: string, contents: string): AccessJournalEntry[] {
  if (contents.length > 0 && !contents.endsWith('\n')) {
    throw new Error(`Access journal ${fileName} is truncated (missing final newline)`);
  }

  const entries: AccessJournalEntry[] = [];
  const lines = contents.split('\n');
  lines.pop();
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      throw new Error(`Access journal ${fileName} line ${lineNumber} is not valid JSON`);
    }
    const parsed = entrySchema.safeParse(parsedJson);
    if (!parsed.success || !isCalendarInstant(parsed.data.changedAt)) {
      throw new Error(`Access journal ${fileName} line ${lineNumber} is not a valid entry`);
    }
    entries.push(parsed.data);
  });
  return entries;
}
