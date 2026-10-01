import { describe, expect, it } from 'vitest';

import {
  evaluateAccessRecovery,
  type AccessSnapshot,
  type AccessState,
  type ReapplyAccessRun,
} from './restore-drill.js';

const share = (history: boolean, live: boolean) => ({ history, live });

/** What the backup holds: nobody has been restricted yet. */
const backupState: AccessState = {
  memberships: { grantee: true, granteeTwo: true, keeper: true, leaver: true, owner: true },
  readsSurvivor: { grantee: true, granteeTwo: true, keeper: true, leaver: true, owner: true },
  shares: {
    grantee: share(true, false),
    granteeTwo: share(true, true),
    keeper: share(true, false),
    leaver: share(true, false),
    owner: null,
  },
};

/** What the source held just before it was lost: the current permissions. */
const sourceState: AccessState = {
  memberships: { grantee: true, granteeTwo: true, keeper: true, leaver: false, owner: true },
  readsSurvivor: { grantee: false, granteeTwo: false, keeper: true, leaver: false, owner: true },
  shares: {
    grantee: null,
    granteeTwo: share(false, true),
    keeper: share(true, false),
    leaver: share(true, false),
    owner: null,
  },
};

const snapshot = (state: AccessState, outboxRows: number): AccessSnapshot => ({
  outboxRows,
  state: structuredClone(state),
});

const outcomes = (overrides: Partial<ReapplyAccessRun['outcomes']>): ReapplyAccessRun['outcomes'] => ({
  already_applied: 0,
  applied: 0,
  skipped_unknown_organization: 0,
  ...overrides,
});
const firstRun: ReapplyAccessRun = { entries: 5, files: 1, outcomes: outcomes({ already_applied: 2, applied: 3 }) };
const secondRun: ReapplyAccessRun = { entries: 5, files: 1, outcomes: outcomes({ already_applied: 5 }) };

function evaluate(overrides: Partial<Parameters<typeof evaluateAccessRecovery>[0]> = {}) {
  return evaluateAccessRecovery({
    afterDeletions: snapshot(backupState, 2),
    afterFirst: snapshot(sourceState, 5),
    afterSecond: snapshot(sourceState, 5),
    first: firstRun,
    restored: snapshot(backupState, 0),
    second: secondRun,
    source: snapshot(sourceState, 0),
    ...overrides,
  });
}

const verdict = (checks: ReturnType<typeof evaluate>, id: string) =>
  checks.find((check) => check.id === id)?.passed;

describe('access recovery evaluation', () => {
  it('passes when stale access is restricted back to the permissions of the lost source, and nothing more', () => {
    const checks = evaluate();
    expect(checks.filter((check) => !check.passed)).toEqual([]);
    expect(checks.map((check) => check.id)).toEqual([
      'source-access-restricted',
      'stale-access-in-backup',
      'access-first-pass-outcomes',
      'restrictions-applied',
      'recovered-access-matches-source',
      'no-access-added',
      'applied-restrictions-journaled-again',
      'access-second-pass-idempotent',
      'access-second-pass-changes-nothing',
    ]);
  });

  it('fails when the scenario did not restrict the source, because the drill would prove nothing', () => {
    expect(verdict(evaluate({ source: snapshot(backupState, 0) }), 'source-access-restricted')).toBe(false);
  });

  it('fails when the backup does not hold the access that was revoked later', () => {
    const fresh = structuredClone(backupState);
    fresh.shares.grantee = null;
    expect(verdict(evaluate({ restored: snapshot(fresh, 0) }), 'stale-access-in-backup')).toBe(false);
  });

  it('fails when the first pass reports unexpected outcomes or a different number of entries', () => {
    const wrong = { ...firstRun, outcomes: outcomes({ already_applied: 1, applied: 3, skipped_unknown_organization: 1 }) };
    expect(verdict(evaluate({ first: wrong }), 'access-first-pass-outcomes')).toBe(false);
    const short = { ...firstRun, entries: 4, outcomes: outcomes({ already_applied: 1, applied: 3 }) };
    expect(verdict(evaluate({ first: short }), 'access-first-pass-outcomes')).toBe(false);
  });

  it.each([
    ['a revoked share that came back', (state: AccessState) => (state.shares.grantee = share(true, false))],
    ['a narrowed share that kept its history grant', (state: AccessState) => (state.shares.granteeTwo = share(true, true))],
    ['a deactivated member that is active again', (state: AccessState) => (state.memberships.leaver = true)],
    ['a revoked reader that can still read', (state: AccessState) => (state.readsSurvivor.grantee = true)],
  ])('fails when the recovered database still holds %s', (_label, mutate) => {
    const wrong = structuredClone(sourceState);
    mutate(wrong);
    const checks = evaluate({ afterFirst: snapshot(wrong, 5), afterSecond: snapshot(wrong, 5) });
    expect(verdict(checks, 'restrictions-applied')).toBe(false);
    expect(verdict(checks, 'recovered-access-matches-source')).toBe(false);
  });

  it('fails when recovery removed access that the source still had', () => {
    const wrong = structuredClone(sourceState);
    wrong.shares.keeper = null;
    wrong.readsSurvivor.keeper = false;
    const checks = evaluate({ afterFirst: snapshot(wrong, 5), afterSecond: snapshot(wrong, 5) });
    expect(verdict(checks, 'recovered-access-matches-source')).toBe(false);
  });

  it('fails when recovery grants anything the restored backup did not hold', () => {
    const wrong = structuredClone(sourceState);
    wrong.shares.keeper = share(true, true);
    expect(
      verdict(evaluate({ afterFirst: snapshot(wrong, 5), afterSecond: snapshot(wrong, 5) }), 'no-access-added'),
    ).toBe(false);

    // A member who is inactive in the restored backup must not come back active.
    const inactiveInBackup = structuredClone(backupState);
    inactiveInBackup.memberships.leaver = false;
    const reactivated = structuredClone(sourceState);
    reactivated.memberships.leaver = true;
    expect(
      verdict(
        evaluate({
          afterFirst: snapshot(reactivated, 5),
          afterSecond: snapshot(reactivated, 5),
          restored: snapshot(inactiveInBackup, 0),
        }),
        'no-access-added',
      ),
    ).toBe(false);

    const widerRead = structuredClone(backupState);
    widerRead.readsSurvivor.keeper = false;
    expect(verdict(evaluate({ restored: snapshot(widerRead, 0) }), 'no-access-added')).toBe(false);
  });

  it('fails when applied restrictions were not journaled again on the recovered node', () => {
    expect(verdict(evaluate({ afterFirst: snapshot(sourceState, 4), afterSecond: snapshot(sourceState, 4) }), 'applied-restrictions-journaled-again')).toBe(false);
  });

  it('fails when the second pass applies anything or changes any state', () => {
    const repeated = { ...secondRun, outcomes: outcomes({ already_applied: 4, applied: 1 }) };
    expect(verdict(evaluate({ second: repeated }), 'access-second-pass-idempotent')).toBe(false);

    const changed = structuredClone(sourceState);
    changed.memberships.keeper = false;
    expect(verdict(evaluate({ afterSecond: snapshot(changed, 5) }), 'access-second-pass-changes-nothing')).toBe(false);
    expect(verdict(evaluate({ afterSecond: snapshot(sourceState, 6) }), 'access-second-pass-changes-nothing')).toBe(false);
  });

  it('never contains an identifier in a check description', () => {
    for (const check of evaluate()) {
      expect(JSON.stringify(check)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
    }
  });
});
