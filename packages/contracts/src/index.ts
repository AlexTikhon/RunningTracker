import { z } from 'zod';

export interface HealthResponse {
  status: 'ok' | 'not-ready';
  checks?: {
    database: 'up' | 'down';
  };
}

const uuidSchema = z.uuid();
const opaqueTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const sessionResponseSchema = z.object({
  csrf: z.object({
    headerName: z.literal('x-csrf-token'),
    token: opaqueTokenSchema,
  }),
  expiresAt: z.iso.datetime({ offset: true }),
  identity: z.object({
    userId: uuidSchema,
  }),
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
    message: z.string().min(1),
    requestId: uuidSchema,
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
