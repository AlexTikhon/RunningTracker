import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MAX_RECORD_BYTES,
  createBoundary,
  run,
  sanitizeRecord,
} from '../infra/proxy/error-log-sanitizer.mjs';
import { SANITIZED_ERROR_LINE, canaryForms, countExposed, createCanary, percentEncodeAll } from './proxy-log-boundary.mjs';

// ADR-0062: the error-log sanitizer. These run it under Node; scripts/verify-proxy-error-log.mjs runs the same file
// under njs's QuickJS engine in the proxy image and compares the two.

const code = createCanary('code');
const state = createCanary('state');
const query = `code=${code}&state=${state}`;
const canaries = [code, state];
const encodedQuery = `code=${percentEncodeAll(code)}&state=${percentEncodeAll(state)}`;
const time = '2026/10/22 09:14:03';
const context = (request, extra = '') =>
  `, client: 172.18.0.1, server: localhost, request: "${request}"${extra}, host: "localhost:19443", referrer: "https://localhost:19443/api/auth/callback?${query}"`;

function sanitizeStream(text, chunkSize = text.length || 1) {
  const lines = [];
  const boundary = createBoundary((line) => lines.push(line));
  const bytes = Buffer.from(text, 'utf8');
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const chunk = Buffer.from(bytes.subarray(start, start + chunkSize));
    boundary.push(chunk, chunk.length);
  }
  boundary.end();
  return lines;
}

const realEntries = [
  [
    `${time} [error] 31#31: *7 client intended to send too large body: 262144 bytes${context(`POST /api/auth/callback?${query} HTTP/2.0`)}`,
    `${time} [error] 31#31: *7 event=request_body_too_large bytes=262144`,
  ],
  [
    `${time} [error] 31#31: *9 connect() failed (111: Connection refused) while connecting to upstream${context(
      `GET /api/auth/callback?${query} HTTP/2.0`,
      `, upstream: "http://127.0.0.1:3000/api/auth/callback?${query}"`,
    )}`,
    `${time} [error] 31#31: *9 event=upstream_connect_failed errno=111 phase=upstream_connect`,
  ],
  [
    `${time} [error] 32#32: *12 upstream timed out (110: Operation timed out) while connecting to upstream${context(
      `GET /api/auth/callback?${encodedQuery} HTTP/2.0`,
      `, upstream: "http://172.18.0.3:3000/api/auth/callback?${encodedQuery}"`,
    )}`,
    `${time} [error] 32#32: *12 event=upstream_timeout errno=110 phase=upstream_connect`,
  ],
  [
    `${time} [error] 32#32: *13 recv() failed (104: Connection reset by peer) while reading response header from upstream${context(
      `GET /api/auth/callback?${query} HTTP/1.1`,
      `, upstream: "http://172.18.0.3:3000/api/auth/callback?${query}"`,
    )}`,
    `${time} [error] 32#32: *13 event=upstream_io_failed errno=104 phase=upstream_header`,
  ],
  [
    `${time} [error] 32#32: *14 upstream prematurely closed connection while reading response header from upstream${context(
      `GET /api/auth/callback?${query} HTTP/2.0`,
    )}`,
    `${time} [error] 32#32: *14 event=upstream_closed_early phase=upstream_header`,
  ],
  [
    `${time} [error] 31#31: *20 limiting requests, excess: 4.940 by zone "oidc_login"${context('GET /api/auth/login/ HTTP/2.0')}`,
    `${time} [error] 31#31: *20 event=request_rate_limited`,
  ],
  [
    `${time} [warn] 31#31: *21 a client request body is buffered to a temporary file /var/cache/nginx/client_temp/0000000001${context(
      `POST /api/auth/callback?${query} HTTP/2.0`,
    )}`,
    `${time} [warn] 31#31: *21 event=request_body_buffered_to_disk`,
  ],
  [
    `${time} [error] 31#31: *22 open() "/usr/share/nginx/html/${code}" failed (2: No such file or directory)${context(`GET /${code}?${query} HTTP/2.0`)}`,
    `${time} [error] 31#31: *22 event=file_open_failed errno=2`,
  ],
  [
    `${time} [info] 31#31: *23 client sent invalid header line: "x-a: ${code}" while reading client request headers${context(`GET /?${query} HTTP/1.1`)}`,
    `${time} [info] 31#31: *23 event=client_bad_request phase=client_headers`,
  ],
  [
    `${time} [crit] 31#31: *24 SSL_do_handshake() failed (SSL: error:0A00006C:SSL routines::bad key share) while SSL handshaking, client: 172.18.0.1, server: 0.0.0.0:443`,
    `${time} [crit] 31#31: *24 event=tls_handshake_failed phase=tls_handshake`,
  ],
  [
    `${time} [emerg] 1#1: cannot load certificate "/etc/nginx/tls/fullchain.pem": BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory) in /etc/nginx/conf.d/site.conf:40`,
    `${time} [emerg] 1#1: event=configuration_error file=conf.d/site.conf line=40`,
  ],
  [`${time} [notice] 1#1: signal 1 (SIGHUP) received from 61, reconfiguring`, `${time} [notice] 1#1: event=signal_received number=1 signal=SIGHUP`],
  [`${time} [alert] 1#1: worker process 33 exited on signal 9`, `${time} [alert] 1#1: event=worker_crashed worker=33 signal=9`],
  [
    'nginx: [emerg] bind() to 0.0.0.0:443 failed (98: Address in use)',
    'nginx: [emerg] event=listen_failed errno=98',
  ],
];

