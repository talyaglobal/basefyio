# k3s tenant infrastructure (design, Phase 1 not started)

Status: **design only. No cluster exists and nothing here has been applied.**
This file is the handoff for the DevOps work. Vocabulary: always say **tenant**. A tenant is an **organization**.

## Goal

Kubernetes is a product feature, not how we run our own apps. In a k3s cluster, every new tenant gets:

1. A **shared compute area** with its own CPU, RAM and disk allowance.
2. Its **own S3 storage area** on SeaweedFS:
   - non-enterprise tenant: an isolated **bucket** on a shared SeaweedFS server;
   - enterprise tenant: an isolated **SeaweedFS server** in the tenant's own namespace.

Traffic is separated by one load balancer with hostname routing, not by per-tenant hardware.
Cost matters: do not build anything that cannot pay for itself.

## Design

### Compute: one namespace per tenant on shared nodes

- Namespace `t-<tenant id>` (the organization's public id).
- `ResourceQuota` (CPU, memory, ephemeral storage, volume storage, pod count, no LoadBalancer or NodePort services),
  `LimitRange` (defaults), default-deny `NetworkPolicy` plus a baseline policy.
  See [tenant-namespace.yaml](tenant-namespace.yaml); render it with `envsubst`.
- Per-namespace `ServiceAccount` with no cluster rights. No node per tenant.
- **Disk:** k3s `local-path` storage does not enforce volume size. Use **Hetzner CSI** volumes for real limits
  (check the minimum volume size and cost before sizing quotas). Keep tenant data in S3 where possible.
- The namespace runs the platform services (RAG, vector DB, agent runtime, LLM gateway) and, where the plan allows,
  the tenant's own containers.

### Storage: SeaweedFS

| Tenant plan | Storage |
|---|---|
| Non-enterprise | A bucket on the shared SeaweedFS cluster, an S3 identity scoped to that bucket, a size quota. |
| Enterprise | A SeaweedFS server (master, volume, filer, S3; a single `weed server -s3` pod for a small tenant) in the tenant's namespace, its own volume and credentials. |

Credentials are per tenant and stored as Kubernetes `Secret`s. The shared SeaweedFS is reachable only from tenant
namespaces through its S3 endpoint, never from the public internet.

### Traffic

One load balancer in front of the k3s ingress (Traefik ships with k3s), routing by hostname, wildcard TLS through
cert-manager. No load balancer per tenant.

### Platform access

The platform provisions tenants through the Kubernetes API with a **scoped ServiceAccount** (only `t-*` namespaces),
never cluster-admin. The kubeconfig is kept encrypted. Provisioning is idempotent (Server-Side Apply).

## Phases (each paid step needs owner approval)

| Phase | Work |
|---|---|
| 0 | Fix the plan limits table (CPU, RAM, disk, S3 quota per plan). **Open.** |
| 1 | Small k3s cluster (1 control plane, 2 small workers) in a **separate cloud project with its own token**. Apply the tenant template for one test tenant. Prove quota enforcement and tenant isolation. Record the real monthly cost. |
| 2 | Shared SeaweedFS, bucket per tenant, identity and quota. Prove a tenant cannot read another tenant's bucket or exceed its quota. |
| 3 | Enterprise tenant: SeaweedFS in the tenant namespace. |
| 4 | Load balancer, wildcard TLS, hostname routing (separate approval, paid). |
| 5 | Hand over to the platform API: scoped ServiceAccount, provisioning, monitoring and alerts. |

Do not build a multi-node HA control plane before the first paying tenant needs it.

## Rules

- Provider: Hetzner only. Build beside production, in a **separate Hetzner project and token**; never touch the
  production host, its volume or its services from this work.
- No secrets, kubeconfigs, tokens or real addresses in the repository.
- Every node with a volume needs its own disk guard or a disk alert; no silent full disk.

## Blocked on

A new Hetzner project and an API token limited to it, and the choice of server types (suggested start: 1 control
plane + 2 small workers, no load balancer yet; confirm current prices in the Hetzner console).

## Not verified yet

- SeaweedFS per-bucket quota and enforcement (`s3.bucket.quota`, `s3.bucket.quota.enforce`) and per-identity bucket scoping.
- Hetzner CSI minimum volume size and current prices.
- Whether the bundled Traefik fits wildcard and per-tenant routing.
- The template parses as valid YAML but has never been applied to a cluster.
