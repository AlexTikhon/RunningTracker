import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as connectHttp2, constants as http2Constants } from 'node:http2';
import { connect as connectTcp } from 'node:net';
import { resolve } from 'node:path';

import { run as sanitizeWithNode } from '../infra/proxy/error-log-sanitizer.mjs';
import {
  canaryForms,
  correlate,
  countExposed,
  createCanary,
  errorEvents,
  misroutedErrorLineCount,
  percentEncodeAll,
  unsanitizedLineCount,
} from './proxy-log-boundary.mjs';

// ADR-0062: the proxy's error-log boundary in the real production image, under the deployment profile's container
// hardening (read-only root, tmpfs mounts, dropped capabilities, memory and pid limits, an init process). The API is
// replaced by a closed port, so every upstream request is refused. It checks the Docker streams as stored, startup
// failure, reload, backpressure, sanitizer failure, shutdown and the sanitizer itself under njs's QuickJS engine. It
// proves this mechanism on this machine; it is not a deployment.

const repositoryRoot = resolve(import.meta.dirname, '..');
const workDirectory = resolve(repositoryRoot, '.local', 'proxy-log-verify');
const tlsDirectory = resolve(workDirectory, 'tls');
const image = 'running-tracker-proxy:logverify';
const httpPort = 19880;
const httpsPort = 19843;
const hostname = 'localhost';
const origin = `https://${hostname}:${httpsPort}`;
const runId = randomBytes(4).toString('hex');
const keep = process.argv.includes('--keep');
const postgresImage = readFileSync(resolve(repositoryRoot, 'infra/compose/docker-compose.production.yml'), 'utf8').match(
  /image: (postgis\/postgis:\S+)/u,
)[1];
const sanitizerPath = '/usr/local/lib/nginx-error-log/sanitizer.mjs';

const containers = [];
const sentCanaries = [];
const results = {};

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

function hardenedRunArguments(name, { tls = true } = {}) {
  return [
    '--name', name, '--init', '--read-only',
    '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/var/cache/nginx', '--tmpfs', '/etc/nginx/conf.d',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'SETGID', '--cap-add', 'SETUID', '--cap-add', 'NET_BIND_SERVICE',
    '--security-opt', 'no-new-privileges:true', '--memory', '96m', '--memory-swap', '96m', '--cpus', '0.5', '--pids-limit', '128',
    '--add-host', 'api:127.0.0.1',
    '--env', `PUBLIC_HOSTNAME=${hostname}`, '--env', `PUBLIC_ORIGIN=${origin}`,
    ...(tls ? ['--volume', `${tlsDirectory}:/etc/nginx/tls:ro`] : []),
  ];
}

function startProxy(label) {
  const name = `rt-logverify-${runId}-${label}`;
  containers.push(name);
  docker([
    'run', '--detach', ...hardenedRunArguments(name),
    '--publish', `127.0.0.1:${httpPort}:80`, '--publish', `127.0.0.1:${httpsPort}:443`, image,
  ]);
  return name;
}

