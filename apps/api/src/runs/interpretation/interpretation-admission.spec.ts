import { describe, expect, it } from 'vitest';

import type { Clock } from '../../clock.js';
import {
  AdmissionRejectedError,
  InterpretationAdmission,
  type AdmissionOptions,
} from './interpretation-admission.js';

class ManualClock implements Clock {
  public now = 1_000;

  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public monotonicNow(): number {
    return this.now;
  }

  public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  public utcNow(): Date {
    return new Date(this.now);
  }
}

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const carol = '33333333-3333-4333-8333-333333333333';

function create(overrides: Partial<AdmissionOptions> = {}) {
  const clock = new ManualClock();
  const admission = new InterpretationAdmission({
    allowance: { perWindow: 100, windowMs: 86_400_000 },
    clock,
    maxConcurrent: 4,
    maxUsers: 1_000,
    userRate: { perWindow: 5, windowMs: 60_000 },
    ...overrides,
  });
  return { admission, clock };
}

function rejection(action: () => unknown): AdmissionRejectedError {
  try {
    action();
  } catch (error) {
    if (error instanceof AdmissionRejectedError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the request to be rejected');
}

describe('interpretation admission', () => {
  it('admits one request per person at a time and frees the place on release', () => {
    const { admission } = create();
    const first = admission.admit(alice);
    expect(rejection(() => admission.admit(alice)).reason).toBe('in_progress');
    expect(() => admission.admit(bob)).not.toThrow();
    first.release();
    expect(() => admission.admit(alice)).not.toThrow();
  });

  it('releases idempotently, so a late second release cannot free another request\'s place', () => {
    const { admission } = create({ maxConcurrent: 1 });
    const first = admission.admit(alice);
    first.release();
    const second = admission.admit(bob);
    first.release();
    expect(rejection(() => admission.admit(carol)).reason).toBe('busy');
    second.release();
    expect(() => admission.admit(carol)).not.toThrow();
  });

  it('limits one person to the configured rate across the window and tells when to return', () => {
    const { admission, clock } = create({ userRate: { perWindow: 2, windowMs: 60_000 } });
    admission.admit(alice).release();
    clock.now += 10_000;
    admission.admit(alice).release();
    clock.now += 10_000;
    const refused = rejection(() => admission.admit(alice));
    expect(refused.reason).toBe('rate_limited');
    expect(refused.retryAfterMs).toBe(40_000);
    clock.now += 40_000;
    expect(() => admission.admit(alice)).not.toThrow();
  });

  it('counts a person once however many sessions or organizations they use', () => {
    // The key is the user identity only: the caller never passes a session or organization.
    const { admission } = create({ userRate: { perWindow: 1, windowMs: 60_000 } });
    admission.admit(alice).release();
    expect(rejection(() => admission.admit(alice)).reason).toBe('rate_limited');
  });

  it('does not let one person\'s rejections use up another person\'s rate', () => {
    const { admission } = create({ userRate: { perWindow: 1, windowMs: 60_000 } });
    admission.admit(alice).release();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      rejection(() => admission.admit(alice));
    }
    expect(() => admission.admit(bob)).not.toThrow();
  });

  it('caps concurrent provider calls across people', () => {
    const { admission } = create({ maxConcurrent: 2 });
    const first = admission.admit(alice);
    admission.admit(bob);
    const refused = rejection(() => admission.admit(carol));
    expect(refused.reason).toBe('busy');
    first.release();
    expect(() => admission.admit(carol)).not.toThrow();
  });

  it('spends a global allowance per window, rolling, and failures still count', () => {
    const { admission, clock } = create({
      allowance: { perWindow: 3, windowMs: 3_600_000 },
      userRate: { perWindow: 60, windowMs: 60_000 },
    });
    for (let index = 0; index < 3; index += 1) {
      admission.admit(alice).release();
      clock.now += 1_000;
    }
    const refused = rejection(() => admission.admit(bob));
    expect(refused.reason).toBe('budget_exhausted');
    // The oldest dispatch happened 3000 ms ago, so it leaves the window in 3 597 000 ms.
    expect(refused.retryAfterMs).toBe(3_597_000);
    clock.now += 3_597_000;
    expect(() => admission.admit(bob)).not.toThrow();
  });

  it('does not charge a request that was refused', () => {
    const { admission } = create({
      allowance: { perWindow: 2, windowMs: 3_600_000 },
      maxConcurrent: 1,
    });
    const held = admission.admit(alice);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      rejection(() => admission.admit(bob));
    }
    held.release();
    expect(() => admission.admit(bob)).not.toThrow();
  });

  it('refunds a place that was admitted but never dispatched', () => {
    const { admission } = create({
      allowance: { perWindow: 1, windowMs: 3_600_000 },
      userRate: { perWindow: 1, windowMs: 60_000 },
    });
    const ticket = admission.admit(alice);
    ticket.release({ dispatched: false });
    expect(() => admission.admit(alice)).not.toThrow();
  });

  it('does not refund a dispatched request, whatever became of it', () => {
    const { admission } = create({ allowance: { perWindow: 1, windowMs: 3_600_000 } });
    admission.admit(alice).release({ dispatched: true });
    expect(rejection(() => admission.admit(bob)).reason).toBe('budget_exhausted');
  });

  it('reserves atomically: simultaneous admissions can never exceed the allowance', () => {
    const { admission } = create({
      allowance: { perWindow: 10, windowMs: 3_600_000 },
      maxConcurrent: 32,
      userRate: { perWindow: 60, windowMs: 60_000 },
    });
    const tickets: unknown[] = [];
    let refusals = 0;
    for (let index = 0; index < 40; index += 1) {
      const user = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      try {
        tickets.push(admission.admit(user));
      } catch (error) {
        expect(error).toBeInstanceOf(AdmissionRejectedError);
        refusals += 1;
      }
    }
    expect(tickets).toHaveLength(10);
    expect(refusals).toBe(30);
  });

  it('bounds its storage and expires entries', () => {
    const { admission, clock } = create({ maxUsers: 3, userRate: { perWindow: 5, windowMs: 60_000 } });
    for (const user of [alice, bob, carol]) {
      admission.admit(user).release();
    }
    expect(admission.trackedUsers()).toBe(3);
    const stranger = '44444444-4444-4444-8444-444444444444';
    expect(rejection(() => admission.admit(stranger)).reason).toBe('busy');
    expect(admission.trackedUsers()).toBe(3);

    clock.now += 60_000;
    expect(() => admission.admit(stranger)).not.toThrow();
    expect(admission.trackedUsers()).toBe(1);
  });

  it('does not forget a person who is still limited when the table is full', () => {
    const { admission } = create({ maxUsers: 1, userRate: { perWindow: 1, windowMs: 60_000 } });
    admission.admit(alice).release();
    expect(rejection(() => admission.admit(alice)).reason).toBe('rate_limited');
    expect(rejection(() => admission.admit(bob)).reason).toBe('busy');
  });

  it('keeps no more allowance entries than the allowance', () => {
    const { admission, clock } = create({
      allowance: { perWindow: 3, windowMs: 1_000_000 },
      userRate: { perWindow: 60, windowMs: 60_000 },
    });
    for (let index = 0; index < 3; index += 1) {
      admission.admit(alice).release();
      clock.now += 1;
    }
    for (let index = 0; index < 20; index += 1) {
      expect(() => admission.admit(alice)).toThrow(AdmissionRejectedError);
    }
    expect(admission.allowanceInUse()).toBe(3);
  });

  it('rejects a configuration that cannot work', () => {
    expect(() => create({ maxConcurrent: 0 })).toThrow(RangeError);
    expect(() => create({ userRate: { perWindow: 0, windowMs: 60_000 } })).toThrow(RangeError);
    expect(() => create({ allowance: { perWindow: 1, windowMs: 0 } })).toThrow(RangeError);
    expect(() => create({ maxUsers: 0 })).toThrow(RangeError);
  });
});
