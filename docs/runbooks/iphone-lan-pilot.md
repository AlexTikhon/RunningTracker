# Runbook: the iPhone LAN pilot (synthetic data only)

Audience: the owner, with one Windows computer and one iPhone on the same trusted Wi-Fi, and no Mac. Design: ADR-0085.
Evidence: `docs/reports/iphone-lan-pilot.md`. Related: `docs/runbooks/demo.md` (the demo people),
`docs/runbooks/deployment.md` and `docs/runbooks/identity-provider.md` (what a real deployment needs instead).

The pilot runs an isolated copy of the stack on the Windows computer and serves it over HTTPS on that computer's
private LAN address, so Safari on the iPhone can open the web app, sign in as a demo person and use Today, the editors,
Trends and the Runner's foreground GPS capture. There is no native app, no HealthKit, no public deployment and no
tunnel.

> **Synthetic data only.** The pilot signs people in with the **development session** for two fixed demo people (the
> **Demo runner** and **Demo coach** buttons). That is **not identity verification**: anyone who can reach the address
> can press the button and be the demo runner. Never enter real personal health data, real weights, real meals or a
> real route you would not show a stranger. Real data needs the prerequisites at the end of this runbook first.

## What it is

| | |
|---|---|
| Compose project | `running-tracker-lan-pilot` (`infra/compose/docker-compose.lan-pilot.yml`), separate from the development stack |
| Database | its own PostgreSQL container, database `running_tracker_lan_pilot`, volume `running-tracker-lan-pilot_lan_pilot_postgres`, on an internal network with no published port. Never the development or test database |
| Data | the two synthetic demo people and their organization, seeded by the init job; whatever you type during the pilot |
| Published | only HTTPS, on the one private address you configure (for example `192.168.1.50:8443`). Never `0.0.0.0`, never loopback |
| Sign-in | development session for the two demo IDs; Secure, HttpOnly, SameSite=Strict cookie; the API accepts state-changing requests only from the one pilot origin |
| AI | both providers off (run-search interpretation and weekly insights) |
| Certificate | from the pilot's own small certificate authority (CA), limited by name constraints to exactly your address (and name, if you give one). The CA's private key stays on the computer |
| Local files | everything under `.local/lan-pilot/` (git ignores `.local/`): `pilot.env`, `secrets/`, `tls/ca/`, `tls/server/`, `phone/` |

The existing loopback transport profile (`npm run transport:*`, `127.0.0.1:8443`, certificate for `localhost`, test
database) and the production profile are unchanged.

## Prerequisites

- Docker Desktop running, dependencies installed (`npm ci`), Node as in `package.json` `engines`.
- The computer and the iPhone on the **same trusted Wi-Fi** (home, not a café, hotel or guest network: those often
  isolate clients, and you should not publish anything there). The Windows network profile for that Wi-Fi must be
  **Private** (`Get-NetConnectionProfile` in PowerShell shows `NetworkCategory`). Do not switch a public network to
  Private for this.
- No VPN active on the computer or the phone while testing (a VPN can route the private address elsewhere).
- The computer's IPv4 address on that Wi-Fi: `ipconfig`, adapter "Wireless LAN adapter Wi-Fi", line "IPv4 Address",
  for example `192.168.1.50`. A DHCP reservation in your router keeps it from changing; if it changes, see "Replacing
  the certificates".

## 1. Configure, issue the certificate, start

```powershell
npm run pilot:configure -- --address 192.168.1.50      # optional: --port 8443 (default), --hostname my-pc.local
npm run pilot:tls
npm run pilot:up
npm run pilot:verify
```

- `pilot:configure` refuses anything but a private RFC 1918 address (10.x, 172.16–31.x, 192.168.x) that belongs to this
  computer, writes `.local/lan-pilot/pilot.env` (the address, the port, the one allowed origin
  `https://192.168.1.50:8443`) and random database passwords for the pilot. A `--hostname` must end in `.local`,
  `.home.arpa`, `.internal` or `.lan`; without one, the phone uses the address, which is the most reliable choice
  because it does not depend on name resolution on the phone.
- `pilot:tls` builds the pilot proxy image and uses its OpenSSL in a container without network to issue the CA and the
  server certificate. It prints the CA's **SHA-256 fingerprint**: keep that line for step 3. It never overwrites a
  file and never touches `.local/tls/`.
- `pilot:up` builds and starts PostgreSQL, the init job (roles, migrations, demo people), the API and the proxy, and
  waits until they are healthy. The first run builds three images and takes a few minutes.
