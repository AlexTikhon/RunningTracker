FROM node:24.11.0-alpine3.22@sha256:f36fed0b2129a8492535e2853c64fbdbd2d29dc1219ee3217023ca48aebd3787 AS web-build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/fixtures/package.json packages/fixtures/package.json
COPY tools/simulator/package.json tools/simulator/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/contracts packages/contracts
COPY packages/fixtures packages/fixtures
# Optional, public, browser-visible Mapbox token. Vite inlines it at build time, so it ships in the
# bundle; empty keeps the tokenless fallback. Declared after npm ci so it never invalidates that layer.
ARG VITE_MAPBOX_ACCESS_TOKEN=
RUN npm run build --workspace=@running-tracker/web

# Both proxy profiles start nginx behind the error-log boundary (ADR-0062): nginx's stderr is a private FIFO read only
# by the sanitizer, which runs on njs's QuickJS engine from the base image. Docker still stops it with SIGQUIT.
FROM nginx:1.28.0-alpine3.21@sha256:30f1c0d78e0ad60901648be663a710bdadf19e4c10ac6782c235200619158284 AS proxy-base

# Created first: COPY --chmod would give a directory it creates the file's mode, and with every capability dropped
# even root cannot traverse a directory without its execute bit.
RUN mkdir -m 0755 /usr/local/lib/nginx-error-log
COPY --chmod=0644 infra/proxy/error-log-sanitizer.mjs /usr/local/lib/nginx-error-log/sanitizer.mjs
COPY --chmod=0755 infra/proxy/error-log-boundary.sh /usr/local/sbin/nginx-error-log-boundary
STOPSIGNAL SIGQUIT
ENTRYPOINT ["/usr/local/sbin/nginx-error-log-boundary"]
CMD []

# Deployment profile (P12.2): operator-supplied certificate, one configured public host name, HTTP redirect.
# The site file is rendered from the image's envsubst template at container start.
FROM proxy-base AS production

RUN rm -f /etc/nginx/conf.d/default.conf
COPY infra/proxy/nginx.production.conf /etc/nginx/nginx.conf
COPY infra/proxy/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY infra/proxy/production-site.conf.template /etc/nginx/templates/site.conf.template
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80 443

# Local transport profile (P08.5). Keep it the LAST stage: it is the default build target.
FROM proxy-base AS transport

# OpenSSL is present only to generate the explicitly local development certificate.
RUN apk add --no-cache openssl
COPY infra/proxy/nginx.conf /etc/nginx/nginx.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 443
