import { migrationChecksum } from './migration-checksum.mjs';

export function prepareMigrations(files) {
  return files.map(({ file, sql }) => ({
    checksum: migrationChecksum(sql),
    file,
    sql,
  }));
}

export function validateMigrationHistory(migrations, appliedRows) {
  const availableIds = migrations.map(({ file }) => file);
  const appliedIds = appliedRows.map(({ id }) => id);

  if (new Set(availableIds).size !== availableIds.length) {
    throw new Error('Migration directory contains duplicate file names');
  }

  if (new Set(appliedIds).size !== appliedIds.length) {
    throw new Error('Migration history contains duplicate file names');
  }

  const availableById = new Map(migrations.map((migration) => [migration.file, migration]));

  for (const applied of appliedRows) {
    const migration = availableById.get(applied.id);
    if (!migration) {
      throw new Error(`Applied migration ${applied.id} is missing from the repository`);
    }
    if (migration.checksum !== applied.checksum) {
      throw new Error(`Applied migration ${applied.id} has changed`);
    }
  }

  const expectedPrefix = availableIds.slice(0, appliedIds.length);
  for (let index = 0; index < appliedIds.length; index += 1) {
    if (appliedIds[index] !== expectedPrefix[index]) {
      throw new Error(
        `Migration history is out of order: expected ${expectedPrefix[index] ?? '<none>'} at position ${index + 1}, found ${appliedIds[index] ?? '<none>'}`,
      );
    }
  }

  return migrations.slice(appliedRows.length);
}
