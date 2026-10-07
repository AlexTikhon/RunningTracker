export const REQUEST_TIMEOUT_MS = 15_000;
const authenticationEvents = new EventTarget();

export function onAuthenticationRequired(listener: () => void): () => void {
  authenticationEvents.addEventListener('required', listener);
  return () => authenticationEvents.removeEventListener('required', listener);
}

// The deadline covers both headers and body consumption. Racing the entire
// operation also settles callers whose transport does not honour AbortSignal.
export async function requestJson(url: string, options: RequestInit = {}): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new DOMException('Request deadline exceeded', 'TimeoutError')), REQUEST_TIMEOUT_MS);
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new DOMException('Request cancelled', 'AbortError'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    return await Promise.race([
      (async () => {
        controller.signal.throwIfAborted();
        const response = await fetch(url, { ...options, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (response.status === 401) authenticationEvents.dispatchEvent(new Event('required'));
        let payload: unknown;
        try { payload = await response.json(); } catch (error) {
          controller.signal.throwIfAborted();
          // 204 has no body by definition; any other success must carry JSON.
          if (response.ok && response.status !== 204) throw error;
        }
        controller.signal.throwIfAborted();
        return { response, payload };
      })(),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
  }
}