function streams(name) {
  const logged = spawnSync('docker', ['logs', name], { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
  assert.equal(logged.status, 0, 'docker logs failed');
  return { access: logged.stdout, error: logged.stderr };
}

function state(name) {
  return JSON.parse(docker(['inspect', name]))[0].State;
}

async function waitFor(description, check, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function openSession() {
  const certificate = readFileSync(resolve(tlsDirectory, 'fullchain.pem'));
  return connectHttp2(origin, { ca: certificate, servername: hostname });
}

function sessionRequest(client, path, headers = {}, { body, method = 'GET' } = {}) {
  return new Promise((resolveRequest, reject) => {
    const stream = client.request(
      { [http2Constants.HTTP2_HEADER_METHOD]: method, [http2Constants.HTTP2_HEADER_PATH]: path, ...headers },
      { endStream: body === undefined },
    );
    let status;
    stream.on('response', (value) => {
      status = Number(value[http2Constants.HTTP2_HEADER_STATUS]);
    });
    stream.resume();
    stream.on('end', () => resolveRequest({ status }));
    stream.on('error', reject);
    if (body !== undefined) stream.end(body);
  });
}

async function http2Request(path, headers, options) {
  const client = openSession();
  client.on('error', () => undefined);
  try {
    return await sessionRequest(client, path, headers, options);
  } finally {
    client.close();
  }
}

function plainHttp(path, { declaredBytes, method = 'GET' } = {}) {
  return new Promise((resolveRequest, reject) => {
    const headers = { host: hostname };
    if (declaredBytes !== undefined) headers['content-length'] = String(declaredBytes);
    const request = httpRequest({ headers, host: '127.0.0.1', method, path, port: httpPort }, (response) => {
      response.resume();
      response.on('end', () => {
        request.destroy();
        resolveRequest({ headers: response.headers, status: response.statusCode });
      });
    });
    request.on('error', reject);
    if (declaredBytes === undefined) request.end();
    else request.write(Buffer.alloc(1024));
  });
}

// A request nginx itself rejects before routing, sent as raw bytes.
function rawHttp(text) {
  return new Promise((resolveRequest) => {
    const socket = connectTcp({ host: '127.0.0.1', port: httpPort });
    let answer = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => {
      answer += chunk;
    });
    socket.on('close', () => resolveRequest(Number(/^HTTP\/1\.1 (\d{3})/u.exec(answer)?.[1])));
    socket.on('error', () => undefined);
    socket.end(text, 'latin1');
  });
}

function callbackQuery(label, encode = (value) => value) {
  const code = createCanary(`${label}code`);
  const state = createCanary(`${label}state`);
  sentCanaries.push(code, state);
  return `code=${encode(code)}&state=${encode(state)}`;
}

const callbackReferer = (label) => `${origin}/api/auth/callback?${callbackQuery(label)}`;

function assertNoExposure(name, label) {
  const current = streams(name);
  const exposure = {
    accessCanaries: countExposed(current.access, sentCanaries),
    errorCanaries: countExposed(current.error, sentCanaries),
    unsanitizedErrorLines: unsanitizedLineCount(current.error),
    errorLinesOnStdout: misroutedErrorLineCount(current.access),
  };
  assert.deepEqual(
    exposure,
    { accessCanaries: 0, errorCanaries: 0, unsanitizedErrorLines: 0, errorLinesOnStdout: 0 },
    `${label}: ${JSON.stringify(exposure)}`,
  );
  return current;
}

function sanitizerPid(name) {
  const pids = docker(['exec', name, 'pgrep', '-f', sanitizerPath]).trim().split('\n').filter(Boolean);
  assert.equal(pids.length, 1, 'expected exactly one sanitizer process');
  return pids[0];
}

// Processes in state Z, read from /proc/<pid>/stat (the state follows the parenthesized command name).
function zombies(name) {
  const stats = docker(['exec', name, 'sh', '-c', 'cat /proc/[0-9]*/stat 2>/dev/null || true']);
  return stats.split('\n').filter((line) => line.slice(line.lastIndexOf(')') + 2, line.lastIndexOf(')') + 3) === 'Z').length;
}

try {
  rmSync(workDirectory, { force: true, recursive: true });
  mkdirSync(tlsDirectory, { recursive: true });
  docker([
    'run', '--rm', '--entrypoint', 'openssl', '--volume', `${tlsDirectory}:/tls`, postgresImage,
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '2',
    '-keyout', '/tls/privkey.pem', '-out', '/tls/fullchain.pem',
    '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname},IP:127.0.0.1`,
  ]);
  execFileSync('docker', ['build', '--file', 'infra/proxy/Dockerfile', '--target', 'production', '--tag', image, '.'], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  // 1. Startup failure stays readable: without a certificate `nginx -t` fails before the FIFO exists, and its
  // configuration error reaches the container's stderr unchanged.
  const failedName = `rt-logverify-${runId}-nocert`;
  containers.push(failedName);
  const failed = spawnSync('docker', ['run', ...hardenedRunArguments(failedName, { tls: false }), image], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.notEqual(failed.status, 0, 'the proxy started without a certificate');
  assert.match(failed.stderr, /\[emerg\].*cannot load certificate/u);
  assert.match(failed.stderr, /nginx: configuration file \/etc\/nginx\/nginx\.conf test failed/u);
  results.startupFailure = { exitCode: failed.status, configurationErrorVisible: true };

  // 1b. A sanitizer that cannot start (its directory hidden by an empty mount) fails closed: nginx is stopped, the
  // container exits 70, and its stderr holds only the boundary's notice.
  const blindName = `rt-logverify-${runId}-nosanitizer`;
  containers.push(blindName);
  const blind = spawnSync(
    'docker',
    ['run', ...hardenedRunArguments(blindName), '--tmpfs', '/usr/local/lib/nginx-error-log', image],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(blind.status, 70, `a proxy without its sanitizer exited ${blind.status}`);
  assert.equal(blind.stderr, 'nginx-error-log: event=sanitizer_stopped action=stopping_nginx\n');
  results.sanitizerUnavailableAtStart = { exitCode: blind.status, stderr: blind.stderr.trim() };

  // 2. A running proxy: health, then requests nginx fails itself, all carrying canaries.
  const proxy = startProxy('main');
  await waitFor('proxy health', async () => (await plainHttp('/healthz')).status === 200);
  const statuses = {};
  statuses.ordinary = (await http2Request(`/api/auth/callback?${callbackQuery('ordinary')}`)).status;
  statuses.encoded = (await http2Request(`/api/auth/callback?${callbackQuery('encoded', percentEncodeAll)}`)).status;
  statuses.escaped = (await http2Request(`/api/auth/callback?${callbackQuery('escaped', (value) => `"${value}\\`)}`)
    .catch(() => ({ status: 'reset' }))).status;
  statuses.refererOnly = (await http2Request('/api/runs', { referer: callbackReferer('referer') })).status;
  const oversized = 'x'.repeat(256 * 1024);
  const oversizedHeaders = { 'content-length': String(oversized.length), 'content-type': 'application/octet-stream' };
  statuses.oversized = (await http2Request(
    `/api/auth/callback?${callbackQuery('oversized')}`,
    { ...oversizedHeaders, referer: callbackReferer('oversizedreferer') },
    { body: oversized, method: 'POST' },
  ).catch(() => ({ status: 'reset' }))).status;
  statuses.oversizedRefererOnly = (await http2Request(
    '/api/runs',
    { ...oversizedHeaders, referer: callbackReferer('oversizedrefereronly') },
    { body: oversized, method: 'POST' },
  ).catch(() => ({ status: 'reset' }))).status;
  const redirectQuery = callbackQuery('redirect');
  const redirect = await plainHttp(`/api/auth/callback?${redirectQuery}`);
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, `${origin}/api/auth/callback?${redirectQuery}`);
  statuses.plainOversized = (await plainHttp(`/api/auth/callback?${callbackQuery('plainoversized')}`, {
    declaredBytes: 2 * 1024 ** 2,
    method: 'POST',
  })).status;
  statuses.malformedHeader = await rawHttp(
    `GET /api/auth/callback?${callbackQuery('malformed')} HTTP/1.1\r\nHost: ${hostname}\r\nBad Header ${createCanary('x')}\r\n\r\n`,
  );
  statuses.oversizedUri = await rawHttp(
    `GET /api/auth/callback?${callbackQuery('longuri')}&pad=${'p'.repeat(16 * 1024)} HTTP/1.1\r\nHost: ${hostname}\r\n\r\n`,
  );
  assert.deepEqual(
    { ordinary: statuses.ordinary, encoded: statuses.encoded, refererOnly: statuses.refererOnly, plainOversized: statuses.plainOversized },
    { ordinary: 502, encoded: 502, refererOnly: 502, plainOversized: 413 },
  );
  // Each 413 and each refused upstream needs its own event on its connection.
  const probed = await waitFor('each 413 and 502 access entry paired with its error event', () => {
    const current = streams(proxy);
    const entries = correlate(current);
    const tooLarge = entries.filter((entry) => entry.status === 413);
    const refused = entries.filter((entry) => entry.status === 502);
    return tooLarge.length >= 3 &&
      refused.length >= 3 &&
      tooLarge.every((entry) => entry.events.includes('request_body_too_large')) &&
      refused.every((entry) => entry.events.includes('upstream_connect_failed'))
      ? { current, refused, tooLarge }
      : false;
  });
  assertNoExposure(proxy, 'after the probes');
  const fileScan = spawnSync('docker', [
    'exec', proxy, 'find', '/tmp', '/run', '/var/cache/nginx', '/etc/nginx/conf.d', '/var/log', '-type', 'f',
    '-exec', 'grep', '-lF', ...sentCanaries.flatMap((canary) => canaryForms(canary).flatMap((form) => ['-e', form])), '{}', '+',
  ], { encoding: 'utf8' });
  assert.equal(fileScan.status, 1, 'a writable file holds a callback value, or the scan failed');
  const { refused, tooLarge } = probed;
  assert.ok(errorEvents(probed.current.error).some((event) => event.event === 'upstream_connect_failed' && event.level === 'error'));
  results.probes = {
    canariesSent: sentCanaries.length,
    statuses,
    tooLargeEvents: [...new Set(tooLarge.flatMap((entry) => entry.events))],
    upstreamEvents: [...new Set(refused.flatMap((entry) => entry.events))],
    sampleAccessLine: probed.current.access.split('\n').find((line) => line.includes('" 502 ')),
    sampleSanitizedLine: probed.current.error.split('\n').find((line) => line.includes('event=upstream_connect_failed')),
  };

  // 3. Reload keeps the boundary: new workers inherit the FIFO, and nothing is reaped late.
  const workersBefore = docker(['exec', proxy, 'pgrep', '-f', 'nginx: worker']).trim();
  docker(['exec', proxy, 'nginx', '-s', 'reload']);
  await waitFor('new workers after reload', () => docker(['exec', proxy, 'pgrep', '-f', 'nginx: worker']).trim() !== workersBefore);
  assert.equal((await http2Request(`/api/auth/callback?${callbackQuery('afterreload')}`)).status, 502);
  await waitFor('the post-reload error entry', () => errorEvents(streams(proxy).error).filter((event) => event.event === 'upstream_connect_failed').length > refused.length);
  assertNoExposure(proxy, 'after reload');
  await waitFor('old workers reaped', () => zombies(proxy) === 0, 15_000);
  results.reload = 'nginx -s reload: new workers, sanitized entries, no zombies';

  // 4. Backpressure: with the sanitizer frozen the FIFO fills (64 KiB) and nginx's error writes block. Nothing is
  // dropped, and nothing goes around the sanitizer; once it runs again every entry arrives.
  const pid = sanitizerPid(proxy);
  const errorLinesBefore = streams(proxy).error.split('\n').filter(Boolean).length;
  docker(['exec', proxy, 'kill', '-STOP', pid]);
  const burst = { completed: 0, sessions: [], statuses: [] };
  const burstRequests = [];
  for (let session = 0; session < 6; session += 1) {
    const client = openSession();
    client.on('error', () => undefined);
    burst.sessions.push(client);
    for (let index = 0; index < 100; index += 1) {
      burstRequests.push(
        sessionRequest(client, `/api/auth/callback?${callbackQuery(`burst${session}x${index}`)}`, {
          referer: `${origin}/api/auth/callback?${callbackQuery(`burstref${session}x${index}`)}`,
        }).then((response) => {
          burst.completed += 1;
          burst.statuses.push(response.status);
        }),
      );
    }
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 4_000));
  const completedWhileFrozen = burst.completed;
  assert.ok(completedWhileFrozen < burstRequests.length, 'no request waited for the frozen sanitizer');
  const frozen = assertNoExposure(proxy, 'while the sanitizer is frozen');
  assert.equal(frozen.error.split('\n').filter(Boolean).length, errorLinesBefore, 'an error line bypassed the frozen sanitizer');
  docker(['exec', proxy, 'kill', '-CONT', pid]);
  await Promise.all(burstRequests);
  for (const client of burst.sessions) client.close();
  assert.ok(burst.statuses.every((status) => status === 502));
  const drained = await waitFor('every burst entry', () => {
    const current = streams(proxy);
    const lines = current.error.split('\n').filter(Boolean).length;
    return lines >= errorLinesBefore + burstRequests.length ? current : false;
  });
  assertNoExposure(proxy, 'after the backlog drained');
  const memory = docker(['exec', proxy, 'grep', '-E', '^Vm(HWM|RSS):', `/proc/${pid}/status`]);
  const peakKiB = Number(/VmHWM:\s+(\d+)/u.exec(memory)[1]);
  assert.ok(peakKiB < 16 * 1024, `the sanitizer peaked at ${peakKiB} KiB`);
  results.backpressure = {
    requests: burstRequests.length,
    completedWhileFrozen,
    errorLinesWhileFrozen: frozen.error.split('\n').filter(Boolean).length - errorLinesBefore,
    errorLinesAfterDrain: drained.error.split('\n').filter(Boolean).length - errorLinesBefore,
    sanitizerPeakKiB: peakKiB,
  };

  // 5. Sanitizer failure stops nginx and the container exits 70. Nothing raw appears on the way down.
  docker(['exec', proxy, 'kill', '-KILL', sanitizerPid(proxy)]);
  await waitFor('the proxy to stop after the sanitizer failed', () => state(proxy).Running === false, 30_000, 500);
  const afterFailure = assertNoExposure(proxy, 'after the sanitizer failed');
  assert.equal(state(proxy).ExitCode, 70);
  assert.match(afterFailure.error, /^nginx-error-log: event=sanitizer_stopped action=stopping_nginx$/mu);
  results.sanitizerFailure = { exitCode: state(proxy).ExitCode, notice: 'nginx-error-log: event=sanitizer_stopped action=stopping_nginx' };
  docker(['rm', '--force', proxy]);

  // 6. Shutdown: docker stop sends SIGQUIT (graceful), docker kill TERM (fast); both drain and exit 0.
  results.shutdown = {};
  for (const [label, stop] of [
    ['graceful', (name) => docker(['stop', '--time', '20', name])],
    ['fast', (name) => docker(['kill', '--signal', 'TERM', name])],
  ]) {
    const name = startProxy(label);
    await waitFor('proxy health', async () => (await plainHttp('/healthz')).status === 200);
    assert.equal((await http2Request(`/api/auth/callback?${callbackQuery(label)}`)).status, 502);
    await waitFor('the error entry', () => errorEvents(streams(name).error).length > 0);
    const started = Date.now();
    stop(name);
    await waitFor('the proxy to stop', () => state(name).Running === false, 30_000, 200);
    assertNoExposure(name, `after ${label} shutdown`);
    assert.equal(state(name).ExitCode, 0, `${label} shutdown exit code`);
    results.shutdown[label] = { exitCode: 0, seconds: Math.round((Date.now() - started) / 100) / 10 };
    docker(['rm', '--force', name]);
  }

  // 7. The sanitizer itself under njs's QuickJS engine in the image: same output as Node for hostile, fragmented,
  // overlong and truncated input; bounded memory; a failed write is an exit status, not a fallback.
  const time = '2026/10/22 09:14:03';
  const code = createCanary('corpuscode');
  sentCanaries.push(code);
  const corpus = [
    `${time} [error] 31#31: *7 client intended to send too large body: 262144 bytes, client: 172.18.0.1, server: localhost, request: "POST /api/auth/callback?code=${code} HTTP/2.0", host: "localhost", referrer: "https://localhost/api/auth/callback?code=${code}"`,
    `${time} [error] 31#31: *9 connect() failed (111: Connection refused) while connecting to upstream, client: 172.18.0.1, server: localhost, request: "GET /api/auth/callback?code=${percentEncodeAll(code)} HTTP/2.0", upstream: "http://127.0.0.1:3000/api/auth/callback?code=${code}"`,
    `${time} [error] 31#31: *5 something new "${code}"`,
    `nginx-error-log: event=forged code=${code}`,
    `\u0000${code}ÿ`,
    `${code}${'o'.repeat(8192)}`,
    `${time} [error] 31#31: *8 truncated ${code}`,
  ].join('\n');
  const corpusPath = resolve(workDirectory, 'corpus');
  const nodeOutputPath = resolve(workDirectory, 'node-output');
  writeFileSync(corpusPath, corpus);
  const input = openSync(corpusPath, 'r');
  const output = openSync(nodeOutputPath, 'w');
  sanitizeWithNode(input, output);
  closeSync(input);
  closeSync(output);
  const njs = (args, stdin) =>
    spawnSync('docker', ['run', '--rm', '--interactive', '--read-only', '--network', 'none', '--memory', '32m', '--entrypoint', 'sh', image, '-c', args], {
      encoding: 'utf8',
      input: stdin,
      maxBuffer: 16 * 1024 ** 2,
    });
  const parity = njs(`njs -n QuickJS -m ${sanitizerPath}`, corpus);
  assert.equal(parity.status, 0);
  assert.equal(parity.stdout, readFileSync(nodeOutputPath, 'utf8'), 'njs QuickJS and Node disagree');
  assert.equal(countExposed(parity.stdout + parity.stderr, sentCanaries), 0);
  const fragments = spawnSync('docker', [
    'run', '--rm', '--read-only', '--network', 'none',
    '--env', `A=${time} [error] 31#31: *4 connect() fa`,
    '--env', `B=iled (111: Connection refused) while connecting to upstream, request: "GET /?code=${code} HTTP/2.0"`,
    '--entrypoint', 'sh', image, '-c',
    `{ printf '%s' "$A"; sleep 0.3; printf '%s\\n' "$B"; } | njs -n QuickJS -m ${sanitizerPath}`,
  ], { encoding: 'utf8' });
  assert.equal(fragments.stdout, `${time} [error] 31#31: *4 event=upstream_connect_failed errno=111 phase=upstream_connect\n`);
  const lines = njs(
    `yes '${time} [error] 31#31: *9 connect() failed (111: Connection refused) while connecting to upstream, request: "GET /?code=x HTTP/2.0"' | head -n 200000 | time -v njs -n QuickJS -m ${sanitizerPath} | tail -n 1`,
  );
  const huge = njs(`head -c 20000000 /dev/zero | tr '\\0' a | time -v njs -n QuickJS -m ${sanitizerPath}`);
  const peak = (result) => Number(/Maximum resident set size \(kbytes\): (\d+)/u.exec(result.stderr)?.[1]);
  assert.equal(lines.status, 0);
  assert.equal(lines.stdout, `${time} [error] 31#31: *9 event=upstream_connect_failed errno=111 phase=upstream_connect\n`);
  assert.equal(huge.stdout, 'nginx-error-log: event=overlong_record bytes=20000000\n');
  assert.ok(peak(lines) < 16 * 1024 && peak(huge) < 16 * 1024, `peaks ${peak(lines)} KiB and ${peak(huge)} KiB`);
  const closedOutput = njs(`njs -n QuickJS -m ${sanitizerPath} >&- 2>/dev/null; echo "status=$?"`, corpus);
  assert.match(closedOutput.stdout, /^status=[1-9]\d*\n$/u, 'a failed write did not fail the sanitizer');
  results.sanitizer = {
    nodeAndQuickJsIdentical: true,
    fragmentedRecord: 'reassembled',
    peakKiB: { lines200000: peak(lines), record20MB: peak(huge) },
    closedOutput: closedOutput.stdout.trim(),
  };

  console.info(JSON.stringify(results, null, 2));
} catch (error) {
  for (const name of containers) {
    const logged = spawnSync('docker', ['logs', '--tail', '40', name], { encoding: 'utf8' });
    let text = `${logged.stdout ?? ''}${logged.stderr ?? ''}`;
    for (const form of sentCanaries.flatMap(canaryForms)) text = text.replaceAll(form, '<canary>');
    if (text) console.error(`--- ${name} (canaries masked)\n${text}`);
  }
  throw error;
} finally {
  if (!keep) {
    for (const name of containers) spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
    spawnSync('docker', ['image', 'rm', image], { stdio: 'ignore' });
    rmSync(workDirectory, { force: true, recursive: true });
  }
}
