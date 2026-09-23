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

export type UUID = z.infer<typeof uuidSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export type Seq = z.infer<typeof seqSchema>;
export type Timestamp = z.infer<typeof timestampSchema>;
