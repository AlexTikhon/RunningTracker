import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createLoadHttpClient, LoadRequestError, type LoadHttpClient } from './load-http.js';

describe('load HTTP client', () => {
  const servers: Server[] = [];
  const clients: LoadHttpClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function start(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<LoadHttpClient> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const client = createLoadHttpClient({ baseUrl: `http://127.0.0.1:${port}`, maxSockets: 8 });
    clients.push(client);
    return client;
  }

  it('returns status, headers, body bytes, and a monotonic start and end', async () => {
    const client = await start((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ echoed: Buffer.concat(chunks).toString('utf8'), method: request.method }));
      });
    });

    const result = await client.request({
      body: '{"a":1}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      path: '/echo',
      timeoutMs: 2_000,
    });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body.toString('utf8'))).toEqual({ echoed: '{"a":1}', method: 'POST' });
    expect(result.bytes).toBe(result.body.byteLength);
    expect(result.endMs).toBeGreaterThanOrEqual(result.startMs);
  });

  it('classifies a request that exceeds its deadline as a timeout', async () => {
    const client = await start(() => {
      /* never answers */
    });
    await expect(client.request({ method: 'GET', path: '/slow', timeoutMs: 50 })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('classifies a refused connection as a transport failure', async () => {
    const client = createLoadHttpClient({ baseUrl: 'http://127.0.0.1:1', maxSockets: 2 });
    clients.push(client);
    const failure = await client.request({ method: 'GET', path: '/', timeoutMs: 2_000 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LoadRequestError);
    expect((failure as LoadRequestError).kind).toBe('transport');
  });

  it('cancels an in-flight request when the caller aborts', async () => {
    const client = await start(() => {
      /* never answers */
    });
    const controller = new AbortController();
    const pending = client.request({ method: 'GET', path: '/x', signal: controller.signal, timeoutMs: 5_000 });
    setTimeout(() => controller.abort(new Error('scenario stopped')), 20);
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('streams an event response incrementally and stops on close', async () => {
    const client = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: one\n\n');
      setTimeout(() => response.write('data: two\n\n'), 20);
    });
    const received: string[] = [];
    let ended = false;
    const stream = await client.openStream({
      onChunk: (chunk) => received.push(chunk.toString('utf8')),
      onEnd: () => {
        ended = true;
      },
      onError: () => undefined,
      path: '/events',
      timeoutMs: 2_000,
    });
    expect(stream.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received.join('')).toBe('data: one\n\ndata: two\n\n');
    stream.close();
    expect(ended).toBe(false);
  });

  it('applies the deadline to the response headers only, not to an open stream', async () => {
    const client = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: one\n\n');
      setTimeout(() => response.write('data: late\n\n'), 250);
    });
    const received: string[] = [];
    const errors: string[] = [];
    const stream = await client.openStream({
      onChunk: (chunk) => received.push(chunk.toString('utf8')),
      onEnd: () => undefined,
      onError: (error) => errors.push(error.kind),
      path: '/events',
      timeoutMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    stream.close();
    expect(errors).toEqual([]);
    expect(received.join('')).toBe('data: one\n\ndata: late\n\n');
  });

  it('times out a stream whose headers never arrive', async () => {
    const client = await start(() => {
      /* never answers */
    });
    await expect(
      client.openStream({
        onChunk: () => undefined,
        onEnd: () => undefined,
        onError: () => undefined,
        path: '/events',
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reports a stream that the server ends', async () => {
    const client = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': hi\n\n');
      setTimeout(() => response.end(), 20);
    });
    const outcome = await new Promise<string>((resolve) => {
      void client.openStream({
        onChunk: () => undefined,
        onEnd: () => resolve('ended'),
        onError: () => resolve('error'),
        path: '/events',
        timeoutMs: 2_000,
      });
    });
    expect(outcome).toBe('ended');
  });
});
