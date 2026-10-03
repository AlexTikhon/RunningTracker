import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { FIXTURE_DIR } from './paths.js';
import { findPrivacyViolations } from './privacy-scan.js';
import { parseSanitizedTraceText, type SanitizedTrace } from './trace-schema.js';

export const FIXTURE_SUFFIX = '.trace.json';

export interface LoadedFixture {
  /** The file name without the suffix. */
  readonly name: string;
  readonly text: string;
  readonly trace: SanitizedTrace;
}

// Fixtures are LF on every platform (see .gitattributes); a checkout that converted them must not change a hash.
const normalizeLineEndings = (text: string): string => text.replace(/\r\n/gu, '\n');

export function loadFixtureFile(path: string): LoadedFixture {
  const file = basename(path);
  if (!file.endsWith(FIXTURE_SUFFIX)) {
    throw new Error(`A fixture file name must end in ${FIXTURE_SUFFIX}`);
  }
  const text = normalizeLineEndings(readFileSync(path, 'utf8'));
  const findings = findPrivacyViolations(text);
  if (findings.length > 0) {
    throw new Error(`Fixture ${file} looks like it contains private data: ${findings.join('; ')}`);
  }
  return { name: file.slice(0, -FIXTURE_SUFFIX.length), text, trace: parseSanitizedTraceText(text) };
}

/**
 * Every fixture in a directory, in name order. The directory may hold nothing else except a README: a raw export,
 * or any other file, that landed next to the fixtures is an error, not something to skip.
 */
export function loadFixtures(directory: string = FIXTURE_DIR): LoadedFixture[] {
  if (!existsSync(directory)) {
    return [];
  }
  const names = readdirSync(directory).sort();
  for (const name of names) {
    if (!name.endsWith(FIXTURE_SUFFIX) && name !== 'README.md') {
      throw new Error(`Unexpected file in the fixture directory: ${name}. Only ${FIXTURE_SUFFIX} fixtures and README.md may be committed here`);
    }
  }
  return names.filter((name) => name.endsWith(FIXTURE_SUFFIX)).map((name) => loadFixtureFile(join(directory, name)));
}
