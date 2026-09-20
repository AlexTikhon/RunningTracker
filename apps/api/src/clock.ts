export interface Clock {
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  monotonicNow(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  utcNow(): Date;
}

export const systemClock: Clock = {
  clearTimeout: (handle) => clearTimeout(handle),
  monotonicNow: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  utcNow: () => new Date(),
};
