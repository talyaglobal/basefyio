#!/usr/bin/env bash
# Generate the MongoDB replica-set keyfile, once.
#
# A replica set with authentication enabled requires every member to share a
# keyfile. We run a single-node set purely so the oplog exists — that oplog is
# what point-in-time recovery replays — but Mongo still demands the keyfile.
#
# Safe to re-run: it never overwrites an existing keyfile, because replacing it
# would lock the running set out of itself.
set -euo pipefail

KEYFILE="${1:-./secrets/mongo-keyfile}"

if [ -f "$KEYFILE" ]; then
  echo "Keyfile already exists at $KEYFILE — leaving it untouched."
  exit 0
fi

mkdir -p "$(dirname "$KEYFILE")"
openssl rand -base64 756 > "$KEYFILE"
chmod 400 "$KEYFILE"

# Mongo refuses a keyfile that is group/world readable. Inside the container the
# file is copied and chowned to the mongodb user by the service command.
echo "Created $KEYFILE (mode 400)."
