export interface Clock {
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
}

export const systemClock: Clock = {
  clearTimeout: (handle) => clearTimeout(handle),
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
};
