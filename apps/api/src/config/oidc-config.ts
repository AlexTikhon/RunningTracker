import { z } from 'zod';

export const oidcCallbackPath = '/api/auth/callback';

const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost']);

// A fixed in-application path: it starts with a single slash and cannot name another origin.
const postLoginPathPattern = /^\/(?![/\\])[^\s\\]*$/u;

export const oidcEnvironmentFields = {
  OIDC_CLIENT_ID: z.string().min(1).max(256).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).max(4096).optional(),
  OIDC_ISSUER_URL: z.string().min(1).max(2048).optional(),
  OIDC_LOGIN_TTL_MS: z.coerce.number().int().positive().max(60 * 60 * 1_000).default(600_000),
  OIDC_POST_LOGIN_PATH: z
    .string()
    .refine((value) => postLoginPathPattern.test(value), {
      message: 'must be an absolute in-application path such as /',
    })
    .default('/'),
  OIDC_REDIRECT_URI: z.string().min(1).max(2048).optional(),
  OIDC_SCOPES: z.string().min(1).max(512).default('openid'),
  OIDC_STORE_MAX_ENTRIES: z.coerce.number().int().positive().max(10_000).default(100),
};

type OidcFieldValues = z.output<z.ZodObject<typeof oidcEnvironmentFields>>;

export interface OidcConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly issuerUrl: string;
  readonly loginTtlMs: number;
  readonly postLoginPath: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly storeMaxEntries: number;
}

interface OidcEnvironmentContext {
  readonly ALLOWED_ORIGINS: readonly string[];
  readonly APP_ENV: 'development' | 'production' | 'test';
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function scopesOf(value: string): string[] {
  return [...new Set(value.split(/\s+/u).filter(Boolean))];
}

function isConfigured(values: OidcFieldValues): boolean {
  return (
    values.OIDC_ISSUER_URL !== undefined ||
    values.OIDC_CLIENT_ID !== undefined ||
    values.OIDC_CLIENT_SECRET !== undefined ||
    values.OIDC_REDIRECT_URI !== undefined
  );
}

export function checkOidcEnvironment(
  values: OidcFieldValues,
  environment: OidcEnvironmentContext,
  context: z.RefinementCtx,
): void {
  const production = environment.APP_ENV === 'production';
  const fail = (path: string, message: string): void => {
    context.addIssue({ code: 'custom', message, path: [path] });
  };

  if (!isConfigured(values)) {
    if (production) {
      fail('OIDC_ISSUER_URL', 'OIDC must be configured in production: there is no other sign-in');
    }
    return;
  }

  if (
    values.OIDC_ISSUER_URL === undefined ||
    values.OIDC_CLIENT_ID === undefined ||
    values.OIDC_CLIENT_SECRET === undefined ||
    values.OIDC_REDIRECT_URI === undefined
  ) {
    fail(
      'OIDC_ISSUER_URL',
      'OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_REDIRECT_URI must be configured together',
    );
    return;
  }

  const issuer = parseUrl(values.OIDC_ISSUER_URL);
  if (!issuer || !['http:', 'https:'].includes(issuer.protocol)) {
    fail('OIDC_ISSUER_URL', 'OIDC_ISSUER_URL must be an absolute http(s) URL');
  } else {
    if (issuer.username !== '' || issuer.password !== '' || issuer.search !== '' || issuer.hash !== '') {
      fail('OIDC_ISSUER_URL', 'OIDC_ISSUER_URL must not contain credentials, a query, or a fragment');
    }
    if (issuer.protocol === 'http:') {
      if (production) {
        fail('OIDC_ISSUER_URL', 'OIDC_ISSUER_URL must be an https URL in production');
      } else if (!loopbackHosts.has(issuer.hostname)) {
        fail('OIDC_ISSUER_URL', 'OIDC_ISSUER_URL may use http only for a loopback host');
      }
    }
  }

  const redirect = parseUrl(values.OIDC_REDIRECT_URI);
  if (!redirect || !['http:', 'https:'].includes(redirect.protocol)) {
    fail('OIDC_REDIRECT_URI', 'OIDC_REDIRECT_URI must be an absolute http(s) URL');
  } else {
    if (production && redirect.protocol !== 'https:') {
      fail('OIDC_REDIRECT_URI', 'OIDC_REDIRECT_URI must be an https URL in production');
    }
    if (
      redirect.username !== '' ||
      redirect.password !== '' ||
      redirect.search !== '' ||
      redirect.hash !== '' ||
      redirect.pathname !== oidcCallbackPath
    ) {
      fail('OIDC_REDIRECT_URI', `OIDC_REDIRECT_URI must be exactly <origin>${oidcCallbackPath}`);
    }
    if (!environment.ALLOWED_ORIGINS.includes(redirect.origin)) {
      fail('OIDC_REDIRECT_URI', 'OIDC_REDIRECT_URI must be on an origin listed in ALLOWED_ORIGINS');
    }
  }

  if (!scopesOf(values.OIDC_SCOPES).includes('openid')) {
    fail('OIDC_SCOPES', 'OIDC_SCOPES must include openid');
  }
}

/** Returns the validated settings, or undefined when OIDC is not configured. */
export function buildOidcConfig(values: OidcFieldValues): OidcConfig | undefined {
  if (
    values.OIDC_ISSUER_URL === undefined ||
    values.OIDC_CLIENT_ID === undefined ||
    values.OIDC_CLIENT_SECRET === undefined ||
    values.OIDC_REDIRECT_URI === undefined
  ) {
    return undefined;
  }
  return {
    clientId: values.OIDC_CLIENT_ID,
    clientSecret: values.OIDC_CLIENT_SECRET,
    issuerUrl: values.OIDC_ISSUER_URL,
    loginTtlMs: values.OIDC_LOGIN_TTL_MS,
    postLoginPath: values.OIDC_POST_LOGIN_PATH,
    redirectUri: values.OIDC_REDIRECT_URI,
    scopes: scopesOf(values.OIDC_SCOPES),
    storeMaxEntries: values.OIDC_STORE_MAX_ENTRIES,
  };
}

/** The configuration without the raw OIDC_* variables, so the client secret is not spread around. */
export function withoutOidcFields<Environment extends OidcFieldValues>(
  environment: Environment,
): Omit<Environment, keyof OidcFieldValues> {
  const remaining: Record<string, unknown> = { ...environment };
  for (const key of Object.keys(oidcEnvironmentFields)) {
    delete remaining[key];
  }
  return remaining as Omit<Environment, keyof OidcFieldValues>;
}
