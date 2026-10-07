import { describe, expect, it } from 'vitest';

import { classifyDatabaseTimeout } from './database-errors.js';

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('classifyDatabaseTimeout', () => {
  it('recognizes a PostgreSQL statement timeout', () => {
    expect(
      classifyDatabaseTimeout(pgError('57014', 'canceling statement due to statement timeout')),
    ).toBe('statement');
  });

  it('recognizes a PostgreSQL lock timeout', () => {
    expect(
      classifyDatabaseTimeout(pgError('55P03', 'canceling statement due to lock timeout')),
    ).toBe('lock');
  });

  it('does not treat a user cancellation, which shares SQLSTATE 57014, as a timeout', () => {
    expect(
      classifyDatabaseTimeout(pgError('57014', 'canceling statement due to user request')),
    ).toBeUndefined();
  });

  it('does not look through a wrapper, whose outcome is unknown rather than a clean timeout', () => {
    const wrapped = new Error('wrapper', {
      cause: pgError('55P03', 'canceling statement due to lock timeout'),
    });

    expect(classifyDatabaseTimeout(wrapped)).toBeUndefined();
  });

  it('ignores unrelated failures and non-error values', () => {
    expect(classifyDatabaseTimeout(pgError('23505', 'duplicate key'))).toBeUndefined();
    expect(classifyDatabaseTimeout(pgError('40P01', 'deadlock detected'))).toBeUndefined();
    expect(classifyDatabaseTimeout(new Error('statement timeout'))).toBeUndefined();
    expect(classifyDatabaseTimeout(undefined)).toBeUndefined();
    expect(classifyDatabaseTimeout('57014')).toBeUndefined();
  });
});
