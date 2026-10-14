import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

// Structural guards for the P12.2 deployment profile. They run without Docker; the behavioural
// proof is `npm run deploy:verify`.

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const compose = read('infra/compose/docker-compose.production.yml');
const site = read('infra/proxy/production-site.conf.template');

function serviceBlock(name) {
  const start = compose.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `service ${name} is missing`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/u);
  return next < 0 ? rest : rest.slice(0, next + 3);
}

test('P12.2 profile: only the proxy publishes host ports', () => {
  for (const service of ['postgres', 'db-init', 'api']) {
    assert.doesNotMatch(serviceBlock(service), /\n {4}ports:/u, `${service} must not publish ports`);
  }
  assert.match(serviceBlock('proxy'), /\n {4}ports:/u);
});

test('P12.2 profile: every service is resource-bounded and unprivileged', () => {
  for (const service of ['postgres', 'db-init', 'api', 'proxy']) {
    const block = serviceBlock(service);
    for (const setting of ['mem_limit:', 'cpus:', 'pids_limit:', 'cap_drop: [ALL]', 'no-new-privileges:true', 'logging:']) {
      assert.ok(block.includes(setting), `${service} is missing ${setting}`);
    }
  }
  for (const service of ['db-init', 'api', 'proxy']) {
    assert.match(serviceBlock(service), /read_only: true/u, `${service} rootfs must be read-only`);
  }
});

test('P12.2 profile: the API is production-mode, has no dev login, and takes secrets from files', () => {
  const api = serviceBlock('api');
  assert.match(api, /APP_ENV: production/u);
  assert.match(api, /LOCAL_AUTH_ENABLED: "false"/u);
  assert.match(api, /SESSION_COOKIE_SECURE: "true"/u);
  for (const variable of ['DATABASE_URL', 'MAINTENANCE_DATABASE_URL', 'LIVE_TRACK_CURSOR_SIGNING_KEY']) {
    assert.match(api, new RegExp(`${variable}_FILE: /run/secrets/`, 'u'));
    assert.doesNotMatch(api, new RegExp(`\\n {6}${variable}:`, 'u'), `${variable} must not be inline`);
  }
  assert.match(api, /depends_on:\s+db-init:\s+condition: service_completed_successfully/u);
});

test('P12.1 profile: the API signs people in through OIDC with a file-based client secret', () => {
  const api = serviceBlock('api');
  assert.match(api, /OIDC_CLIENT_SECRET_FILE: \/run\/secrets\/oidc_client_secret/u);
  assert.doesNotMatch(api, /\n {6}OIDC_CLIENT_SECRET:/u, 'the client secret must not be inline');
  assert.match(api, /OIDC_ISSUER_URL: \$\{OIDC_ISSUER_URL:\?/u, 'the issuer must be required');
  assert.match(api, /OIDC_CLIENT_ID: \$\{OIDC_CLIENT_ID:\?/u, 'the client id must be required');
  assert.match(
    api,
    /OIDC_REDIRECT_URI: \$\{PUBLIC_ORIGIN:\?[^}]*\}\/api\/auth\/callback/u,
    'the redirect URI must be the public origin plus the callback route',
  );
  assert.match(api, /secrets: \[[^\]]*oidc_client_secret[^\]]*\]/u);
  assert.match(compose, /\n {2}oidc_client_secret:\n {4}file: \$\{SECRETS_DIR:\?[^}]*\}\/oidc-client-secret/u);
});

