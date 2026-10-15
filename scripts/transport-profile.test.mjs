import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// Checkouts may materialize text files as CRLF (core.autocrlf on Windows). The assertions below search for
// LF-delimited structure, so every file is normalized to LF at this single read boundary.
const read = (path) => readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n');

test('P08.5 proxy keeps the SSE transport explicit and bounded', () => {
  const nginx = read('infra/proxy/nginx.conf');
  const liveStart = nginx.indexOf('    location ~ ^/api/orgs/');
  const liveEnd = nginx.indexOf('\n    }', liveStart);
  const liveLocation = liveStart >= 0 && liveEnd >= 0 ? nginx.slice(liveStart, liveEnd) : undefined;
  assert.ok(liveLocation, 'live SSE location is missing');
  assert.match(nginx, /listen 443 ssl;/u);
  assert.match(nginx, /http2 on;/u);
  assert.match(liveLocation, /proxy_http_version 1\.1;/u);
  assert.match(liveLocation, /proxy_set_header Connection "";/u);
  assert.match(liveLocation, /proxy_buffering off;/u);
  assert.match(liveLocation, /proxy_cache off;/u);
  assert.match(liveLocation, /proxy_next_upstream off;/u);
  assert.match(liveLocation, /proxy_read_timeout 75s;/u);
  assert.match(liveLocation, /send_timeout 30s;/u);
  assert.match(liveLocation, /gzip off;/u);
  assert.match(liveLocation, /proxy_pass_header X-Accel-Buffering;/u);
});

test('P08.5 Compose publishes only the TLS proxy', () => {
  const compose = read('infra/compose/docker-compose.transport.yml');
  const apiService = compose.split('\n  proxy:')[0];
  assert.match(compose, /127\.0\.0\.1:8443:443/u);
  assert.match(apiService, /api:[\s\S]+?expose:\s+- "3000"/u);
  assert.doesNotMatch(apiService, /ports:/u);
  assert.match(compose, /SESSION_COOKIE_SECURE: "true"/u);
});

test('transport Compose passes the optional public Mapbox token to the web build, empty by default', () => {
  const compose = read('infra/compose/docker-compose.transport.yml');
  const proxy = compose.slice(compose.indexOf('\n  proxy:\n'));
  assert.match(proxy, /target: transport\s+args:\s+(?:#.*\n\s+)*VITE_MAPBOX_ACCESS_TOKEN: \$\{VITE_MAPBOX_ACCESS_TOKEN:-\}/u);
  assert.doesNotMatch(compose.split('\n  proxy:')[0], /MAPBOX/u, 'the API service takes no map token');
});

// F01: the local TLS profile has to log the same way as the production one: method, path and protocol, never
// the raw request line, because the OIDC callback carries a one-time code and state in its query string.
test('F01 transport proxy: the access log format carries no query string and keeps its diagnostics', () => {
  const nginx = read('infra/proxy/nginx.conf');
  const formats = [...nginx.matchAll(/log_format\s+(\w+)\s+((?:'[^']*'\s*)+);/gu)];
  assert.equal(formats.length, 1, 'exactly one log_format is expected');
  const body = formats[0][2].replaceAll(/'\s*'/gu, '');
  assert.doesNotMatch(body, /\$request(?![\w])/u, 'the raw request line is logged');
  assert.doesNotMatch(body, /\$(?:request_uri|args|query_string|is_args|http_referer|request_body)\b/u);
  for (const field of [
    '$request_method',
    '$log_request_path',
    '$server_protocol',
    '$status',
    '$body_bytes_sent',
    '$upstream_addr',
    '$request_time',
  ]) {
    assert.ok(body.includes(field), `${field} is missing from the access log format`);
  }
  assert.ok(
    nginx.includes(`access_log /var/log/nginx/access.log ${formats[0][1]};`),
    'the access log must use the query-free format',
  );
  assert.match(nginx, /map \$request_uri \$log_request_path \{[^}]*\(\?(?:P)?<\w+>\[\^\?\]\*\)/u);
  assert.doesNotMatch(nginx, /access_log\s+(?!\/var\/log\/nginx\/access\.log proxy;)/u);
});
