# iPhone LAN pilot: evidence (physical checks NOT RUN)

Status on 2026-11-09: the pilot environment exists and was verified **on the Windows workstation only**. **No iPhone
step has been run.** Every physical result below is NOT RUN until the owner records an observation. Desktop automation
is not evidence about Safari on an iPhone. How to run the pilot: `docs/runbooks/iphone-lan-pilot.md`; design: ADR-0085.

**Privacy rules for this file.** Record categories only. No address, Wi-Fi name, account, Apple ID, device name, serial
number, phone number, place, route, map screenshot or time of day. "iPhone, iOS 26.x, Safari" is enough. Use only the
synthetic demo people and synthetic values; do not paste real health data.

## Automated results (workstation, not the phone)

Windows 11, Docker Desktop 29.7.2, Compose v5.4.0, Node 24.11. Pilot bound to a private 192.168.x address of the
workstation's Wi-Fi adapter, port 8443, no host name, at commit `d735a37` (the verification commit).

| Check | Command | Result |
|---|---|---|
| Configure refusals | `npm run pilot:configure -- --address 0.0.0.0`, then an unassigned 192.168.x address | both refused before writing anything |
| Certificates | `npm run pilot:tls` | CA and server certificate issued; strict `openssl verify -purpose sslserver -verify_ip` OK; a second run refused to overwrite the five files; `.local/tls/` (transport profile) unchanged |
| First issuance attempt | `npm run pilot:tls` (before the fix) | `openssl verify` failed with "permitted subtree violation": the server CN was the address and OpenSSL checked it as a DNS name. CN made descriptive; issuance now ends with that verify and removes its output on failure |
| Start, twice | `npm run pilot:up` | healthy; the init job applied 40 migrations the first time and skipped them the second; seed idempotent (2 users) |
| HTTPS verification | `npm run pilot:verify` | PASS (see below) |
| Desktop browser through the proxy | `npm run pilot:e2e` | 1 passed (Chromium, 390×844) |
| Pilot database after both | `psql` in the pilot container | 0 check-ins, 0 movement days, 0 meals, 2 users |

`pilot:verify` asserted:

- **Exposure.** Proxy published exactly `<address>:8443->443/tcp`; API and PostgreSQL publish nothing; PostgreSQL only
  on `running-tracker-lan-pilot_data` (internal) with volume `running-tracker-lan-pilot_lan_pilot_postgres`; the proxy
  mounts only `/etc/nginx/tls` read-only.
- **TLS.** TLS 1.3, chain validated by Node against the pilot CA alone; without it `UNABLE_TO_VERIFY_LEAF_SIGNATURE`;
  for another name `ERR_TLS_CERT_ALTNAME_INVALID`; loopback `ECONNREFUSED`; plain HTTP on the port 400.
- **HTTP.** Page 200 with HSTS, `nosniff` and `frame-ancestors 'none'`, no CORS header; the pilot bundle contains the
  demo sign-in; another Host 421 with no API answer.
- **Origin.** Only `https://<address>:8443` accepted. No Origin, `null`, `https://evil.example`, `http://<address>:8443`,
  port 8444 and `https://localhost:8443` each 403 `ORIGIN_DENIED` with no cookie; an unlisted identity 403
  `LOCAL_IDENTITY_DENIED`.
- **Session.** Cookie `HttpOnly; Path=/; SameSite=Strict; Secure`; `GET /api/session` named the demo runner and coach.
- **Owner-only read.** Write without CSRF 403 `CSRF_DENIED`, with a foreign Origin 403 `ORIGIN_DENIED`, then 201;
  owner read 200; the coach 404 `DAILY_METRICS_NOT_FOUND` without the marker; anonymous 401.
- **Isolation.** The marker row was in `running_tracker_lan_pilot` (1 row; the pilot API connected to it), and 0 rows
  in `running_tracker` and `running_tracker_test` of the development container.
- **SSE.** HTTP/2, 200, `text/event-stream; charset=utf-8`, `X-Accel-Buffering: no`, no content encoding,
  `private, no-store`, first frame `event: live.state`.
- **Logs.** Three callback canaries, one through a 413 nginx refused itself: 0 in the access log, 0 in the error log, 0
  unsanitized error lines, 0 error lines on stdout; the 413 carried a sanitized `request_body_too_large` event.
- **Cleanup.** Check-in deleted (404, 0 rows); both sessions ended (401 afterwards).

