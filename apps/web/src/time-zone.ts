// Time-zone identities compared by what they name, not by spelling. The API stores and echoes the zone in its platform's
// canonical spelling (canonicalTimeZone in the API: Intl's resolvedOptions().timeZone), so a request for `europe/warsaw`
// is answered for `Europe/Warsaw`, and one for an alias such as `US/Eastern` may be answered for `America/New_York`.

interface TemporalZonedDateTime {
  equals(other: TemporalZonedDateTime): boolean;
}
interface TemporalGlobal {
  ZonedDateTime: new (epochNanoseconds: bigint, timeZone: string) => TemporalZonedDateTime;
}

/**
 * The zone in this engine's canonical spelling, the same convention as the API's canonicalTimeZone. Throws a RangeError
 * for a name that is not a time zone.
 */
export function canonicalTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
}

/**
 * Whether two identifiers name the same zone: equal after canonicalization in this engine, or, where an engine keeps an
 * alias as spelled (ECMA-402 without alias resolution), equal by Temporal's zone identity, which resolves aliases to their
 * primary zone. An invalid name names no zone, so it is never the same as anything (no exception escapes).
 */
export function sameTimeZone(left: string, right: string): boolean {
  try {
    if (canonicalTimeZone(left) === canonicalTimeZone(right)) return true;
  } catch {
    return false;
  }
  const temporal = (globalThis as { Temporal?: TemporalGlobal }).Temporal;
  if (temporal === undefined) return false;
  try {
    return new temporal.ZonedDateTime(0n, left).equals(new temporal.ZonedDateTime(0n, right));
  } catch {
    return false;
  }
}
