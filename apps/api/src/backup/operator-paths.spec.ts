import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveOperatorPath } from './operator-paths.js';

describe('operator path resolution', () => {
  it('resolves a relative path against the directory the operator typed the command in (npm INIT_CWD)', () => {
    const base = resolve('/work/repo');
    expect(resolveOperatorPath({ INIT_CWD: base }, 'docs/reports/x.md')).toBe(resolve(base, 'docs/reports/x.md'));
  });

  it('falls back to the process directory when npm did not set INIT_CWD', () => {
    expect(resolveOperatorPath({}, 'x.md')).toBe(resolve(process.cwd(), 'x.md'));
  });

  it('leaves an absolute path alone', () => {
    const absolute = resolve('/abs/place/file');
    expect(resolveOperatorPath({ INIT_CWD: resolve('/work') }, absolute)).toBe(absolute);
  });
});
