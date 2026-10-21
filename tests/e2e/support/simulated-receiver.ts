import type { BrowserContext, Page } from '@playwright/test';

// SIMULATED RECEIVER BEHAVIOUR, not a device. Replaces the browser Geolocation API of every page of the context
// with a scripted receiver, so a test can play TIMEOUT, POSITION_UNAVAILABLE, PERMISSION_DENIED and fixes to the
// application's own watch callbacks, in order, at the browser API boundary. Everything behind that boundary (the
// app, native IndexedDB, the real API) is real. It says nothing about how a physical receiver or a mobile browser
// behaves, in particular in the background. Install it before the first navigation: it is an init script.
//
// As in the W3C Geolocation "request a position" steps, a temporary failure leaves the watch registered and a
// permission denial removes it; clearWatch removes it too.

export interface ReceiverCalls {
  readonly clearWatch: number;
  readonly getCurrentPosition: number;
  readonly watchPosition: number;
}

declare global {
  interface Window {
    __simulatedReceiver: {
      active(): number;
      calls(): ReceiverCalls;
      // GeolocationPositionError codes: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT.
      fail(code: 1 | 2 | 3): void;
      fix(): void;
      // A late success callback to every watch ever registered, including removed ones: what a stale native
      // callback delivered after clearWatch would look like.
      lateFix(): void;
    };
  }
}

export async function installSimulatedReceiver(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    interface Watch {
      error: PositionErrorCallback | null;
      removed: boolean;
      success: PositionCallback;
    }
    const watches = new Map<number, Watch>();
    const calls = { clearWatch: 0, getCurrentPosition: 0, watchPosition: 0 };
    let nextId = 1;
    let fixes = 0;
    const position = (): GeolocationPosition => {
      fixes += 1;
      const coords = {
        accuracy: 5,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        latitude: 52.2297 + fixes * 0.00002,
        longitude: 21.0122,
        speed: null,
      };
      const timestamp = Date.now();
      return {
        coords: { ...coords, toJSON: () => coords },
        timestamp,
        toJSON: () => ({ coords, timestamp }),
      };
    };
    const live = () => [...watches.values()].filter((watch) => !watch.removed);
    const prototype = Geolocation.prototype;
    prototype.watchPosition = function watchPosition(success: PositionCallback, error?: PositionErrorCallback | null) {
      calls.watchPosition += 1;
      const id = nextId;
      nextId += 1;
      watches.set(id, { error: error ?? null, removed: false, success });
      return id;
    };
    prototype.clearWatch = function clearWatch(id: number) {
      calls.clearWatch += 1;
      const watch = watches.get(id);
      if (watch !== undefined) watch.removed = true;
    };
    prototype.getCurrentPosition = function getCurrentPosition() {
      calls.getCurrentPosition += 1;
    };
    window.__simulatedReceiver = {
      active: () => live().length,
      calls: () => ({ ...calls }),
      fail: (code) => {
        const messages = { 1: 'User denied Geolocation', 2: 'Position unavailable', 3: 'Timeout expired' };
        for (const watch of live()) {
          if (code === 1) watch.removed = true;
          watch.error?.({
            code,
            message: messages[code],
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3,
          });
        }
      },
      fix: () => {
        for (const watch of live()) watch.success(position());
      },
      lateFix: () => {
        for (const watch of watches.values()) watch.success(position());
      },
    };
  });
}

export const receiver = {
  active: (page: Page) => page.evaluate(() => window.__simulatedReceiver.active()),
  calls: (page: Page) => page.evaluate(() => window.__simulatedReceiver.calls()),
  fail: (page: Page, code: 1 | 2 | 3) => page.evaluate((value) => window.__simulatedReceiver.fail(value), code),
  fix: (page: Page) => page.evaluate(() => window.__simulatedReceiver.fix()),
  lateFix: (page: Page) => page.evaluate(() => window.__simulatedReceiver.lateFix()),
};
