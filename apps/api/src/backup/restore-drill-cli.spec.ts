import { describe, expect, it } from 'vitest';

import { parseDrillArguments } from './restore-drill-cli.js';

const now = new Date('2026-10-01T10:15:30.000Z');

describe('restore drill arguments', () => {
  it('defaults to a fresh timestamp suffix that is a valid drill suffix, and drops databases on success', () => {
    const parsed = parseDrillArguments([], now);
    expect(parsed).toMatchObject({
      cleanup: false,
      keep: false,
      sourceSchema: 'previous',
      suffix: '20261001t101530',
    });
    expect(parsed.workDirectory).toBeUndefined();
  });

  it('accepts explicit options', () => {
    expect(
      parseDrillArguments(
        ['--suffix', 'abc1', '--keep', '--current-schema', '--work-dir', '/w', '--report-md', '/r.md', '--report-json', '/r.json'],
        now,
      ),
    ).toEqual({
      cleanup: false,
      keep: true,
      reportJson: '/r.json',
      reportMarkdown: '/r.md',
      sourceSchema: 'current',
      suffix: 'abc1',
      workDirectory: '/w',
    });
  });

  it('supports the leftover-cleanup mode on its own', () => {
    expect(parseDrillArguments(['--cleanup'], now)).toMatchObject({ cleanup: true });
    expect(() => parseDrillArguments(['--cleanup', '--keep'], now)).toThrow('Usage');
    expect(() => parseDrillArguments(['--cleanup', '--current-schema'], now)).toThrow('Usage');
    expect(() => parseDrillArguments(['--cleanup', '--suffix', 'x'], now)).toThrow('Usage');
  });

  it('refuses unknown flags, missing values, and invalid suffixes', () => {
    for (const bad of [['--unknown'], ['--suffix'], ['--suffix', 'UPPER'], ['--suffix', 'a b'], ['--work-dir'], ['positional']]) {
      expect(() => parseDrillArguments(bad, now), JSON.stringify(bad)).toThrow(/Usage|suffix/u);
    }
  });
});