test('ADR-0062 sanitizer: real nginx entries keep their category, time, level, process and connection only', () => {
  for (const [input, expected] of realEntries) {
    assert.equal(sanitizeRecord(input, Buffer.byteLength(input)), expected);
  }
  const output = sanitizeStream(realEntries.map(([input]) => `${input}\n`).join(''));
  assert.deepEqual(output, realEntries.map(([, expected]) => expected));
  assert.equal(countExposed(output.join('\n'), canaries), 0);
  assert.ok(output.every((line) => SANITIZED_ERROR_LINE.test(line)));
});

test('ADR-0062 sanitizer: the 413 and the upstream failure stay distinguishable', () => {
  const [tooLarge, refused] = sanitizeStream(`${realEntries[0][0]}\n${realEntries[1][0]}\n`);
  assert.match(tooLarge, / \*7 event=request_body_too_large /u);
  assert.match(refused, / \*9 event=upstream_connect_failed /u);
});

test('ADR-0062 sanitizer: hostile text is never copied, whatever it imitates', () => {
  const hostile = [
    // A message nginx might add in a later version: the prefix stays, the text goes.
    `${time} [error] 31#31: *5 something new "${code}" happened${context(`GET /?${query} HTTP/2.0`)}`,
    // Text that imitates the sanitizer's own output.
    `${time} [error] 31#31: *5 event=request_body_too_large zone=${code} bytes=${state}`,
    `nginx-error-log: event=overlong_record bytes=${code}`,
    // A known template: the event survives, the quoted name does not.
    `${time} [error] 31#31: *5 limiting requests, excess: 1.0 by zone "${code}"`,
    `${time} [error] 31#31: *5 limiting connections by zone "a b ${code}"`,
    // A configuration location outside the image's own files keeps only its line number.
    `${time} [emerg] 1#1: unknown directive "${code}" in /etc/nginx/${code}.conf:1`,
    // Escaped and encoded copies.
    `${time} [error] 31#31: *6 client intended to send too large body: 9 bytes, request: "POST /cb?code=\\x22${code}\\x5C&state=${percentEncodeAll(state)} HTTP/2.0"`,
    // A sanitized-looking prefix with a bad level, a too-long pid and a missing space.
    `${time} [fatal] 31#31: *5 event=x ${code}`,
    `${time} [error] 12345678901#1: ${code}`,
    `${time} [error] 31#31:*5 ${code}`,
    // Binary, NUL and invalid UTF-8 around the canary.
    `\u0000\u0001${code}ÿþ ${state}`,
  ];
  const output = sanitizeStream(hostile.map((line) => `${line}\n`).join(''));
  assert.equal(output.length, hostile.length);
  assert.equal(countExposed(output.join('\n'), canaries), 0);
  for (const line of output) assert.match(line, SANITIZED_ERROR_LINE);
  assert.equal(output[0], `${time} [error] 31#31: *5 event=unclassified`);
  assert.equal(output[1], `${time} [error] 31#31: *5 event=unclassified`);
  assert.match(output[2], /^nginx-error-log: event=unrecognized_record bytes=\d+$/u);
  assert.equal(output[3], `${time} [error] 31#31: *5 event=request_rate_limited`);
  assert.equal(output[4], `${time} [error] 31#31: *5 event=connection_limited`);
  assert.equal(output[5], `${time} [emerg] 1#1: event=configuration_error line=1`);
  assert.equal(output[6], `${time} [error] 31#31: *6 event=request_body_too_large bytes=9`);
  for (const line of output.slice(7)) assert.match(line, /^nginx-error-log: event=unrecognized_record bytes=\d+$/u);
});

