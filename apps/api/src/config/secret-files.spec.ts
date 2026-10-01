import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadEnvironment } from './environment.js';
import { resolveSecretFiles } from './secret-files.js';

const temporaryDirectories: string[] = [];

function secretFile(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'running-tracker-secret-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'secret');
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('resolveSecretFiles', () => {
  it('loads a named secret from its _FILE variable and drops the file pointer', () => {
    const path = secretFile('postgresql://runtime:pw@db/app');

    const resolved = resolveSecretFiles({ DATABASE_URL_FILE: path, PORT: '3000' }, ['DATABASE_URL']);

    expect(resolved).toEqual({ DATABASE_URL: 'postgresql://runtime:pw@db/app', PORT: '3000' });
  });

  it('removes exactly one trailing line ending and nothing else', () => {
    expect(resolveSecretFiles({ A_FILE: secretFile('value\n') }, ['A']).A).toBe('value');
    expect(resolveSecretFiles({ A_FILE: secretFile('value\r\n') }, ['A']).A).toBe('value');
    expect(resolveSecretFiles({ A_FILE: secretFile('value\n\n') }, ['A']).A).toBe('value\n');
    expect(resolveSecretFiles({ A_FILE: secretFile(' value ') }, ['A']).A).toBe(' value ');
  });

  it('leaves variables without a _FILE companion untouched', () => {
    const source = { DATABASE_URL: 'postgresql://direct', OTHER_FILE: '/never/read' };

    expect(resolveSecretFiles(source, ['DATABASE_URL'])).toEqual(source);
  });

  it('ignores an empty _FILE value as unset', () => {
    expect(resolveSecretFiles({ A: 'direct', A_FILE: '' }, ['A'])).toEqual({ A: 'direct' });
  });

  it('rejects a secret configured both directly and by file', () => {
    expect(() =>
      resolveSecretFiles({ A: 'direct', A_FILE: secretFile('other') }, ['A']),
    ).toThrow('A and A_FILE are mutually exclusive');
  });

  it('rejects unreadable, empty, and relative secret files without echoing content', () => {
    expect(() => resolveSecretFiles({ A_FILE: join(tmpdir(), 'missing-secret-file') }, ['A'])).toThrow(
      'A_FILE could not be read',
    );
    expect(() => resolveSecretFiles({ A_FILE: secretFile('') }, ['A'])).toThrow('A_FILE is empty');
    expect(() => resolveSecretFiles({ A_FILE: secretFile('\n') }, ['A'])).toThrow('A_FILE is empty');
    expect(() => resolveSecretFiles({ A_FILE: 'relative/secret' }, ['A'])).toThrow(
      'A_FILE must be an absolute path',
    );
  });
});

describe('loadEnvironment secret files', () => {
  it('reads the database URLs and the cursor key from files', () => {
    const cursorKey = Buffer.from('deployment-specific-live-track-key-material').toString('base64url');

    const environment = loadEnvironment({
      envFiles: [],
      environment: {
        DATABASE_URL_FILE: secretFile(
          'postgresql://running_tracker_runtime:pw@postgres:5432/running_tracker\n',
        ),
        LIVE_TRACK_CURSOR_SIGNING_KEY_FILE: secretFile(`${cursorKey}\n`),
        MAINTENANCE_DATABASE_URL_FILE: secretFile(
          'postgresql://running_tracker_maintenance:pw@postgres:5432/running_tracker\n',
        ),
      },
    });

    expect(environment.DATABASE_URL).toBe(
      'postgresql://running_tracker_runtime:pw@postgres:5432/running_tracker',
    );
    expect(environment.MAINTENANCE_DATABASE_URL).toBe(
      'postgresql://running_tracker_maintenance:pw@postgres:5432/running_tracker',
    );
    expect(environment.LIVE_TRACK_CURSOR_SIGNING_KEY).toBe(cursorKey);
  });

  it('does not put secret file content in validation errors', () => {
    let message = '';
    try {
      loadEnvironment({
        envFiles: [],
        environment: {
          DATABASE_URL_FILE: secretFile('postgresql://wrong_user:very-secret-password@h/d'),
          MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:pw@h/d',
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('DATABASE_URL must authenticate as running_tracker_runtime');
    expect(message).not.toContain('very-secret-password');
  });
});
