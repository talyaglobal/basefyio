#!/usr/bin/env bash
# Bundle every image a compose file resolves to into one tarball, for an
# air-gapped install.
#
# Run this on a machine that can reach the registries:
#   ./scripts/bundle-images.sh                                   # docker-compose.yml, default profile
#   ./scripts/bundle-images.sh --profile tls -o /tmp/basefyio-images.tar.gz
#   ./scripts/bundle-images.sh -f docker-compose.prod.yml --env-file .env.production
#
# Services declared with `build:` are built first so their images exist, named
# under COMPOSE_PROJECT_NAME (default: basefyio). Load the bundle on the offline
# host with the same project name or the names will not match. Every resolved
# image is then pulled if absent and written with `docker save`, next to a
# manifest of what the tarball holds and a sha256 to verify the transfer.
#
# scripts/load-images.sh restores the bundle on the offline host.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: scripts/bundle-images.sh [-f compose-file] [--env-file file] [--profile name]... [-o out.tar.gz] [--no-pull]

  -f, --file       compose file to resolve images from   (default: docker-compose.yml)
      --env-file   env file for compose interpolation     (default: compose's own .env lookup)
      --profile    activate a compose profile; repeatable (e.g. --profile tls)
  -o, --out        output tarball                         (default: basefyio-images-YYYYMMDD.tar.gz)
      --no-pull    fail instead of pulling an image that is not present locally
EOF
  exit "${1:-0}"
}

COMPOSE_FILE="docker-compose.yml"
ENV_FILE=""
OUT=""
PULL=1
PROFILES=()

while [ $# -gt 0 ]; do
  case "$1" in
    -f|--file)   COMPOSE_FILE="$2"; shift 2 ;;
    --env-file)  ENV_FILE="$2"; shift 2 ;;
    -o|--out)    OUT="$2"; shift 2 ;;
    --profile)   PROFILES+=("$2"); shift 2 ;;
    --no-pull)   PULL=0; shift ;;
    -h|--help)   usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done

[ -f "$COMPOSE_FILE" ] || { echo "compose file not found: $COMPOSE_FILE" >&2; exit 1; }

# Images built from `build:` services are named after the project; fix the
# name so the offline host, loading with the same value, resolves them.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-basefyio}"

compose() {
  local args=(-f "$COMPOSE_FILE")
  [ -n "$ENV_FILE" ] && args+=(--env-file "$ENV_FILE")
  local p
  for p in ${PROFILES[@]+"${PROFILES[@]}"}; do args+=(--profile "$p"); done
  docker compose "${args[@]}" "$@"
}

# A service with a build: section has no registry image to pull; build it so
# the name `config --images` reports actually exists locally.
if compose config 2>/dev/null | grep -qE '^[[:space:]]+build:'; then
  echo "==> Building services declared with build: (project: $COMPOSE_PROJECT_NAME)"
  compose build
fi

echo "==> Resolving images from $COMPOSE_FILE"
mapfile -t IMAGES < <(compose config --images | sort -u)
if [ "${#IMAGES[@]}" -eq 0 ]; then
  echo "no images resolved — check the compose file and profiles" >&2
  exit 1
fi
printf '    %s\n' "${IMAGES[@]}"

for img in "${IMAGES[@]}"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    if [ "$PULL" = 1 ]; then
      echo "==> Pulling $img"
      docker pull "$img"
    else
      echo "image not present locally and --no-pull given: $img" >&2
      exit 1
    fi
  fi
done

OUT="${OUT:-basefyio-images-$(date +%Y%m%d).tar.gz}"
OUT_DIR="$(dirname "$OUT")"
OUT_NAME="$(basename "$OUT")"
LIST="${OUT%.tar.gz}.images.txt"
mkdir -p "$OUT_DIR"
printf '%s\n' "${IMAGES[@]}" > "$LIST"

echo "==> Saving ${#IMAGES[@]} image(s) to $OUT"
docker save "${IMAGES[@]}" | gzip -1 > "$OUT"
# Checksum by basename so it verifies wherever the files land on the other side.
(cd "$OUT_DIR" && sha256sum "$OUT_NAME" > "$OUT_NAME.sha256")

echo "==> Done"
echo "    bundle:   $OUT ($(du -h "$OUT" | cut -f1))"
echo "    manifest: $LIST"
echo "    checksum: $OUT.sha256"
echo "Copy all three to the offline host, then: scripts/load-images.sh $OUT_NAME"
