import type { Pool } from 'pg';

/** Maps a provider identity to a provisioned user id; undefined when nobody was provisioned. */
export type IdentityResolver = (externalIdentity: string) => Promise<string | undefined>;

/**
 * The stored identity is `<issuer>|<subject>`: the subject is only unique within its issuer, and
 * `|` cannot appear unescaped in an issuer URL, so the pair is unambiguous.
 */
export function oidcExternalIdentity(issuer: string, subject: string): string {
  return `${issuer}|${subject}`;
}

export function createDatabaseIdentityResolver(pool: Pick<Pool, 'connect'>): IdentityResolver {
  return async (externalIdentity) => {
    if (externalIdentity.trim() === '') {
      return undefined;
    }
    const client = await pool.connect();
    try {
      const result = await client.query<{ user_id: string | null }>(
        'SELECT app_private.resolve_login_user($1) AS user_id',
        [externalIdentity],
      );
      return result.rows[0]?.user_id ?? undefined;
    } finally {
      client.release();
    }
  };
}
