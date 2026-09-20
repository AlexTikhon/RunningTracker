import { createHash } from 'node:crypto';

export function normalizeMigrationSql(sql) {
  return sql.replace(/\r\n?/gu, '\n');
}

export function migrationChecksum(sql) {
  return createHash('sha256').update(normalizeMigrationSql(sql)).digest('hex');
}

export function migrationAction(file, sql, previousChecksum) {
  const checksum = migrationChecksum(sql);

  if (previousChecksum === checksum) {
    return { action: 'skip', checksum };
  }

  if (previousChecksum) {
    throw new Error(`Applied migration ${file} has changed`);
  }

  return { action: 'apply', checksum };
}
