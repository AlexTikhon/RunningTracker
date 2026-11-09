import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The running iPhone LAN pilot as `npm run pilot:configure` and `npm run pilot:tls` left it in .local/lan-pilot/
// (docs/runbooks/iphone-lan-pilot.md). Read-only: this suite never writes there and never starts or stops the pilot.

const pilotDirectory = resolve(import.meta.dirname, '..', '..', '..', '.local', 'lan-pilot');

export interface LanPilot {
  readonly bindAddress: string;
  // The common name of the pilot authority, which must have issued the certificate the browser is given.
  readonly caCommonName: string;
  readonly host: string;
  readonly hostname: string | null;
  readonly origin: string;
  // base64(SHA-256(SubjectPublicKeyInfo)) of the pilot server certificate, for Chromium's per-key allow-list.
  readonly serverSpkiSha256: string;
}

function read(path: string): string {
  try {
    return readFileSync(resolve(pilotDirectory, path), 'utf8');
  } catch {
    throw new Error(`Missing .local/lan-pilot/${path}. Configure and start the pilot first (docs/runbooks/iphone-lan-pilot.md).`);
  }
}

export function loadLanPilot(): LanPilot {
  const values = new Map(
    read('pilot.env')
      .split(/\r?\n/u)
      .filter((line) => line.includes('=') && !line.startsWith('#'))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
  );
  const value = (name: string) => {
    const found = values.get(name);
    if (found === undefined) throw new Error(`.local/lan-pilot/pilot.env has no ${name}; run npm run pilot:configure again`);
    return found;
  };
  const origin = value('PILOT_ORIGIN');
  if (!origin.startsWith('https://')) throw new Error('The pilot origin must be https');
  const server = new X509Certificate(read('tls/server/server-cert.pem'));
  const ca = new X509Certificate(read('tls/ca/ca-cert.pem'));
  const caCommonName = /^CN=(.+)$/mu.exec(ca.subject)?.[1];
  if (!caCommonName || !server.checkIssued(ca)) throw new Error('The pilot server certificate was not issued by the pilot authority');
  return {
    bindAddress: value('PILOT_BIND_ADDRESS'),
    caCommonName,
    host: value('PILOT_HOST'),
    hostname: value('PILOT_HOSTNAME') === '' ? null : value('PILOT_HOSTNAME'),
    origin,
    serverSpkiSha256: createHash('sha256').update(server.publicKey.export({ format: 'der', type: 'spki' })).digest('base64'),
  };
}
