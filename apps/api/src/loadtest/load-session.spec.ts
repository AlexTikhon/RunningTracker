import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { createLoadHttpClient, type LoadHttpClient } from './load-http.js';
import { createLocalSession, extractSessionCookie } from './load-session.js';

const origin = 'http://127.0.0.1:5173';
const userId = '11111111-1111-4111-8111-111111111111';
const secretCookie = 'running_tracker_session=SECRETCOOKIEVALUE0123456789abcdefghijklmnop';
const secretCsrf = 'SECRETCSRFTOKEN0123456789abcdefghijklmnopqr';

describe('extractSessionCookie', () => {
  it('keeps only the name=value pair of the session cookie', () => {
    expect(
      extractSessionCookie([
        'other=1; Path=/',
        'running_tracker_session=abc; HttpOnly; Path=/; SameSite=Strict; Max-Age=60',
      ]),
    ).toBe('running_tracker_session=abc');
  });

  it('refuses a response without exactly one session cookie', () => {
    expect(() => extractSessionCookie([])).toThrow();
    expect(() => extractSessionCookie(['other=1'])).toThrow();
    expect(() => extractSessionCookie(['running_tracker_session=a', 'running_tracker_session=b'])).toThrow();
  });
});

describe('createLocalSession', () => {
  let server: Server | undefined;
  let client: LoadHttpClient | undefined;
  const seen: { cookie?: string; csrf?: string; origin?: string }[] = [];

  afterEach(async () => {
    client?.close();
    await new Promise<void>((resolve) => {
      server?.closeAllConnections();
      server?.close(() => resolve());
      if (!server) {
        resolve();
      }
    });
    seen.length = 0;
  });

  async function start(): Promise<LoadHttpClient> {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (request.method === 'POST' && request.url === '/api/session') {
          seen.push({ origin: request.headers.origin as string });
          response.setHeader('set-cookie', `${secretCookie}; HttpOnly; Path=/`);
          response.statusCode = 201;
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              csrf: { headerName: 'x-csrf-token', token: secretCsrf },
              expiresAt: '2032-01-01T00:00:00.000Z',
              identity: { userId: (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { userId: string }).userId },
            }),
          );
          return;
        }
        seen.push({
          cookie: request.headers.cookie as string,
          csrf: request.headers['x-csrf-token'] as string,
          origin: request.headers.origin as string,
        });
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    client = createLoadHttpClient({ baseUrl: `http://127.0.0.1:${port}`, maxSockets: 4 });
    return client;
  }

  it('logs in through the session API and attaches cookie, origin, and CSRF to mutations only', async () => {
    const http = await start();
    const session = await createLocalSession(http, { origin, timeoutMs: 2_000, userId });

    expect(session.userId).toBe(userId);
    expect(seen[0]?.origin).toBe(origin);

    await http.request({
      headers: session.mutationHeaders(),
      method: 'POST',
      path: '/api/write',
      timeoutMs: 2_000,
    });
    await http.request({ headers: session.readHeaders(), method: 'GET', path: '/api/read', timeoutMs: 2_000 });

    expect(seen[1]).toEqual({ cookie: secretCookie, csrf: secretCsrf, origin });
    expect(seen[2]?.cookie).toBe(secretCookie);
    expect(seen[2]?.csrf).toBeUndefined();
    expect(seen[2]?.origin).toBeUndefined();
  });

  it('never exposes the cookie or CSRF token through serialization, inspection, or string conversion', async () => {
    const session = await createLocalSession(await start(), { origin, timeoutMs: 2_000, userId });
    const renderings = [
      JSON.stringify(session),
      inspect(session, { depth: 5, showHidden: true }),
      String(session),
      JSON.stringify({ nested: [session] }),
    ];
    for (const rendering of renderings) {
      expect(rendering).not.toContain('SECRETCOOKIEVALUE');
      expect(rendering).not.toContain('SECRETCSRFTOKEN');
      expect(rendering).toContain(userId);
    }
    expect(session.secrets().sort()).toEqual([secretCsrf, secretCookie.split('=')[1]].sort());
  });

  it('fails when the server refuses the login', async () => {
    server = createServer((_request, response) => {
      response.statusCode = 403;
      response.end('{}');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    client = createLoadHttpClient({ baseUrl: `http://127.0.0.1:${port}`, maxSockets: 2 });
    await expect(createLocalSession(client, { origin, timeoutMs: 2_000, userId })).rejects.toThrow(/403/u);
  });
});
