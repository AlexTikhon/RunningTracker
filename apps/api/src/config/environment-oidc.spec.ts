import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment.js';

const base = {
  DATABASE_URL:
    'postgresql://running_tracker_runtime:runtime-secret@127.0.0.1:5433/running_tracker',
  MAINTENANCE_DATABASE_URL:
    'postgresql://running_tracker_maintenance:maintenance-secret@127.0.0.1:5433/running_tracker',
};

const oidc = {
  OIDC_CLIENT_ID: 'running-tracker',
  OIDC_CLIENT_SECRET: 'client-secret-value',
  OIDC_ISSUER_URL: 'https://idp.example/realm',
  OIDC_REDIRECT_URI: 'https://tracker.example/api/auth/callback',
};

const production = {
  ...base,
  ...oidc,
  ALLOWED_ORIGINS: 'https://tracker.example',
  APP_ENV: 'production',
  DELETION_JOURNAL_DIR: resolve('/var/lib/running-tracker/deletion-journal'),
  LIVE_TRACK_CURSOR_SIGNING_KEY: Buffer.from(
    'deployment-specific-live-track-key-material',
    'utf8',
  ).toString('base64url'),
};

describe('OIDC configuration', () => {
  it('is absent by default and applies bounded defaults when configured', () => {
    expect(validateEnvironment(base).OIDC).toBeUndefined();

    expect(validateEnvironment({ ...base, ...oidc, ALLOWED_ORIGINS: 'https://tracker.example' }).OIDC)
      .toEqual({
        clientId: 'running-tracker',
        clientSecret: 'client-secret-value',
        issuerUrl: 'https://idp.example/realm',
        loginTtlMs: 600_000,
        postLoginPath: '/',
        redirectUri: 'https://tracker.example/api/auth/callback',
        scopes: ['openid'],
        storeMaxEntries: 100,
      });
  });

  it('requires every connection setting once any is given', () => {
    for (const missing of Object.keys(oidc)) {
      const partial: Record<string, string> = { ...base, ...oidc };
      delete partial[missing];
      expect(() => validateEnvironment(partial), missing).toThrow(
        'OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_REDIRECT_URI must be configured together',
      );
    }
  });

  it('requires OIDC in production and an https issuer and redirect URI on an allowed origin', () => {
    expect(validateEnvironment(production).OIDC?.issuerUrl).toBe('https://idp.example/realm');

    const withoutOidc: Record<string, string> = { ...production };
    for (const key of Object.keys(oidc)) {
      delete withoutOidc[key];
    }
    expect(() => validateEnvironment(withoutOidc)).toThrow(
      'OIDC must be configured in production: there is no other sign-in',
    );
    expect(() =>
      validateEnvironment({ ...production, OIDC_ISSUER_URL: 'http://idp.example/realm' }),
    ).toThrow('OIDC_ISSUER_URL must be an https URL in production');
    expect(() =>
      validateEnvironment({
        ...production,
        OIDC_REDIRECT_URI: 'http://tracker.example/api/auth/callback',
      }),
    ).toThrow('OIDC_REDIRECT_URI must be an https URL in production');
    expect(() =>
      validateEnvironment({
        ...production,
        OIDC_REDIRECT_URI: 'https://other.example/api/auth/callback',
      }),
    ).toThrow('OIDC_REDIRECT_URI must be on an origin listed in ALLOWED_ORIGINS');
  });

  it('pins the redirect path to the callback route and forbids URL decorations', () => {
    for (const redirect of [
      'https://tracker.example/other',
      'https://tracker.example/api/auth/callback?x=1',
      'https://tracker.example/api/auth/callback#frag',
    ]) {
      expect(() =>
        validateEnvironment({
          ...base,
          ...oidc,
          ALLOWED_ORIGINS: 'https://tracker.example',
          OIDC_REDIRECT_URI: redirect,
        }),
      ).toThrow('OIDC_REDIRECT_URI must be exactly <origin>/api/auth/callback');
    }
    expect(() =>
      validateEnvironment({
        ...base,
        ...oidc,
        OIDC_ISSUER_URL: 'https://user:pw@idp.example/realm',
      }),
    ).toThrow('OIDC_ISSUER_URL must not contain credentials, a query, or a fragment');
  });

  it('allows plain http only to a loopback provider outside production', () => {
    const local = {
      ...base,
      ...oidc,
      ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
      OIDC_ISSUER_URL: 'http://127.0.0.1:9000',
      OIDC_REDIRECT_URI: 'http://127.0.0.1:5173/api/auth/callback',
    };
    expect(validateEnvironment(local).OIDC?.issuerUrl).toBe('http://127.0.0.1:9000');
    expect(() =>
      validateEnvironment({ ...local, OIDC_ISSUER_URL: 'http://idp.example' }),
    ).toThrow('OIDC_ISSUER_URL may use http only for a loopback host');
  });

  it('bounds scopes, login lifetime, post-login path and store size', () => {
    const configured = { ...base, ...oidc, ALLOWED_ORIGINS: 'https://tracker.example' };
    expect(
      validateEnvironment({ ...configured, OIDC_SCOPES: 'openid profile' }).OIDC?.scopes,
    ).toEqual(['openid', 'profile']);
    expect(() => validateEnvironment({ ...configured, OIDC_SCOPES: 'profile' })).toThrow(
      'OIDC_SCOPES must include openid',
    );
    for (const ttl of ['0', '-1', '1.5', 'abc', '3600001']) {
      expect(() => validateEnvironment({ ...configured, OIDC_LOGIN_TTL_MS: ttl })).toThrow(
        'OIDC_LOGIN_TTL_MS',
      );
    }
    for (const path of ['//evil.example', 'https://evil.example/', 'relative', '/a\\b']) {
      expect(() => validateEnvironment({ ...configured, OIDC_POST_LOGIN_PATH: path })).toThrow(
        'OIDC_POST_LOGIN_PATH',
      );
    }
    expect(validateEnvironment({ ...configured, OIDC_POST_LOGIN_PATH: '/runner' }).OIDC?.postLoginPath)
      .toBe('/runner');
    expect(() => validateEnvironment({ ...configured, OIDC_STORE_MAX_ENTRIES: '10001' })).toThrow(
      'OIDC_STORE_MAX_ENTRIES',
    );
  });
});
