// The iPhone LAN pilot's certificates (docs/runbooks/iphone-lan-pilot.md). A small certificate authority of its own,
// name-constrained to exactly this pilot's address (and name, if one was given), signs one server certificate that
// meets Apple's requirements for trusted TLS server certificates (support.apple.com/en-us/103769): RSA >= 2048,
// SHA-256, the address/name in subjectAltName, serverAuth EKU, a validity far under 825 days.
//
//   .local/lan-pilot/tls/ca/      ca-cert.pem, ca-key.pem   the authority; its key never leaves this computer and is
//                                                           never mounted into a container that serves traffic
//   .local/lan-pilot/tls/server/  server-cert.pem, server-key.pem   mounted read-only into the pilot proxy only
//   .local/lan-pilot/phone/       <name>.cer                the public authority certificate (DER), for the phone
//
// It never overwrites a file, never touches .local/tls/ (the loopback transport profile), and never installs trust
// anywhere: trusting the authority on the phone is a manual step.
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const caValidityDays = 120;
export const serverValidityDays = 90;
export const phoneCertificateName = 'running-tracker-lan-pilot-ca.cer';
// Names under .invalid can never resolve, so with no host name configured the authority cannot sign any DNS name.
const unusableName = 'lan-pilot.invalid';

export function certificateFiles(paths) {
  return {
    caCert: join(paths.ca, 'ca-cert.pem'),
    caKey: join(paths.ca, 'ca-key.pem'),
    phone: join(paths.phone, phoneCertificateName),
    serverCert: join(paths.server, 'server-cert.pem'),
    serverKey: join(paths.server, 'server-key.pem'),
  };
}

/** RFC 5280 name constraints: exactly this pilot's address and name. Without them only as a documented fallback. */
export function nameConstraints(settings) {
  const dns = settings.hostname ?? unusableName;
  return `critical,permitted;IP:${settings.bindAddress}/255.255.255.255,permitted;DNS:${dns}`;
}

export function subjectAltName(settings) {
  return [`IP:${settings.bindAddress}`, ...(settings.hostname ? [`DNS:${settings.hostname}`] : [])].join(',');
}

/** OpenSSL configuration for the authority. The common name is unique, so each generation is told apart on the phone. */
export function renderCaConfig(settings, { constrained = true, label }) {
  return [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    'x509_extensions = v3_ca',
    '[dn]',
    `CN = Running Tracker LAN pilot CA ${label}`,
    'O = Running Tracker local pilot - synthetic data only',
    '[v3_ca]',
    'basicConstraints = critical,CA:TRUE,pathlen:0',
    'keyUsage = critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier = hash',
    ...(constrained ? [`nameConstraints = ${nameConstraints(settings)}`] : []),
    '',
  ].join('\n');
}

export function renderServerConfig(settings) {
  return [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    '[dn]',
    // Not the address: OpenSSL checks a host-like common name against the DNS name constraint, and the address is not
    // a permitted DNS name. Clients match only subjectAltName (Apple ignores the common name), so it stays descriptive.
    'CN = Running Tracker LAN pilot server',
    '[v3_server]',
    'basicConstraints = critical,CA:FALSE',
    'keyUsage = critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage = serverAuth',
    `subjectAltName = ${subjectAltName(settings)}`,
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid:always',
    '',
  ].join('\n');
}

/**
 * The OpenSSL calls, with container paths: /tls is .local/lan-pilot/tls, mounted for this one run. The last one
 * validates the chain as a TLS client would (strict X.509, server purpose, the name constraints, the address and name).
 */
export function opensslSteps(settings) {
  return [
    ['req', '-x509', '-new', '-newkey', 'rsa:3072', '-noenc', '-sha256', '-days', String(caValidityDays),
      '-config', '/tls/work/ca.cnf', '-keyout', '/tls/ca/ca-key.pem', '-out', '/tls/ca/ca-cert.pem'],
    ['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-sha256', '-config', '/tls/work/server.cnf',
      '-keyout', '/tls/server/server-key.pem', '-out', '/tls/work/server.csr'],
    ['x509', '-req', '-in', '/tls/work/server.csr', '-CA', '/tls/ca/ca-cert.pem', '-CAkey', '/tls/ca/ca-key.pem',
      '-set_serial', `0x${randomBytes(16).toString('hex').replace(/^[89a-f]/u, '7')}`, '-days', String(serverValidityDays),
      '-sha256', '-extfile', '/tls/work/server.cnf', '-extensions', 'v3_server', '-out', '/tls/server/server-cert.pem'],
    ['verify', '-x509_strict', '-purpose', 'sslserver', '-CAfile', '/tls/ca/ca-cert.pem', '-verify_ip', settings.bindAddress,
      ...(settings.hostname ? ['-verify_hostname', settings.hostname] : []), '/tls/server/server-cert.pem'],
  ];
}

