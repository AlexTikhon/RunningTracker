import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where the GPS trace tools read and write. Raw traces are private and live under `.local/`, which `.gitignore`
// excludes; sanitized fixtures are committed under the API test tree; the generated report is committed under docs.

function findRepositoryRoot(start: string): string {
  let directory = start;
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (parsed.name === 'running-tracker') {
        return directory;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('Cannot locate the running-tracker repository root');
    }
    directory = parent;
  }
}

export const REPOSITORY_ROOT = findRepositoryRoot(dirname(fileURLToPath(import.meta.url)));
export const RAW_TRACE_DIR = join(REPOSITORY_ROOT, '.local', 'gps-traces', 'raw');
export const FIXTURE_DIR = join(REPOSITORY_ROOT, 'apps', 'api', 'test', 'fixtures', 'gps-traces');
export const REPORT_PATH = join(REPOSITORY_ROOT, 'docs', 'reports', 'd10-real-traces.md');

/**
 * `npm run <script> --workspace` runs in the workspace directory, so a relative path typed by the user would be
 * resolved there. npm records the directory the user ran it from in INIT_CWD; the main modules pass that as `cwd`.
 */
export function resolveUserPath(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export function userWorkingDirectory(env: Record<string, string | undefined>): string {
  return env.INIT_CWD ?? process.cwd();
}
