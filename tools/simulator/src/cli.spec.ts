import { describe, expect, it } from 'vitest';

import { parseCliArguments, runCli } from './cli.js';

describe('GPS simulator CLI', () => {
  it('lists every scenario', () => {
    let output = '';
    runCli(['--list'], (text) => {
      output += text;
    });

    expect(output.trim().split('\n')).toEqual([
      'normal',
      'duplicates',
      'reordered',
      'delayed-batch',
      'dropped-response',
      'clock-jump',
      'gps-spike',
    ]);
  });

  it('prints reproducible JSON Lines for a selected replay', () => {
    const render = () => {
      let output = '';
      runCli(['--scenario', 'reordered', '--seed', '42'], (text) => {
        output += text;
      });
      return output;
    };

    const first = render();
    expect(render()).toBe(first);
    const lines = first.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ name: 'reordered', seed: 42, type: 'scenario' });
    expect(lines.some(({ type }) => type === 'upload-attempt')).toBe(true);
  });

  it('fails closed for unknown arguments, scenarios, and malformed seeds', () => {
    expect(() => parseCliArguments(['--unknown'])).toThrow('unknown argument');
    expect(() => parseCliArguments(['--scenario', 'bad'])).toThrow('unknown scenario');
    expect(() => parseCliArguments(['--seed', '-1'])).toThrow('unsigned integer');
  });
});
