import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export type SecretSource = Record<string, string | undefined>;

/**
 * Resolves `<NAME>_FILE` pointers (the Docker/Kubernetes secret convention) for the named
 * variables. A file replaces the plain variable; configuring both is ambiguous and rejected.
 * Errors name the variable only, never the file's content.
 */
export function resolveSecretFiles(
  source: SecretSource,
  names: readonly string[],
  readSecret: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): SecretSource {
  const resolved: SecretSource = { ...source };

  for (const name of names) {
    const fileVariable = `${name}_FILE`;
    const path = resolved[fileVariable];
    delete resolved[fileVariable];

    if (path === undefined || path === '') {
      continue;
    }
    if (resolved[name] !== undefined) {
      throw new Error(`${name} and ${fileVariable} are mutually exclusive`);
    }
    if (!isAbsolute(path)) {
      throw new Error(`${fileVariable} must be an absolute path`);
    }

    let content: string;
    try {
      content = readSecret(path);
    } catch {
      throw new Error(`${fileVariable} could not be read`);
    }

    const value = content.replace(/\r?\n$/u, '');
    if (value === '') {
      throw new Error(`${fileVariable} is empty`);
    }
    resolved[name] = value;
  }

  return resolved;
}
