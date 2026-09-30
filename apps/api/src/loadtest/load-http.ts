import { Agent, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';

export type LoadRequestErrorKind = 'aborted' | 'timeout' | 'transport';

/** A failure below the application: no HTTP answer was obtained (or it was cut short). */
export class LoadRequestError extends Error {
  public constructor(
    public readonly kind: LoadRequestErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LoadRequestError';
  }
}

export interface LoadRequestOptions {
  body?: string;
  headers?: Record<string, string>;
  method: 'DELETE' | 'GET' | 'POST' | 'PUT';
  path: string;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface LoadResponse {
  body: Buffer;
  bytes: number;
  /** `performance.now()` when the request was handed to the socket layer. */
  startMs: number;
  /** `performance.now()` when the last body byte arrived. */
  endMs: number;
  headers: IncomingHttpHeaders;
  status: number;
}

export interface LoadStreamOptions {
  headers?: Record<string, string>;
  onChunk: (chunk: Buffer, receivedAtMs: number) => void;
  onEnd: () => void;
  onError: (error: LoadRequestError) => void;
  path: string;
  signal?: AbortSignal;
  /** Deadline for the response headers only; an open stream has no total deadline. */
  timeoutMs: number;
}

export interface LoadStream {
  close: () => void;
  headers: IncomingHttpHeaders;
  status: number;
}

export interface LoadHttpClient {
  close: () => void;
  openStream: (options: LoadStreamOptions) => Promise<LoadStream>;
  request: (options: LoadRequestOptions) => Promise<LoadResponse>;
}

export interface LoadHttpClientOptions {
  baseUrl: string;
  /** Sized by the caller to cover every concurrent request, so the client never queues silently. */
  maxSockets: number;
}

function classify(error: unknown, timeout: AbortSignal, caller: AbortSignal | undefined): LoadRequestError {
  if (error instanceof LoadRequestError) {
    return error;
  }
  if (timeout.aborted) {
    return new LoadRequestError('timeout', 'The request exceeded its deadline', { cause: error });
  }
  if (caller?.aborted) {
    return new LoadRequestError('aborted', 'The request was cancelled', { cause: error });
  }
  const code = (error as { code?: unknown } | undefined)?.code;
  return new LoadRequestError('transport', `Transport failure${typeof code === 'string' ? ` (${code})` : ''}`, {
    cause: error,
  });
}

export function createLoadHttpClient({ baseUrl, maxSockets }: LoadHttpClientOptions): LoadHttpClient {
  const target = new URL(baseUrl);
  if (target.protocol !== 'http:') {
    throw new Error('The load client speaks plain HTTP to the local load target only');
  }
  const agent = new Agent({ keepAlive: true, maxSockets });

  function send(
    options: {
      body?: string;
      headers?: Record<string, string>;
      method: string;
      path: string;
    },
    signal: AbortSignal,
  ): Promise<{ response: IncomingMessage; startMs: number }> {
    return new Promise((resolve, reject) => {
      const startMs = performance.now();
      const headers: Record<string, string> = { ...options.headers };
      if (options.body !== undefined) {
        headers['content-length'] = String(Buffer.byteLength(options.body));
      }
      const clientRequest = httpRequest(
        {
          agent,
          headers,
          host: target.hostname,
          method: options.method,
          path: options.path,
          port: target.port,
          signal,
        },
        (response) => resolve({ response, startMs }),
      );
      clientRequest.once('error', reject);
      clientRequest.end(options.body);
    });
  }

  return {
    close: () => agent.destroy(),

    async openStream(options) {
      // One controller ends the request whatever the reason; the header deadline is a timer that is
      // cancelled as soon as the headers arrive, so it never applies to the open stream.
      const timeout = new AbortController();
      const lifetime = new AbortController();
      const abortLifetime = (): void => lifetime.abort(new Error('closed'));
      options.signal?.addEventListener('abort', abortLifetime, { once: true });
      const headerTimer = setTimeout(() => {
        timeout.abort();
        lifetime.abort(new Error('header deadline'));
      }, options.timeoutMs);

      let received: { response: IncomingMessage; startMs: number };
      try {
        received = await send(
          { ...(options.headers ? { headers: options.headers } : {}), method: 'GET', path: options.path },
          lifetime.signal,
        );
      } catch (error) {
        options.signal?.removeEventListener('abort', abortLifetime);
        throw classify(error, timeout.signal, options.signal);
      } finally {
        clearTimeout(headerTimer);
      }

      const { response } = received;
      let finished = false;
      const settle = (): boolean => {
        if (finished) {
          return false;
        }
        finished = true;
        options.signal?.removeEventListener('abort', abortLifetime);
        return true;
      };
      response.on('data', (chunk: Buffer) => options.onChunk(chunk, performance.now()));
      response.on('end', () => {
        if (settle()) {
          options.onEnd();
        }
      });
      response.on('error', (error) => {
        if (settle()) {
          options.onError(classify(error, timeout.signal, undefined));
        }
      });
      response.on('close', () => {
        if (!response.complete && settle()) {
          options.onError(new LoadRequestError('transport', 'The stream closed before it ended'));
        }
      });
      return {
        close: () => {
          settle();
          response.destroy();
        },
        headers: response.headers,
        status: response.statusCode ?? 0,
      };
    },

    async request(options) {
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        const { response, startMs } = await send(
          {
            ...(options.body !== undefined ? { body: options.body } : {}),
            ...(options.headers ? { headers: options.headers } : {}),
            method: options.method,
            path: options.path,
          },
          signal,
        );
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('end', resolve);
          response.once('error', reject);
          response.once('close', () => {
            if (!response.complete) {
              reject(new LoadRequestError('transport', 'The response was cut short'));
            }
          });
        });
        const endMs = performance.now();
        const body = Buffer.concat(chunks);
        return {
          body,
          bytes: body.byteLength,
          endMs,
          headers: response.headers,
          startMs,
          status: response.statusCode ?? 0,
        };
      } catch (error) {
        throw classify(error, timeout, options.signal);
      }
    },
  };
}
