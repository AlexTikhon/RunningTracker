import * as openid from 'openid-client';

import type { Clock } from '../clock.js';
import type { OidcConfig } from '../config/oidc-config.js';
import type { PendingLogin } from './oidc-login-store.js';

/** The provider refused or the response failed validation: state, nonce, issuer, audience, signature, expiry. */
export class OidcLoginRejectedError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OidcLoginRejectedError';
  }
}

/** The provider could not be reached or answered like a failing server; the login may be retried. */
export class OidcProviderUnavailableError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OidcProviderUnavailableError';
  }
}

export interface VerifiedProviderIdentity {
  issuer: string;
  subject: string;
}

export interface OidcClient {
  beginLogin(): Promise<{ authorizationUrl: URL; pending: PendingLogin }>;
  completeLogin(callbackUrl: URL, pending: PendingLogin): Promise<VerifiedProviderIdentity>;
}

const providerTimeoutSeconds = 5;
const metadataLifetimeMs = 60 * 60 * 1_000;
const unavailableCodes = new Set([
  'OAUTH_ABORT',
  'OAUTH_RESPONSE_IS_NOT_CONFORM',
  'OAUTH_RESPONSE_IS_NOT_JSON',
  'OAUTH_TIMEOUT',
]);

function isProviderOutage(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true; // fetch failed: DNS, connection refused, reset
  }
  if (error instanceof openid.ResponseBodyError) {
    return error.status >= 500;
  }
  return error instanceof openid.ClientError && error.code !== undefined && unavailableCodes.has(error.code);
}

function classify(error: unknown, description: string): Error {
  if (error instanceof OidcLoginRejectedError || error instanceof OidcProviderUnavailableError) {
    return error;
  }
  return isProviderOutage(error)
    ? new OidcProviderUnavailableError(`${description}: provider unavailable`, { cause: error })
    : new OidcLoginRejectedError(`${description}: rejected`, { cause: error });
}

interface CachedMetadata {
  configuration: openid.Configuration;
  fetchedAt: number;
}

/**
 * Authorization code flow with PKCE (S256), `state` and `nonce`, through openid-client. The
 * provider's metadata is discovered lazily, on the first login, so a provider outage never
 * stops the API from starting; a failed discovery is retried by the next login.
 */
export function createOidcClient(config: OidcConfig, clock: Pick<Clock, 'monotonicNow'>): OidcClient {
  let cached: CachedMetadata | undefined;
  let inFlight: Promise<openid.Configuration> | undefined;

  const discover = (): Promise<openid.Configuration> => {
    if (cached && clock.monotonicNow() - cached.fetchedAt < metadataLifetimeMs) {
      return Promise.resolve(cached.configuration);
    }
    inFlight ??= (async () => {
      try {
        const issuer = new URL(config.issuerUrl);
        const configuration = await openid.discovery(
          issuer,
          config.clientId,
          undefined,
          openid.ClientSecretBasic(config.clientSecret),
          {
            // Configuration validation allows plain http only for a loopback issuer outside production.
            ...(issuer.protocol === 'http:' ? { execute: [openid.allowInsecureRequests] } : {}),
            timeout: providerTimeoutSeconds,
          },
        );
        if (!configuration.serverMetadata().supportsPKCE('S256')) {
          throw new OidcProviderUnavailableError('the provider does not advertise PKCE S256');
        }
        cached = { configuration, fetchedAt: clock.monotonicNow() };
        return configuration;
      } catch (error) {
        throw error instanceof OidcProviderUnavailableError
          ? error
          : new OidcProviderUnavailableError('provider discovery failed', { cause: error });
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return {
    async beginLogin() {
      const configuration = await discover();
      const codeVerifier = openid.randomPKCECodeVerifier();
      const pending: PendingLogin = {
        codeVerifier,
        nonce: openid.randomNonce(),
        state: openid.randomState(),
      };
      const authorizationUrl = openid.buildAuthorizationUrl(configuration, {
        code_challenge: await openid.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        nonce: pending.nonce,
        redirect_uri: config.redirectUri,
        scope: config.scopes.join(' '),
        state: pending.state,
      });
      return { authorizationUrl, pending };
    },

    async completeLogin(callbackUrl, pending) {
      const configuration = await discover();
      try {
        const tokens = await openid.authorizationCodeGrant(configuration, callbackUrl, {
          expectedNonce: pending.nonce,
          expectedState: pending.state,
          idTokenExpected: true,
          pkceCodeVerifier: pending.codeVerifier,
        });
        const claims = tokens.claims();
        if (claims === undefined || typeof claims.sub !== 'string' || claims.sub === '') {
          throw new OidcLoginRejectedError('the ID token carries no subject');
        }
        return { issuer: claims.iss, subject: claims.sub };
      } catch (error) {
        throw classify(error, 'authorization code exchange');
      }
    },
  };
}
