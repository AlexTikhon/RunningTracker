import type { BrowserContext, Page } from '@playwright/test';

const liveStream = /\/api\/orgs\/[^/]+\/live$/u;

// Chromium's offline emulation does not end an EventSource that is already open, so the test ends it itself: every
// EventSource the page creates is tracked, and dropping one closes it and reports the same error event a broken
// transport would.
export async function trackLiveStreams(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const Native = window.EventSource;
    const sources: EventSource[] = [];
    class TrackedEventSource extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        sources.push(this);
      }
    }
    window.EventSource = TrackedEventSource;
    (window as unknown as { __dropLiveStreams: () => number }).__dropLiveStreams = () => {
      let dropped = 0;
      for (const source of sources.splice(0)) {
        if (source.readyState !== Native.CLOSED) {
          source.close();
          source.onerror?.(new Event('error'));
          dropped += 1;
        }
      }
      return dropped;
    };
  });
}

// Ends the open stream and refuses every new one until `restoreLiveStream`.
export async function dropLiveStream(page: Page): Promise<number> {
  await page.route(liveStream, (route) => route.abort('internetdisconnected'));
  return page.evaluate(() => (window as unknown as { __dropLiveStreams: () => number }).__dropLiveStreams());
}

export async function restoreLiveStream(page: Page): Promise<void> {
  await page.unroute(liveStream);
}