`pilot:e2e` asserted: the certificate the browser received was issued by the pilot CA (subject "Running Tracker LAN
pilot server", TLS 1.3); a secure context with Geolocation available; Demo runner sign-in with no console; the session
cookie Secure, HttpOnly, SameSite=Strict for the configured host; on a date 12 days back, a check-in, movement and a meal
saved, edited and deleted through the editors opened from Today; Trends from Today showing the edited steps, weight and
food energy, 28 rows, no horizontal scrolling at 390 px; a reload keeping the session; sign-out ending it, also after a
reload; no request to any other origin. Trust in that browser was a one-key allow-list in a throwaway profile; a
browser without it refused the pilot (`ERR_CERT_AUTHORITY_INVALID`), and so did one with another key on the list.

Not covered automatically: the phone reaching the computer through the Windows firewall and the Wi-Fi (the desktop
connects to its own address), Safari, WebKit, iOS inputs, real GPS.

## Physical Safari checklist (owner)

Device category: ______ (for example "iPhone, iOS 26.x"). Browser: Safari. Pilot commit: ______.
Fallback CA without name constraints needed: yes / no. Firewall rule needed: yes / no.

Mark each **PASS**, **FAIL** (with the observed defect) or **NOT RUN**. Change nothing else in the table.

| # | Step | What to do | Pass when | Result | Observed defect |
|---|---|---|---|---|---|
| 1 | Certificate install | Install the `.cer` profile and turn on full trust (runbook step 3) | Profile installed; the CA listed under Certificate Trust Settings and enabled; fingerprint matches if shown | NOT RUN | - |
| 2 | Trusted HTTPS | Open the pilot origin in Safari | No warning at any point; the lock/page info shows a secure connection | NOT RUN | - |
| 3 | Sign-in | Press **Demo runner** | "Signed in", organization `dddddddd` selected; no console used | NOT RUN | - |
| 4 | Today | Open Today, change the date, Go to today | Day loads; date picker usable; no horizontal scrolling | NOT RUN | - |
| 5 | Check-in editor | Add, edit, delete a check-in (synthetic values) | Saved / updated / deleted messages; Today reflects each | NOT RUN | - |
| 6 | Movement editor | Add, edit, delete steps | As above; "Steps" keyboard is numeric | NOT RUN | - |
| 7 | Meal log | Add, edit, delete an entry with energy 350.5 | As above; decimal entry possible on the iOS keyboard | NOT RUN | - |
| 8 | Numeric and date inputs | In the editors, use the date field and number fields | Native date picker opens; decimals accepted; invalid values explained, not silently rounded | NOT RUN | - |
| 9 | Keyboard | Focus a field near the bottom; dismiss the keyboard | Field stays visible above the keyboard; nothing is covered permanently; layout returns | NOT RUN | - |
| 10 | Scrolling | Scroll Today, editors and Trends | Smooth vertical scroll; no horizontal page scroll; navigation reachable | NOT RUN | - |
| 11 | Trends chart and table | Open Trends, switch series, tap a table row's Open | Chart readable; table usable; Open goes to Today on that date | NOT RUN | - |
| 12 | Reload and session | Pull to reload; close and reopen the tab | Still signed in (until the session lifetime ends) | NOT RUN | - |
| 13 | Sign out | Press Sign out, reload | Signed out; demo panel shown again | NOT RUN | - |
| 14 | Foreground GPS capture | Runner tab, Device GPS, Start; allow location; walk a little with the screen on, Safari in front | Location permission prompt appears; point count rises; capture health shows a fix | NOT RUN | - |
| 15 | Navigation while recording | While recording, open Today and Trends, then return to Runner | Recording continues; points keep being counted and uploaded; same run | NOT RUN | - |
| 16 | Finish | Finish the run | Run finished; appears in Archive › My runs within about a minute | NOT RUN | - |
| 17 | Screen lock / background (observe only) | During a recording, lock the screen or switch apps for about a minute, then return | Record what happens: points during the gap, recovery, any message. **No continuous background GPS is promised**; a gap is an observation, not a failure | NOT RUN | - |

For step 14–17, start and stop away from home or any place you would not want a route to point to, and do not attach
the route, a map, coordinates or a screenshot of the map here. Write only counts and behaviour ("12 points in 1 min",
"no points while locked; capture resumed after unlock").

## Conclusion

Workstation verification: done (above). iPhone compatibility: **unknown** until the checklist is filled in. The pilot
is for synthetic data only; the prerequisites for real health data are at the end of the runbook.
