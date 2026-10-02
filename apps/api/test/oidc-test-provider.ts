import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import Provider from 'oidc-provider';

export interface TestProviderOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TestProvider {
  close(): Promise<void>;
  issuer: string;
  /**
   * Drives the provider's development login and consent pages like a browser would, following
   * redirects until the provider sends the browser to anything outside its own origin, and
   * returns that URL (the application's callback, with the provider's response parameters).
   */
  signIn(authorizationUrl: URL, accountId: string): Promise<URL>;
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function remember(jar: Map<string, string>, response: Response): void {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    if (pair === undefined || separator < 1) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (value === '') {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

/** A real oidc-provider on a loopback port. Test code only: it uses the library's dev interactions. */
export async function startTestProvider(options: TestProviderOptions): Promise<TestProvider> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${port}`;

  const provider = new Provider(issuer, {
    claims: { openid: ['sub'] },
    clients: [
      {
        client_id: options.clientId,
        client_secret: options.clientSecret,
        grant_types: ['authorization_code'],
        redirect_uris: [options.redirectUri],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
      },
    ],
    cookies: { keys: ['test-only-cookie-key-1', 'test-only-cookie-key-2'] },
    findAccount: (_context, accountId) =>
      Promise.resolve({ accountId, claims: () => Promise.resolve({ sub: accountId }) }),
    pkce: { required: () => true },
  });
  const handle = provider.callback();
  server.on('request', (incoming, outgoing) => {
    void handle(incoming, outgoing);
  });

  const signIn: TestProvider['signIn'] = async (authorizationUrl, accountId) => {
    const jar = new Map<string, string>();
    let url = authorizationUrl;
    let form: URLSearchParams | undefined;

    for (let hop = 0; hop < 20; hop += 1) {
      const response = await fetch(url, {
        ...(form ? { body: form } : {}),
        headers: { cookie: cookieHeader(jar) },
        method: form ? 'POST' : 'GET',
        redirect: 'manual',
      });
      remember(jar, response);
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, url);
        if (next.origin !== issuer) {
          return next;
        }
        url = next;
        form = undefined;
        continue;
      }
      if (response.status !== 200) {
        throw new Error(`The test provider answered ${response.status} at ${url.pathname}`);
      }
      const page = await response.text();
      if (page.includes('name="login"')) {
        form = new URLSearchParams({ login: accountId, password: 'unused', prompt: 'login' });
      } else if (page.includes('value="consent"')) {
        form = new URLSearchParams({ prompt: 'consent' });
      } else {
        throw new Error('The test provider showed an unexpected page');
      }
    }
    throw new Error('The test provider redirected too many times');
  };

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    issuer,
    signIn,
  };
}
