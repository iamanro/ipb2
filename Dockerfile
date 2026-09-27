# syntax=docker/dockerfile:1
#
# Multi-stage build: `builder` compiles the Vite client bundle and (in CI)
# runs the test suite against the image's own Node; `runtime` ships only
# `dist/`, the server, and the exact `src/*` files the server imports.
#
# Base image: Node 24 (Debian "bookworm" slim). The project targets Node's
# `node:sqlite` module; 24 LTS carries every option the code uses
# (`readOnly`, migrations via `PRAGMA user_version`) as a stable API, and
# `npx vp test run` / `node server/index.js` both pass against it (see
# README "Deployment" verification log). arm64: the same Dockerfile builds
# on `linux/arm64` unmodified — `node:24-bookworm-slim` and every npm
# dependency here ship arm64 binaries — only untested on real arm64
# hardware in this environment.

FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN node node_modules/.bin/vp build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    IPB_HOST=0.0.0.0 \
    IPB_PORT=8000 \
    IPB_AUTH=on \
    IPB_DATA_ROOT=/data \
    IPB_STATE_ROOT=/state
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY server ./server
COPY modules/equipment/server ./modules/equipment/server
COPY modules/exercise/server ./modules/exercise/server
COPY modules/ipb/server ./modules/ipb/server
COPY modules/orbat/server ./modules/orbat/server
COPY modules/terrain/server ./modules/terrain/server
COPY src/dtg.js src/geo.js src/areaPolygon.js ./src/
COPY src/symbols/sidc.js src/symbols/symbology.js src/symbols/unitProperties.js ./src/symbols/

RUN mkdir -p /data /state && chown -R node:node /app /data /state
USER node

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.IPB_PORT||8000)+'/healthz',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
