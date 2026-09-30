import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { assertSafeResult, resultFileName, writeResultFile } from './load-result.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'load-result-'));
  directories.push(directory);
  return directory;
}

describe('assertSafeResult', () => {
  it('accepts plain measurements and identifiers', () => {
    expect(() =>
      assertSafeResult({ http: [{ endMs: 12.5, startMs: 1, status: 200 }], profile: 'smoke', run: 'a1b2' }, [
        'SECRETCOOKIEVALUE0123456789',
      ]),
    ).not.toThrow();
  });

  it('refuses a result that contains a session cookie or CSRF value anywhere, even inside a string', () => {
    const cookie = 'SECRETCOOKIEVALUE0123456789';
    expect(() => assertSafeResult({ note: `header was cookie=${cookie}` }, [cookie])).toThrow(/secret/iu);
    expect(() => assertSafeResult({ deep: { list: [{ value: cookie }] } }, [cookie])).toThrow(/secret/iu);
    expect(() => assertSafeResult({ [cookie]: 1 }, [cookie])).toThrow(/secret/iu);
  });

  it('refuses coordinate-, cookie-, and token-shaped keys at any depth', () => {
    for (const key of ['latitude', 'longitude', 'coordinates', 'cookie', 'csrfToken', 'sessionToken', 'points']) {
      expect(() => assertSafeResult({ nested: [{ [key]: 1 }] }, []), key).toThrow(/forbidden/iu);
    }
  });

  it('ignores secrets too short to be meaningful instead of blocking every result', () => {
    expect(() => assertSafeResult({ status: 200 }, ['', '20'])).not.toThrow();
  });
});

describe('writeResultFile', () => {
  it('writes one JSON document named after the profile and start instant', async () => {
    const directory = await scratch();
    const path = await writeResultFile(directory, { profile: 'smoke', startedAt: '2032-03-01T10:00:00.123Z', value: 1 }, []);
    expect(path.endsWith(resultFileName('smoke', '2032-03-01T10:00:00.123Z'))).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ value: 1 });
  });

  it('writes nothing when the result is unsafe', async () => {
    const directory = await scratch();
    await expect(
      writeResultFile(directory, { profile: 'smoke', startedAt: '2032-03-01T10:00:00.123Z', leak: 'TOPSECRETVALUE99' }, [
        'TOPSECRETVALUE99',
      ]),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it('never overwrites an earlier result', async () => {
    const directory = await scratch();
    const result = { profile: 'smoke', startedAt: '2032-03-01T10:00:00.123Z' };
    await writeResultFile(directory, result, []);
    await expect(writeResultFile(directory, result, [])).rejects.toThrow();
  });
});

describe('resultFileName', () => {
  it('is filesystem-safe and sortable', () => {
    expect(resultFileName('ordinary', '2032-03-01T10:00:00.123Z')).toBe('ordinary-20320301T100000123Z.json');
  });
});
