#!/bin/bash
# Re-attach the image names running containers were started from.
#
# `docker image prune -a` (the disk guard) can strip a name from an image a
# running container still uses: the image stays, its name goes. The next
# `docker compose up -d` then tries to pull that name, and for an image the
# registry no longer serves anonymously (minio/minio, October 2026) the whole
# deploy fails. Tagging the container's own image with its own name again
# changes nothing about what runs, so compose recreates nothing.
set -u
for c in $(docker ps -q); do
  ref=$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null) || continue
  case "$ref" in '' | sha256:*) continue ;; esac
  docker image inspect "$ref" >/dev/null 2>&1 && continue
  id=$(docker inspect -f '{{.Image}}' "$c" 2>/dev/null) || continue
  if docker tag "$id" "$ref"; then
    echo "restored image name $ref (${id#sha256:})"
  fi
done