- `pilot:verify` checks the running pilot through its HTTPS address with real certificate validation (see "What was
  verified automatically") and prints a JSON summary ending in `"verdict": "PASS"`. It writes one check-in and deletes
  it again.

Optional, desktop browser: `npm run pilot:e2e` runs one Chromium test through the pilot (sign-in, Today, editors,
Trends, reload, sign-out). It needs the Playwright Chromium browser (`cd tests/e2e; npx playwright install chromium`).

## 2. Allow the phone through the Windows firewall (manual, narrow, removable)

Nothing in this repository changes the firewall. From the computer itself the pilot works without a rule, so
`pilot:verify` passing does not show that the phone can connect. If Safari on the phone cannot connect (it waits and
then says it cannot open the page), add **one** inbound rule, limited to the pilot port, the pilot address, the local
subnet and the Private profile. In PowerShell **as Administrator**, with your address and port:

```powershell
New-NetFirewallRule -DisplayName "Running Tracker LAN pilot (HTTPS 8443)" -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 8443 -LocalAddress 192.168.1.50 -RemoteAddress LocalSubnet -Profile Private
```

Remove it when the pilot is over (also part of "Shutting down and cleaning up"):

```powershell
Remove-NetFirewallRule -DisplayName "Running Tracker LAN pilot (HTTPS 8443)"
```

Do not allow Docker Desktop or the port on the Public profile, and do not turn the firewall off.

## 3. Trust the pilot certificate authority on the iPhone

The phone must trust the pilot CA, or Safari will warn about the certificate. **Never continue past a certificate
warning**: if Safari warns, stop, because either trust is not set up yet or you are not talking to your pilot.

Only the **public** certificate goes to the phone: `.local/lan-pilot/phone/running-tracker-lan-pilot-ca.cer`. Never
send anything from `.local/lan-pilot/tls/` (that folder holds the private keys), and never send `ca-key.pem` anywhere.

1. **Get the file onto the phone.** Either email it to yourself and open the attachment in the iPhone's Mail app, or put
   it in iCloud Drive (iCloud for Windows) and tap it in the Files app. Do not use a public file-sharing link.
2. **Install it** (Apple: "Install a configuration profile on your iPhone, iPad, or Apple Vision Pro",
   support.apple.com/en-us/102400). After you open the file the phone says **Profile Downloaded**. Open **Settings**, tap
   **Profile Downloaded**, then **Install** in the upper-right corner, and follow the steps (it asks for the passcode).
   Apple notes that a downloaded profile that is not installed **within 8 minutes is deleted**, that only **one**
   downloaded profile waits at a time (the latest), and that with **Stolen Device Protection** you may have to be in a
   familiar location, or turn it off for the installation and back on afterwards.
3. **Check it is yours.** Settings › General › VPN & Device Management lists installed profiles; open the one named
   "Running Tracker LAN pilot CA …" and its certificate details. If the phone shows a SHA-256 fingerprint, it must equal
   the one `pilot:tls` printed. If it does not match, remove the profile and stop.
4. **Turn on full trust** (Apple: "Trust manually installed certificate profiles in iOS, iPadOS, and visionOS",
   support.apple.com/en-us/102390): Settings › General › About › **Certificate Trust Settings**, and under "Enable full
   trust for root certificates" turn on **Running Tracker LAN pilot CA …**. Apple requires this step for a certificate
   installed from email or a website. If that heading is missing, the profile was not installed.

Because the CA is limited to your pilot's address (and name), trusting it does not let it vouch for any other site.
It is still a root on your phone: remove it when the pilot is over.

## 4. Open the pilot in Safari

On the iPhone, in Safari, open exactly the origin from `pilot.env`, for example `https://192.168.1.50:8443` (the
`https://` and the port are part of it). Expect: no warning, the page "Sign in required" with a **Local demo** panel.
Press **Demo runner**. Then work through the checklist in `docs/reports/iphone-lan-pilot.md` and record what you see
there. No console is needed for anything.

Use the address exactly as configured: opening the pilot by another name or address is refused (421), and Safari's
requests must carry the configured origin.

## Shutting down and cleaning up

| What | How |
|---|---|
| Stop the pilot, keep its data | `npm run pilot:down` |
| Stop it and delete its database | `npm run pilot:down -- --delete-data` (only the pilot's volume; the development database is untouched) |
| Firewall rule | `Remove-NetFirewallRule -DisplayName "Running Tracker LAN pilot (HTTPS 8443)"` (as Administrator) |
| Trust on the phone | Settings › General › VPN & Device Management › "Running Tracker LAN pilot CA …" › **Remove Profile**. That removes the certificate and its trust; Certificate Trust Settings no longer lists it |
| Local files and keys | after `pilot:down`, delete `.local/lan-pilot/` (configuration, database passwords, the CA and server keys, the phone copy) |
| Images (optional) | `docker image rm running-tracker-proxy:lan-pilot running-tracker-api:lan-pilot running-tracker-tools:lan-pilot` |
| Email or cloud copy | delete the `.cer` from the email or iCloud Drive you used (it is public, but there is no reason to keep it) |

If you will not issue another server certificate, you may delete `.local/lan-pilot/tls/ca/ca-key.pem` right after
`pilot:tls`: the running pilot needs only `tls/server/`, and without the CA key nothing new can be signed.

## Replacing the certificates

Needed when the address changes, when the server certificate nears its end (90 days; the CA lasts 120), or if a key may
have leaked. The CA is limited to the old address, so a new address needs a new CA and new trust on the phone:

1. `npm run pilot:down`, and remove the old profile from the phone.
2. Delete `.local/lan-pilot/pilot.env`, `.local/lan-pilot/tls/` and `.local/lan-pilot/phone/` (keep `secrets/` and the
   database volume if you want to keep the pilot's data).
3. Run step 1 again (`pilot:configure` with the new address, `pilot:tls`, `pilot:up`, `pilot:verify`), then step 3 with
   the new file and fingerprint, and update the firewall rule's `-LocalAddress`.

**Fallback, only if Safari still refuses after full trust is on:** some clients reject a root with name constraints.
`npm run pilot:tls -- --without-name-constraints` issues the CA without them (the server certificate is unchanged). Such
a CA could vouch for any site if its key leaked, so delete `ca-key.pem` immediately after issuing, and remove the
profile as soon as the pilot is over. Record in the report that the fallback was needed.

## If something does not work

| Symptom | Likely cause |
|---|---|
| `pilot:configure` says the address is not an address of this computer | A typo, the Ethernet instead of the Wi-Fi address, or the address changed; check `ipconfig` |
| `pilot:up` fails binding the port | Another program uses that address and port; choose another `--port` (after "Replacing the certificates", since the origin includes the port) |
| `pilot:verify` fails at the first step | The pilot is not running (`npm run pilot:status`) or Docker Desktop is stopped |
| Safari waits, then cannot open the page | Firewall (step 2), a VPN, a guest network with client isolation, a public network profile, or the phone on another network |
| Safari warns about the certificate | Trust is not on (step 3, part 4), the profile is from an older CA, or the page is opened under another name. Do not continue past it |
| "Misdirected Request" (421) | The page was opened with another address or name than `PILOT_ORIGIN` |
| The demo panel says the address is not accepted (403 `ORIGIN_DENIED`) | Same cause: Safari's origin is not the configured one. The panel's hint mentions `http://127.0.0.1:5173`; for the pilot, the address is the one in `pilot.env` |
| No Local demo panel | A cached page from another build or a signed-in session; reload, or sign out first |
| Location never arrives on the Runner tab | Safari's location permission for the site, or Location Services for Safari Websites, is off; or the page is not a trusted HTTPS page |

## What was verified automatically

On the Windows computer, against the running pilot (results in `docs/reports/iphone-lan-pilot.md`):

- `pilot:verify`: one published port, on the configured address only, and none for the API and PostgreSQL; PostgreSQL
  on an internal network with the pilot volume; TLS 1.3 validated against the pilot CA alone, refused without it and
  for another name; nothing on loopback; 421 for an unconfigured Host; security headers; the demo sign-in in the pilot
  bundle; only the pilot origin accepted (no Origin, `null`, a foreign origin, `http://`, another port and
  `https://localhost:8443` refused); an unlisted identity refused; Secure, HttpOnly, SameSite=Strict session cookies; a
  check-in written with CSRF and Origin enforced, readable by its owner only (the coach and an anonymous request get
  404 and 401); that row present in the pilot database and absent from the development and test databases; live SSE
  over HTTP/2 with its no-buffer headers; callback-shaped canaries absent from both proxy log streams, including through
  a 413 that nginx logs itself; cleanup and sign-out.
- `pilot:e2e`: desktop Chromium at a 390×844 viewport through the pilot proxy: the certificate it received was issued
  by the pilot CA (trusted for that one server key only, in a throwaway profile), a secure context with Geolocation
  available, demo sign-in, Today, a check-in, movement and a meal saved, edited and deleted, Trends with the edited
  values, a reload keeping the session, sign-out, and no request to another origin.

**Not shown by any of this:** that Safari on an iPhone trusts the certificate, renders the app or keeps the session;
that the phone can reach the computer through its firewall and Wi-Fi; touch, keyboard, date and number inputs on iOS;
GPS on the phone. Those are the physical checks, which only the owner can run.

## Before using real health data

The pilot is a usability trial. None of these are in place, and each is required before real personal data:

1. **Real sign-in.** OpenID Connect with a registered provider and invite-only provisioning
   (`docs/runbooks/identity-provider.md`), `APP_ENV=production` and `LOCAL_AUTH_ENABLED=false`. The demo buttons and the
   development session must not exist.
2. **The production profile** (`docs/runbooks/deployment.md`), with a certificate from a CA every device already
   trusts, a decided network exposure, and resource limits; not a computer that also runs development tools.
3. **Backups and recovery** (`docs/runbooks/backup-and-restore.md`) with off-host storage, and the deletion journal on
   storage that survives the host (`docs/runbooks/deletion-journal-and-recovery.md`).
4. **A privacy review** of what is stored (routes are location history; check-ins and meals are health data),
   retention, erasure and who can reach the server, plus disk encryption on the host.
5. **Real, separate identities** per person instead of shared demo IDs, and no synthetic seed.
