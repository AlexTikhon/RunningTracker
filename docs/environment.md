# Environment baseline

Checked: 2026-09-19, Windows, repository root `C:\ForMe\Learning\Running_Tracker`.

## Verified tools

| Component | Version / result |
|---|---|
| Node.js | 24.11.1, ICU 77.1 |
| npm | 11.6.2 |
| Git | 2.52.0.windows.1 |
| Docker CLI | 29.7.2 |
| Docker Engine | 29.7.2 after starting installed Docker Desktop |
| PostGIS image | `postgis/postgis:17-3.5`, pinned to amd64 digest `sha256:8dfee83d8bd4c2873dc4a233c13ba2799a44f2edb16a0552d58715917fac32ba` |

Node 24 is an LTS line and is supported by the selected Vite and Express 5 runtime versions. The repository does not depend on global generators; its build uses local `tsc`/`tsx` commands.

Official references checked during P00:

- Node.js release schedule: https://nodejs.org/en/about/previous-releases
- Vite Node.js requirements: https://vite.dev/guide/
- Express 5 API reference: https://expressjs.com/en/5x/api.html
- PostGIS image supported variants: https://github.com/postgis/docker-postgis

## Ports

| Port | Purpose | Initial state |
|---|---|---|
| 3000 | Express API | free |
| 5173 | Vite web | free |
| 5432 | existing local PostgreSQL/process | occupied by PID 9760 |
| 5433 | Compose PostGIS host port | free |

Compose binds PostGIS to `127.0.0.1:5433`, avoiding the existing listener and preventing LAN exposure.

## Environment constraints

- Docker Desktop was installed but its daemon was initially stopped. It became available after a normal background start; no system component was installed or reconfigured.
- The pinned image digest is the verified Linux amd64 manifest. A future arm64 workstation must deliberately select and record its corresponding digest.
- Fixed database credentials are local fixtures only. Deployment credentials and secret management are outside P00–P01.

These are workstation/runtime constraints. Product and architecture constraints remain in `SDD.md`.
