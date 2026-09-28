import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const tlsDirectory = resolve(repositoryRoot, '.local', 'tls');
const image = 'running-tracker-proxy:p08.5';

mkdirSync(tlsDirectory, { recursive: true });

execFileSync(
  'docker',
  [
    'compose',
    '-f',
    'infra/compose/docker-compose.yml',
    '-f',
    'infra/compose/docker-compose.transport.yml',
    'build',
    'proxy',
  ],
  { cwd: repositoryRoot, stdio: 'inherit' },
);

execFileSync(
  'docker',
  [
    'run',
    '--rm',
    '--entrypoint',
    'openssl',
    '--volume',
    `${tlsDirectory}:/tls`,
    image,
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-days',
    '7',
    '-keyout',
    '/tls/localhost-key.pem',
    '-out',
    '/tls/localhost-cert.pem',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext',
    'keyUsage=digitalSignature,keyEncipherment',
    '-addext',
    'extendedKeyUsage=serverAuth',
  ],
  { cwd: repositoryRoot, stdio: 'inherit' },
);

console.info(`Generated development-only TLS material in ${tlsDirectory}`);
