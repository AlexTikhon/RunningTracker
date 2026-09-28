import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('P08.5 proxy keeps the SSE transport explicit and bounded', () => {
  const nginx = readFileSync(resolve(root, 'infra/proxy/nginx.conf'), 'utf8');
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
  const compose = readFileSync(
    resolve(root, 'infra/compose/docker-compose.transport.yml'),
    'utf8',
  );
  const apiService = compose.split('\n  proxy:')[0];
  assert.match(compose, /127\.0\.0\.1:8443:443/u);
  assert.match(apiService, /api:[\s\S]+?expose:\s+- "3000"/u);
  assert.doesNotMatch(apiService, /ports:/u);
  assert.match(compose, /SESSION_COOKIE_SECURE: "true"/u);
});
