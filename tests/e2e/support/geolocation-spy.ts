import type { BrowserContext } from '@playwright/test';

// Records every use of the browser Geolocation API by any page of the context, across reloads. The calls are
// reported to the test process, so a page that is reloaded or closed cannot lose them. Install it before the
// first navigation: it is an init script.
export async function watchGeolocationUse(context: BrowserContext): Promise<string[]> {
  const calls: string[] = [];
  await context.exposeFunction('__reportGeolocationUse', (method: string) => {
    calls.push(method);
  });
  await context.addInitScript(() => {
    const report = (method: string) => {
      (window as unknown as { __reportGeolocationUse(method: string): void }).__reportGeolocationUse(method);
    };
    const prototype = Geolocation.prototype;
    // Taken off the prototype to wrap it; each wrapper calls the original with the real receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const watchPosition = prototype.watchPosition;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const getCurrentPosition = prototype.getCurrentPosition;
    prototype.watchPosition = function patchedWatchPosition(this: Geolocation, ...args) {
      report('watchPosition');
      return watchPosition.apply(this, args);
    };
    prototype.getCurrentPosition = function patchedGetCurrentPosition(this: Geolocation, ...args) {
      report('getCurrentPosition');
      return getCurrentPosition.apply(this, args);
    };
  });
  return calls;
}
