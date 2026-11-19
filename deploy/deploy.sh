#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
image="${1:?Pass the immutable GHCR image digest}"
[[ "$image" =~ ^ghcr.io/onicyborg/bilcode-project-monitoring-be@sha256:[a-f0-9]{64}$ ]] || { echo "Invalid backend image reference" >&2; exit 1; }
test -s .env.next
exec 9>.deploy.lock
flock -w 300 9
umask 077
docker network inspect bilcode-monitoring-services >/dev/null 2>&1 || docker network create bilcode-monitoring-services >/dev/null 2>&1 || docker network inspect bilcode-monitoring-services >/dev/null
had_env=false
if [[ -f .env ]]; then cp -p .env .env.previous; had_env=true; fi
mv .env.next .env
previous=""
if [[ -f .deployment.env ]]; then previous=$(cat .deployment.env); fi
printf 'API_IMAGE=%s\n' "$image" > .deployment.env
compose=(docker compose --env-file .deployment.env -f docker-compose.yml)
restore() {
  if $had_env; then cp -p .env.previous .env; fi
  if [[ -n "$previous" ]]; then
    printf '%s\n' "$previous" > .deployment.env
    "${compose[@]}" up -d --no-deps --wait --wait-timeout 90 api || true
  fi
}
trap 'status=$?; trap - ERR; restore; exit "$status"' ERR
"${compose[@]}" pull api
"${compose[@]}" run --rm --no-deps api pnpm db:migrate
"${compose[@]}" up -d --no-deps --wait --wait-timeout 120 api
trap - ERR
echo "Backend deployment healthy. Neon database migrations applied."
