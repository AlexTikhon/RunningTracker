import { createServer } from 'node:http';
import process from 'node:process';

import Provider from 'oidc-provider';

// A real oidc-provider (the library's development login and consent pages) started by Playwright's
// webServer. Test code only: a fixed client secret and cookie keys, an account for any login name, no
// persistence. The browser drives its pages like a person would; nothing here knows the application.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const issuer = required('OIDC_E2E_ISSUER');
const port = Number(new URL(issuer).port);

const provider = new Provider(issuer, {
  claims: { openid: ['sub'] },
  clients: [
    {
      client_id: required('OIDC_E2E_CLIENT_ID'),
      client_secret: required('OIDC_E2E_CLIENT_SECRET'),
      grant_types: ['authorization_code'],
      redirect_uris: [required('OIDC_E2E_REDIRECT_URI')],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    },
  ],
  cookies: { keys: ['e2e-only-cookie-key-1', 'e2e-only-cookie-key-2'] },
  findAccount: (_context, accountId) =>
    Promise.resolve({ accountId, claims: () => Promise.resolve({ sub: accountId }) }),
  pkce: { required: () => true },
});

const handle = provider.callback();
const server = createServer((incoming, outgoing) => {
  void handle(incoming, outgoing);
});

// Loopback only. `localhost` resolves to either family, and the clients (Chromium and the API) fall back
// between them, so one IPv4 listener is enough.
server.listen(port, '127.0.0.1');

function shutdown(): void {
  server.close(() => process.exit(0));
  server.closeAllConnections();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
