FROM node:24.11.0-alpine3.22@sha256:f36fed0b2129a8492535e2853c64fbdbd2d29dc1219ee3217023ca48aebd3787 AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/fixtures/package.json packages/fixtures/package.json
COPY tools/simulator/package.json tools/simulator/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages/contracts packages/contracts
COPY scripts scripts
COPY db/migrations db/migrations
RUN npm run build --workspace=@running-tracker/api \
  && npm prune --omit=dev

# One-shot database bootstrap and migration job (P12.2). It carries the SQL migrations and the
# privileged scripts, which the API image deliberately does not.
FROM node:24.11.0-alpine3.22@sha256:f36fed0b2129a8492535e2853c64fbdbd2d29dc1219ee3217023ca48aebd3787 AS tools

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/scripts scripts
COPY --from=build /app/db/migrations db/migrations

USER node
CMD ["node", "scripts/migrate.mjs"]

# The API runtime image must stay the LAST stage: it is the default build target.
FROM node:24.11.0-alpine3.22@sha256:f36fed0b2129a8492535e2853c64fbdbd2d29dc1219ee3217023ca48aebd3787 AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist packages/contracts/dist

USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/entrypoint.js"]
