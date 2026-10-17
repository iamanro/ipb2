# syntax=docker/dockerfile:1
#
# Multi-stage build: `builder` bundles the client with Bun (`bun build.ts`);
# `runtime` ships only `dist/`, the server, and the exact `src/*`
# files the server imports.
#
# Base image: Bun on Debian slim. The server runs on Bun directly (`.ts`
# files, `node:sqlite`'s `DatabaseSync` through Bun's Node compatibility);
# `bun test` and `bun server/index.ts` both pass against this version. arm64:
# `oven/bun` publishes linux/arm64 images and every dependency here ships
# arm64 binaries — untested on real arm64 hardware in this environment.

FROM oven/bun:1.4.3-slim AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun build.ts

FROM oven/bun:1.4.3-slim AS runtime
ENV NODE_ENV=production \
    IPB_HOST=0.0.0.0 \
    IPB_PORT=8000 \
    IPB_AUTH=on \
    IPB_DATA_ROOT=/data \
    IPB_STATE_ROOT=/state
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && rm -rf ~/.bun/install/cache

COPY --from=builder /app/dist ./dist
COPY server ./server
COPY modules/equipment/server ./modules/equipment/server
COPY modules/exercise/server ./modules/exercise/server
COPY modules/ipb/server ./modules/ipb/server
COPY modules/orbat/server ./modules/orbat/server
COPY modules/terrain/server ./modules/terrain/server
COPY src/dtg.js src/geo.js src/areaPolygon.js ./src/
COPY src/symbols/sidc.js src/symbols/symbology.js src/symbols/unitProperties.js ./src/symbols/

RUN mkdir -p /data /state && chown -R bun:bun /app /data /state
USER bun

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.IPB_PORT||8000)+'/healthz').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"

CMD ["bun", "server/index.ts"]