test('ADR-0062 sanitizer: invalid UTF-8 bytes are measured, not decoded into output', () => {
  const lines = [];
  const boundary = createBoundary((line) => lines.push(line));
  const record = Buffer.concat([Buffer.from([0xc3, 0x28, 0xff, 0x00]), Buffer.from(code), Buffer.from('\n')]);
  boundary.push(record, record.length);
  assert.deepEqual(lines, [`nginx-error-log: event=unrecognized_record bytes=${record.length - 1}`]);
});

test('ADR-0062 sanitizer: fragmentation never changes the output', () => {
  const stream = realEntries.slice(0, 4).map(([input]) => `${input}\n`).join('');
  const whole = sanitizeStream(stream);
  for (const size of [1, 2, 3, 7, 64, 255, 4095, 4096, 4097]) {
    assert.deepEqual(sanitizeStream(stream, size), whole, `chunk size ${size}`);
  }
});

test('ADR-0062 sanitizer: an overlong record is dropped as it arrives and reported by size once', () => {
  const prefix = `${time} [error] 31#31: *1 `;
  const exact = `${prefix}${'x'.repeat(MAX_RECORD_BYTES - prefix.length)}`;
  assert.equal(Buffer.byteLength(exact), MAX_RECORD_BYTES);
  assert.deepEqual(sanitizeStream(`${exact}\n`, 1000), [`${time} [error] 31#31: *1 event=unclassified`]);

  const huge = `${code}${'y'.repeat(10 * 1024 ** 2)}${state}`;
  const output = sanitizeStream(`${huge}\n${realEntries[0][0]}\n`, 4096);
  assert.deepEqual(output, [`nginx-error-log: event=overlong_record bytes=${Buffer.byteLength(huge)}`, realEntries[0][1]]);
});

test('ADR-0062 sanitizer: a record cut off by the end of input is reported by size only', () => {
  const output = sanitizeStream(`${realEntries[0][0]}\n${time} [error] 31#31: *8 client intended to send ${code}`);
  assert.equal(output[0], realEntries[0][1]);
  assert.match(output[1], /^nginx-error-log: event=truncated_record bytes=\d+$/u);
  assert.equal(countExposed(output.join('\n'), canaries), 0);
  assert.deepEqual(sanitizeStream(`${'z'.repeat(MAX_RECORD_BYTES + 1)}`, 100), [
    `nginx-error-log: event=overlong_record bytes=${MAX_RECORD_BYTES + 1}`,
  ]);
});

test('ADR-0062 sanitizer: a parser failure emits a fixed line, never the record', () => {
  const lines = [];
  const boundary = createBoundary(
    (line) => lines.push(line),
    (text) => {
      throw new Error(`cannot parse ${text}`);
    },
  );
  const record = Buffer.from(`${realEntries[1][0]}\n`);
  boundary.push(record, record.length);
  assert.deepEqual(lines, [`nginx-error-log: event=sanitizer_rejected_record bytes=${record.length - 1}`]);
});

test('ADR-0062 sanitizer: CRLF input and empty lines', () => {
  assert.deepEqual(sanitizeStream(`${realEntries[10][0]}\r\n\n\n${realEntries[11][0]}\r\n`), [realEntries[10][1], realEntries[11][1]]);
});

test('ADR-0062 sanitizer: run() reads to end of input and a failed write throws instead of falling back', () => {
  const directory = mkdtempSync(join(tmpdir(), 'error-log-'));
  try {
    const inputPath = join(directory, 'in');
    const outputPath = join(directory, 'out');
    writeFileSync(inputPath, realEntries.map(([input]) => `${input}\n`).join('').repeat(50));
    const input = openSync(inputPath, 'r');
    const output = openSync(outputPath, 'w');
    run(input, output);
    closeSync(input);
    closeSync(output);
    const written = readFileSync(outputPath, 'utf8');
    assert.equal(written, realEntries.map(([, expected]) => `${expected}\n`).join('').repeat(50));
    assert.equal(countExposed(written, canaries), 0);

    const again = openSync(inputPath, 'r');
    const readOnly = openSync(outputPath, 'r');
    assert.throws(() => run(again, readOnly));
    closeSync(again);
    closeSync(readOnly);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('ADR-0062 canary forms cover raw and percent-encoded values in either case', () => {
  const forms = canaryForms('ab');
  assert.deepEqual(forms, ['ab', '%61%62', '%61%62'.toUpperCase()]);
  assert.equal(countExposed(`x ${percentEncodeAll(code).toUpperCase()} y`, canaries), 1);
});
