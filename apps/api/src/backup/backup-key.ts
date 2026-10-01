import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

/** AES-256 needs exactly 32 key bytes. */
export const backupKeyBytes = 32;

const keyVariable = 'BACKUP_ENCRYPTION_KEY_FILE';
const hexKeyPattern = new RegExp(`^[0-9a-fA-F]{${backupKeyBytes * 2}}$`, 'u');

/**
 * Reads the backup encryption key from a file named by BACKUP_ENCRYPTION_KEY_FILE: 64 hexadecimal
 * characters (32 bytes), optionally followed by exactly one newline. Every message names the variable
 * or the problem only; nothing read from the file is ever echoed.
 */
export async function loadBackupKey(path: string | undefined): Promise<Buffer> {
  if (!path) {
    throw new Error(`${keyVariable} is required`);
  }
  if (!isAbsolute(path)) {
    throw new Error(`${keyVariable} must be an absolute path`);
  }
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    throw new Error('The backup encryption key file cannot be read');
  }
  const text = contents.endsWith('\r\n')
    ? contents.slice(0, -2)
    : contents.endsWith('\n')
      ? contents.slice(0, -1)
      : contents;
  if (!hexKeyPattern.test(text)) {
    throw new Error(
      `The backup encryption key file must hold exactly ${backupKeyBytes * 2} hexadecimal characters (${backupKeyBytes} bytes) and at most one trailing newline`,
    );
  }
  return Buffer.from(text, 'hex');
}

/**
 * Creates a new random key file that only the current user can read. It refuses to overwrite an
 * existing file and returns the path, never the key. Where the file is stored is the operator's
 * decision: it must not live next to the backups it protects.
 */
export async function generateBackupKeyFile(path: string): Promise<{ path: string }> {
  if (!isAbsolute(path)) {
    throw new Error('The backup key output path must be absolute');
  }
  let handle;
  try {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('The backup key file already exists and is never overwritten', { cause: error });
    }
    throw new Error('The backup key file cannot be created', { cause: error });
  }
  try {
    await handle.writeFile(`${randomBytes(backupKeyBytes).toString('hex')}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path };
}
