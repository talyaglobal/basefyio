# Docker Provider — Usage Example

## Overview

The Docker provider is bundled with the platform and requires no additional installation. It communicates with the Docker daemon on the local host via the Docker Engine API. The daemon must be running before any operation is executed; the provider's `healthCheck()` calls `docker info` to verify connectivity.

---

## Verify the Provider Is Available

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  https://api.basefyio.io/v1/provisioning/providers | jq '.[] | select(.provider == "docker")'
```

Expected output includes `"healthy": true` and the `supportedResources` list (container, volume, network).

---

## Step 1 — Create a Provisioning Project

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "provider": "docker",
    "region": "local",
    "credentialRefId": "cred_01j8..."
  }' \
  https://api.basefyio.io/v1/provisioning/projects
```

For the Docker provider `region` should be `"local"`. `credentialRefId` is optional if the daemon socket is available at the default path (`/var/run/docker.sock`).

---

## Step 2 — Create an Operation

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provisioningProjectId": "ppj_01j9...",
    "type": "APPLY",
    "dryRun": false,
    "desiredSpec": {
      "containers": [
        {
          "name": "my-app",
          "image": "nginx:alpine",
          "ports": [
            { "hostPort": 8080, "containerPort": 80 }
          ]
        }
      ]
    }
  }' \
  https://api.basefyio.io/v1/provisioning/operations
```

Set `"dryRun": true` to validate the spec without starting any containers.

---

## Step 3 — Execute the Operation

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  https://api.basefyio.io/v1/provisioning/operations/op_01j9.../execute
```

The operation moves to `RUNNING` immediately and completes asynchronously.

---

## Step 4 — Watch Progress

```bash
basefyio operations watch op_01j9...
```

The CLI polls the status endpoint and streams status changes to the terminal until the operation reaches a terminal state (`COMPLETED`, `FAILED`, or `CANCELLED`).

---

## Step 5 — View Events

```bash
basefyio operations logs op_01j9...
```

Outputs all lifecycle events in chronological order. Use `--follow` to tail events while the operation is still running.

---

## Step 6 — Inspect Provisioned Resources

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.basefyio.io/v1/provisioning/resources?projectId=ppj_01j9..." | jq .
```

Each entry in the response corresponds to a container, volume, or network created by the operation, including its current `status` and provider-specific `metadata`.

---

## Switching to a Different Provider Later

To migrate a provisioning project from Docker to Hetzner (or any other registered provider):

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "provider": "hetzner" }' \
  https://api.basefyio.io/v1/provisioning/projects/ppj_01j9.../provider
```

Existing `ProvisionedResource` rows are retained for audit purposes. Resources on the old provider are not automatically destroyed — run a `DESTROY` operation first if cleanup is required.

---

## E2E Smoke Test Guard

The Docker provider e2e tests call `docker info` before running. If the Docker daemon is unavailable the entire Docker suite is **skipped** (not failed), so CI passes on machines without Docker.

To run the Docker tests locally:

```bash
# Ensure Docker is running, then:
pnpm test:e2e --filter=docker
```

To force-skip even when Docker is available (e.g., in a restricted CI job):

```bash
SKIP_DOCKER_TESTS=true pnpm test:e2e
```