export function existingCertificateFiles(paths) {
  return Object.values(certificateFiles(paths)).filter((path) => existsSync(path));
}

/**
 * Checks what was written, with Node's own X.509 code: the chain, the key pair, the names, the constraints and the
 * validity. Returns what the owner needs to compare on the phone.
 */
export function inspectCertificates(paths, settings, { constrained = true } = {}) {
  const files = certificateFiles(paths);
  const ca = new X509Certificate(readFileSync(files.caCert));
  const server = new X509Certificate(readFileSync(files.serverCert));
  const problems = [];
  if (!ca.ca) problems.push('the authority certificate is not a CA');
  if (server.ca) problems.push('the server certificate is a CA');
  if (!server.checkIssued(ca) || !server.verify(ca.publicKey)) problems.push('the server certificate is not signed by the authority');
  if (!server.checkPrivateKey(createPrivateKey(readFileSync(files.serverKey)))) problems.push('the server key does not match');
  if (server.checkIP(settings.bindAddress) === undefined) problems.push(`the server certificate does not name ${settings.bindAddress}`);
  if (settings.hostname && server.checkHost(settings.hostname, { subject: 'never' }) === undefined) {
    problems.push(`the server certificate does not name ${settings.hostname}`);
  }
  if (!/Server Authentication|serverAuth|1\.3\.6\.1\.5\.5\.7\.3\.1/u.test(String(server.keyUsage ?? []))) {
    problems.push('the server certificate lacks the serverAuth extended key usage');
  }
  if (server.publicKey.asymmetricKeyDetails?.modulusLength < 2048) problems.push('the server key is shorter than 2048 bits');
  const days = (Date.parse(server.validTo) - Date.parse(server.validFrom)) / 86_400_000;
  if (days > 397) problems.push(`the server certificate is valid for ${days} days`);
  if (problems.length > 0) throw new Error(`The pilot certificates failed their checks: ${problems.join('; ')}`);
  return {
    caFingerprint256: ca.fingerprint256,
    caSubject: ca.subject.replaceAll('\n', ', '),
    caValidTo: ca.validTo,
    constrained,
    serverSubjectAltName: server.subjectAltName,
    serverValidTo: server.validTo,
  };
}

/**
 * Issues the authority and the server certificate. `runOpenssl(args)` runs OpenSSL with /tls mounted and throws when
 * it fails; the caller provides it (a container run of the pilot proxy image). Refuses if any output file already
 * exists, so every output is new: if a step or a check fails, everything this run wrote is removed again.
 */
export function issuePilotCertificates({ constrained = true, paths, runOpenssl, settings, today = new Date() }) {
  const existing = existingCertificateFiles(paths);
  if (existing.length > 0) {
    throw new Error(
      `Refusing to overwrite existing pilot certificate files:\n  ${existing.join('\n  ')}\n` +
        'To issue new ones, follow "Replacing the certificates" in docs/runbooks/iphone-lan-pilot.md.',
    );
  }
  const work = join(paths.tls, 'work');
  for (const directory of [paths.ca, paths.server, paths.phone, work]) mkdirSync(directory, { recursive: true });
  const label = `${today.toISOString().slice(0, 10)} ${randomBytes(3).toString('hex')}`;
  const files = certificateFiles(paths);
  try {
    writeFileSync(join(work, 'ca.cnf'), renderCaConfig(settings, { constrained, label }));
    writeFileSync(join(work, 'server.cnf'), renderServerConfig(settings));
    for (const step of opensslSteps(settings)) runOpenssl(step);
    const summary = inspectCertificates(paths, settings, { constrained });
    // DER, for the phone: the public certificate only, never a key.
    writeFileSync(files.phone, new X509Certificate(readFileSync(files.caCert)).raw, { flag: 'wx' });
    return { ...summary, phoneFile: files.phone };
  } catch (error) {
    for (const path of Object.values(files)) rmSync(path, { force: true });
    throw error;
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
}
