import { z } from 'zod';

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const unsignedDecimalSchema = z.string().regex(/^\d+$/u, 'Expected an unsigned decimal string');

function bigintStringSchema(minimum: bigint) {
  return unsignedDecimalSchema
    .refine((value) => {
      const parsed = BigInt(value);
      return parsed >= minimum && parsed <= POSTGRES_BIGINT_MAX;
    }, `Expected a decimal string between ${minimum.toString()} and ${POSTGRES_BIGINT_MAX.toString()}`)
    .meta({
      description: `PostgreSQL bigint serialized as a decimal string in the inclusive range ${minimum.toString()}..${POSTGRES_BIGINT_MAX.toString()}.`,
    });
}

export const uuidSchema = z.uuid();

// The one UUID acceptance policy, narrowed to the lowercase spelling PostgreSQL emits. Journals, maintenance
// candidates and configured identities are compared and stored byte for byte, so they must not accept mixed case.
// Version and variant acceptance is deliberately inherited from `uuidSchema` rather than restated as a pattern.
export const canonicalUuidSchema = uuidSchema.refine(
  (value) => value === value.toLowerCase(),
  'Expected a lowercase UUID',
);

export function isCanonicalUuid(value: unknown): boolean {
  return canonicalUuidSchema.safeParse(value).success;
}
export const revisionSchema = bigintStringSchema(0n);
export const seqSchema = bigintStringSchema(1n);
export const timestampSchema = z.iso.datetime({ offset: false });
export const cursorSchema = z.string().min(1).max(4_096);

export const longitudeSchema = z.number().finite().min(-180).max(180);
export const latitudeSchema = z.number().finite().min(-90).max(90);
export const accuracyMetersSchema = z.number().finite().nonnegative();
export const nonnegativeFiniteSchema = z.number().finite().nonnegative();
export const nonnegativeIntegerSchema = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const segmentIdSchema = z.int().min(0).max(2_147_483_647);
export const coordinatesSchema = z.tuple([longitudeSchema, latitudeSchema]);

export const canonicalFiniteNumber = (value: number): number =>
  Object.is(value, -0) ? 0 : value;

// A calendar date without a time or an offset, as a person reads it on a wall calendar. It is meaningful only
// together with a time zone. The range keeps `Date.UTC` arithmetic and PostgreSQL timestamps far from their limits.
export const LOCAL_DATE_MIN_YEAR = 1970;
export const LOCAL_DATE_MAX_YEAR = 2100;

export function parseLocalDate(value: string): { day: number; month: number; year: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < LOCAL_DATE_MIN_YEAR || year > LOCAL_DATE_MAX_YEAR) {
    return null;
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { day, month, year };
}

export const localDateSchema = z
  .string()
  .refine((value) => parseLocalDate(value) !== null, 'Expected a calendar date as YYYY-MM-DD');

// An IANA time zone name. Offsets such as "+01:00" and abbreviations are refused on purpose: they do not say
// what a calendar day is in a place, which changes with daylight saving time. The platform's own database
// decides which names exist, so the browser and the server may disagree about a very new one.
const ianaNamePattern = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;

export function isSupportedIanaTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64 || !ianaNamePattern.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const ianaTimeZoneSchema = z
  .string()
  .refine(isSupportedIanaTimeZone, 'Expected an IANA time zone name such as Europe/Warsaw');

export type UUID = z.infer<typeof uuidSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export type Seq = z.infer<typeof seqSchema>;
export type Timestamp = z.infer<typeof timestampSchema>;
