import { resolve } from 'node:path';

/**
 * `npm run <script> --workspace=...` starts the command inside the package directory, so a relative path
 * typed by the operator would silently land under apps/api. npm records where the operator actually was in
 * INIT_CWD; resolve against that, and against the process directory when it is not set.
 */
export function resolveOperatorPath(
  environment: Readonly<Record<string, string | undefined>>,
  path: string,
): string {
  return resolve(environment.INIT_CWD || process.cwd(), path);
}
