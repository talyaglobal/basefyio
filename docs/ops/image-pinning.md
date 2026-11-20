# Image pinning

Every third-party image in `docker-compose.prod.yml` must name an exact version. A floating tag such as
`:latest` means an ordinary `docker compose up -d` can pull a different build than the one tested, and
it can fail outright when the registry stops serving that name (`minio/minio` stopped serving anonymous
pulls in October 2026).

**Rule: an upgrade is a change of the pin in git, reviewed and shipped like code. Never `:latest`, never
a pull by hand on the server.**

## What is pinned

| Service | Reference in `docker-compose.prod.yml` | Override |
|---|---|---|
| `pgbouncer` | `edoburu/pgbouncer:v1.25.1-p0@sha256:4a8371e79d6627e74f553d0aaa8e4c5ace20e30034fb296e569b71c89c99e108` | `PGBOUNCER_IMAGE` |
| `minio` | `ghcr.io/${GHCR_OWNER}/basefyio-minio:RELEASE.2025-09-07T16-13-09Z` (the production build mirrored to the basefyio registry; the deploy already logs in to it) | `MINIO_IMAGE` |
| `postgres` | **not yet**: `ghcr.io/${GHCR_OWNER}/basefyio-postgres:latest`. The digest line is prepared, commented out, directly above it | — |

The tag says which version it is; the digest (`@sha256:…`) makes it immutable. With both, Docker uses the
digest, so a re-pushed tag cannot change what runs.

The override variables still win when they are set in the env file. An installation that sets them
(the installer does, from `deploy/components.env`) is not moved by these defaults.

## What a pin change recreates

Compose recreates a container when its image reference string changes, even when the image content
is the same. So the change that introduces or moves a pin recreates exactly the services whose
reference changed, and nothing else:

| Service | Recreated | Expected blip |
|---|---|---|
| `pgbouncer` | yes | Every pooled client connection on port 6432 drops once; clients reconnect within seconds. The configuration lives in the `pgbouncer_config` volume and is rewritten by the API, so nothing is lost. Direct API connections to Postgres are unaffected. |
| `minio` | yes | Object storage requests fail for the few seconds MinIO takes to restart; data is in the `minio_data` volume. |
| `postgres` | **no** | The postgres reference is not touched by this change. |
| `keycloak` | **no** | Keycloak depends only on `postgres`, which is unchanged, so no user is logged out. |

`platform-api` lists `minio` under `depends_on` with `condition: service_started`; recreating MinIO does
not recreate the API. Every deploy already recreates the API for its new `IMAGE_TAG`.

Ship a pin change as its own small release, not bundled with application changes, so the one
PgBouncer reconnect is easy to attribute.

### The Postgres pin (feedback #202, part B)

Switching `postgres` from `:latest` to the digest recreates Postgres, and the Keycloak restart that
follows through `depends_on` logs every user out once. It therefore ships only inside the planned
maintenance window (MW-1) together with the other Postgres-restarting changes. In that window: swap the
commented digest line and the active `:latest` line, confirm the digest is still the `RepoDigests`
entry of the running image (not its image ID), and point `PITR_POSTGRES_IMAGE` at the same reference.
A future replica must pull exactly that digest.

## Rollback

Revert the commit (or set `PGBOUNCER_IMAGE` / `MINIO_IMAGE` in the env file to the previous reference)
and deploy again. The rollback recreates the same services with the same blips. The previous image is
still on the host unless it was pruned; for `minio`, only a registry-served reference can be pulled
again, so never roll back to `minio/minio:latest` on a host that no longer has that image locally.

## Upgrading a pinned image

1. Pick the new release tag and read its changelog (for PgBouncer: configuration keys the API writes,
   `auth_type = plain`, the admin console commands the API uses).
2. Resolve its digest (`docker buildx imagetools inspect <image>:<tag>`) and write both into the compose
   default and into `deploy/components.env`.
3. Run the self-host acceptance workflow and the verification tests, then ship it on its own.

Dependabot (`.github/dependabot.yml`) opens pull requests for the Dockerfile base images. A
`renovate.json` holds the matching rules for the pinned compose defaults and `deploy/components.env`;
it does nothing until the Renovate app is installed on the repository. Neither merges anything by
itself: every bump is reviewed, and a bump of `docker/postgres/Dockerfile` waits for a maintenance
window because it rebuilds the cluster image.
