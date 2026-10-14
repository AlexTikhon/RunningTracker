/** A provider response was larger than the configured limit. Internal: mapped to the `oversized` reason. */
export class ResponseTooLargeError extends Error {
  public constructor() {
    super('The provider response exceeds the configured size limit');
    this.name = 'ResponseTooLargeError';
  }
}

// The SDKs and `fetch` may wrap a failure that happened while the body was read; look a few levels down the cause
// chain for the size limit.
export function causedByOversizedResponse(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof ResponseTooLargeError) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Wraps a `fetch` so that no response body larger than `maxBytes` is ever buffered: a declared length over the limit
 * is refused before a byte is read, and a body that grows past it (or declares nothing) is cut off mid-stream. The
 * consumer sees the rejection when it reads the body, which is where the SDK parses it.
 */
export function boundedFetch(base: typeof fetch, maxBytes: number): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);

    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new ResponseTooLargeError();
    }
    if (response.body === null) {
      return response;
    }

    let seen = 0;
    const limited = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > maxBytes) {
            controller.error(new ResponseTooLargeError());
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(limited, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}
