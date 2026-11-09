import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

// Structural guards for .github/workflows/ci.yml. They run without GitHub or Docker; only a hosted run proves the
// workflow itself.

const root = resolve(import.meta.dirname, '..');
// Normalized to LF at this single read boundary (core.autocrlf checkouts on Windows).
const read = (path) => readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n');
const workflow = read('.github/workflows/ci.yml');
const compose = read('infra/compose/docker-compose.yml');

function jobBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} is missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z][\w-]*:\n/u);
  return next < 0 ? rest : rest.slice(0, next + 3);
}

const databaseJobs = ['integration', 'e2e', 'e2e-firefox'];

test('CI: the workflow refers to no secret and grants only read access to the repository', () => {
  assert.doesNotMatch(workflow, /secrets\./u);
  assert.match(workflow, /\npermissions:\n {2}contents: read\n/u);
});

test('CI: verify is the gate, and the database and browser jobs wait for it', () => {
  const verify = jobBlock('verify');
  assert.doesNotMatch(verify, /\n {4}needs:/u);
  assert.match(verify, /- run: npm ci\n/u);
  assert.match(verify, /- run: npm run verify\n/u);
  for (const job of databaseJobs) {
    assert.match(jobBlock(job), /\n {4}needs: verify\n/u, `${job} must start after verify`);
  }
  assert.match(jobBlock('e2e-report'), /\n {4}needs: e2e\n/u);
});

test('CI: every PostGIS service is the docker-compose image, database and superuser', () => {
  const composeImage = compose.match(/\n {4}image: (postgis\/postgis:\S+@sha256:[0-9a-f]{64})\n/u)?.[1];
  assert.ok(composeImage, 'the compose postgres image must be pinned by digest');
  for (const job of databaseJobs) {
    const block = jobBlock(job);
    assert.equal(block.match(/\n {8}image: (\S+)\n/u)?.[1], composeImage, `${job} must use the compose image`);
    assert.match(block, /\n {10}POSTGRES_DB: running_tracker\n/u, `${job} must create running_tracker as compose does`);
    assert.match(block, /\n {10}POSTGRES_USER: running_tracker\n/u);
    // TCP, not the socket: the image's temporary initdb server listens on the socket only.
    assert.match(block, /--health-cmd "pg_isready -h 127\.0\.0\.1 -U running_tracker -d running_tracker"/u, `${job} health check`);
  }
  assert.match(compose, /\n {6}POSTGRES_DB: running_tracker\n/u);
});

test('CI: each database job creates the test database with the compose init script before migrating', () => {
  const initScript = 'db/test-support/20-create-test-database.sql';
  assert.ok(compose.includes(`../../${initScript}:/docker-entrypoint-initdb.d/`), 'compose must mount the init script');
  for (const job of databaseJobs) {
    const block = jobBlock(job);
    const init = block.indexOf(`< ${initScript}`);
    const bootstrap = block.indexOf('- run: npm run db:bootstrap:test');
    const migrate = block.indexOf('- run: npm run db:migrate:test');
    assert.ok(init >= 0 && init < bootstrap && bootstrap < migrate, `${job}: init script, then bootstrap, then migrate`);
  }
});

test('CI: integration checks the extension set and runs the restore drill instead of skipping it', () => {
  const block = jobBlock('integration');
  assert.match(block, /test "\$\{extensions\}" = plpgsql,postgis\n/u);
  assert.match(block, /test "\$\{major\}" = 17\n/u);
  assert.match(compose, /image: postgis\/postgis:17-/u, 'the expected major must follow the compose image');
  for (const name of ['RESTORE_DRILL_ADMIN_URL', 'RESTORE_DRILL_OWNER_URL', 'RESTORE_DRILL_RUNTIME_URL', 'RESTORE_DRILL_MAINTENANCE_URL']) {
    assert.match(block, new RegExp(`\\n {6}${name}: postgresql://\\S+@127\\.0\\.0\\.1:5432/`, 'u'), name);
  }
  assert.match(block, /BACKUP_PG_DOCKER_CONTAINER: \$\{\{ job\.services\.postgres\.id \}\}/u);
  // backup:keygen imports the built contracts package; on a fresh runner nothing else has built it yet.
  const build = block.indexOf('- run: npm run build --workspace=@running-tracker/contracts');
  const keygen = block.indexOf('npm run backup:keygen');
  const integration = block.indexOf('npm run test:integration\n');
  assert.ok(build >= 0 && build < keygen && keygen < integration, 'build contracts, then keygen, then test:integration');
});

test('CI: the Chromium suite runs sharded, and a failure uploads one merged HTML report', () => {
  const e2e = jobBlock('e2e');
  assert.match(e2e, /--shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/u);
  assert.match(e2e, /\n {6}fail-fast: false\n/u);
  assert.match(e2e, /- run: npm run e2e -- /u);
  assert.match(e2e, /path: tests\/e2e\/blob-report\n/u);
  const report = jobBlock('e2e-report');
  assert.match(report, /if: \$\{\{ !cancelled\(\) && needs\.e2e\.result == 'failure' \}\}/u);
  assert.match(report, /merge-reports --reporter html/u);
  assert.match(report, /path: tests\/e2e\/playwright-report\n/u);
});

test('CI: the README shows this workflow\'s status badge', () => {
  assert.match(read('README.md'), /\n\[!\[CI\]\(https:\/\/github\.com\/AlexTikhon\/SomaLane\/actions\/workflows\/ci\.yml\/badge\.svg\?branch=main\)\]/u);
});
