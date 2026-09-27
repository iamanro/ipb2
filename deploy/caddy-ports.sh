#!/bin/sh
# Recreates the caddy container when it runs without its published HTTPS
# port. That happens after a reboot when IPB_HTTPS_PORT binds a LAN address
# (e.g. 10.0.0.147:443) and Docker starts the container a moment before the
# network has that address: the container runs, but nothing reaches it.
# Run from a timer (docs/operator-runbook.md, "Reboots"); a no-op when fine.
set -eu
cd "$(dirname "$0")/.."
container=$(docker compose ps --status running -q caddy)
[ -n "$container" ] || exit 0
if [ -z "$(docker port "$container" 443/tcp 2>/dev/null)" ]; then
  echo "caddy is running without port 443: recreating it"
  docker compose up -d --force-recreate --no-deps caddy
fi