test('P12.1 profile: the example inputs name the provider settings and no secret', () => {
  const example = read('infra/compose/production.env.example');
  assert.match(example, /^OIDC_ISSUER_URL=https:\/\//mu);
  assert.match(example, /^OIDC_CLIENT_ID=\S+/mu);
  assert.doesNotMatch(example, /^OIDC_CLIENT_SECRET=/mu);
});

test('P12.2 profile: no credential value is written in the compose file', () => {
  assert.doesNotMatch(compose, /local_only|running_tracker_local|POSTGRES_PASSWORD:\s*\S/u);
  assert.doesNotMatch(compose, /postgres(?:ql)?:\/\/\w+:\w+@/u);
});

test('P12.2 profile: PostgreSQL sits on an internal-only network', () => {
  assert.match(compose, /\n {2}data:\n {4}internal: true/u);
  assert.match(serviceBlock('postgres'), /networks: \[data\]/u);
  assert.match(serviceBlock('proxy'), /networks: \[edge\]/u);
});

test('P12.2 proxy: HTTP redirects to the configured origin, never to the request Host', () => {
  assert.match(site, /return 301 \$\{PUBLIC_ORIGIN\}\$request_uri;/u);
  assert.doesNotMatch(site, /return 301 https?:\/\/\$(?:host|http_host)/u);
  assert.match(site, /listen 443 ssl default_server;\s+http2 on;\s+ssl_reject_handshake on;/u);
  assert.match(site, /server_name \$\{PUBLIC_HOSTNAME\};/u);
});

test('P12.2 proxy: every location that sets a header re-includes the security headers', () => {
  const locations = [...site.matchAll(/\n {2}location [^{]+\{([\s\S]*?)\n {2}\}/gu)].map((match) => match[1]);
  assert.ok(locations.length >= 4);
  for (const body of locations) {
    if (body.includes('add_header')) {
      assert.match(body, /include \/etc\/nginx\/snippets\/security-headers\.conf;/u, body);
    }
  }
  const headers = read('infra/proxy/security-headers.conf');
  for (const name of ['Strict-Transport-Security', 'X-Content-Type-Options', 'Content-Security-Policy', 'Referrer-Policy']) {
    assert.ok(headers.includes(name), `${name} is missing`);
  }
});

test('P12.2 proxy: the SSE location keeps the verified no-buffer policy', () => {
  const start = site.indexOf('location ~ ^/api/orgs/');
  const live = site.slice(start, site.indexOf('\n  }', start));
  for (const directive of [
    'proxy_http_version 1.1;',
    'proxy_buffering off;',
    'proxy_cache off;',
    'proxy_next_upstream off;',
    'proxy_read_timeout 75s;',
    'gzip off;',
    'proxy_pass_header X-Accel-Buffering;',
  ]) {
    assert.ok(live.includes(directive), `SSE location lost ${directive}`);
  }
});

test('P12.2 images: build targets keep the historical defaults', () => {
  const stages = (path) => [...read(path).matchAll(/^FROM .* AS (\S+)$/gmu)].map((match) => match[1]);
  assert.equal(stages('infra/api/Dockerfile').at(-1), 'runtime');
  assert.ok(stages('infra/api/Dockerfile').includes('tools'));
  assert.equal(stages('infra/proxy/Dockerfile').at(-1), 'transport');
  assert.ok(stages('infra/proxy/Dockerfile').includes('production'));
});

// The optional public Mapbox token is baked into the browser bundle at image build time. These are structural
// guards; the propagation proof is a real image build inspected for a unique fake token (see the task report).
test('Mapbox token: the web-build stage declares an empty-default build arg before the Vite build', () => {
  const dockerfile = read('infra/proxy/Dockerfile');
  const webBuild = dockerfile.slice(0, dockerfile.indexOf('\nFROM ', 1));
  const arg = webBuild.search(/^ARG VITE_MAPBOX_ACCESS_TOKEN=$/mu);
  const build = webBuild.indexOf('RUN npm run build --workspace=@running-tracker/web');
  assert.ok(arg >= 0, 'the build arg must default to empty so an omitted token keeps the fallback');
  assert.ok(build > arg, 'the arg must be declared before the Vite build runs');
  assert.ok(arg > webBuild.indexOf('RUN npm ci'), 'the arg must not invalidate the dependency layer');
  assert.doesNotMatch(dockerfile, /^ENV VITE_MAPBOX_ACCESS_TOKEN/mu, 'the token must not become runtime image config');
});

test('Mapbox token: both Compose profiles pass it to the proxy build only, with an empty default', () => {
  for (const [path, text] of [
    ['production', compose],
    ['transport', read('infra/compose/docker-compose.transport.yml')],
  ]) {
    const block = text.slice(text.indexOf('\n  proxy:\n'));
    assert.match(
      block,
      /build:[\s\S]*?args:\s+(?:#.*\n\s+)*VITE_MAPBOX_ACCESS_TOKEN: \$\{VITE_MAPBOX_ACCESS_TOKEN:-\}/u,
      `${path} proxy build must pass the token`,
    );
    assert.equal(text.match(/VITE_MAPBOX_ACCESS_TOKEN: /gu).length, 1, `${path} passes it exactly once`);
    assert.doesNotMatch(text, /VITE_MAPBOX_ACCESS_TOKEN: (?!\$\{VITE_MAPBOX_ACCESS_TOKEN:-\})\S/u);
  }
  assert.doesNotMatch(serviceBlock('api'), /MAPBOX/u, 'the token is a build input of the proxy image only');
});

test('Mapbox token: .env files stay out of the build context and the example documents the variable', () => {
  const ignore = read('.dockerignore').split(/\r?\n/u);
  assert.ok(ignore.includes('.env') && ignore.includes('.env.*'));
  assert.match(read('infra/compose/production.env.example'), /^# VITE_MAPBOX_ACCESS_TOKEN=$/mu);
  assert.doesNotMatch(read('infra/compose/production.env.example'), /^VITE_MAPBOX_ACCESS_TOKEN=\S/mu);
});

// F01: the OIDC callback carries a one-time code and state in its query string. The access log must name the
// method, the path and the protocol, never the raw request line. This is structural; the proof that no value
// reaches a log is the canary probe in verify-production-profile.mjs.
function accessLogFormat(config) {
  const formats = [...config.matchAll(/log_format\s+(\w+)\s+((?:'[^']*'\s*)+);/gu)];
  assert.equal(formats.length, 1, 'exactly one log_format is expected');
  return { name: formats[0][1], body: formats[0][2].replaceAll(/'\s*'/gu, '') };
}

test('F01 proxy: the access log format carries no query string and keeps its diagnostics', () => {
  const config = read('infra/proxy/nginx.production.conf');
  const { body, name } = accessLogFormat(config);
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
  assert.match(config, new RegExp(`access_log /dev/stdout ${name};`, 'u'));
  // The path variable is the raw request URI cut at the first question mark.
  assert.match(config, /map \$request_uri \$log_request_path \{[^}]*\(\?(?:P)?<\w+>\[\^\?\]\*\)/u);
  // No site may switch to another format or log the request elsewhere.
  assert.doesNotMatch(site, /access_log\s+(?!off;)/u, 'a site overrides the access log');
  assert.doesNotMatch(site, /log_format/u);
});
