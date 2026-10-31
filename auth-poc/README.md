# Two identities, one API

A minimal TypeScript/Express POC: users present Entra-compatible delegated JWTs;
the reporting worker presents a Kubernetes ServiceAccount token. No real tenant,
cloud account, database, service mesh, login UI, or MSAL is needed.
The optional [Azure Windows deployment](#windows-on-azure-aks) requires an Azure subscription.

```mermaid
flowchart LR
  User[Host token script] -->|HTTPS / seeded user| Entra[Entra Local]
  User -->|User access token| API[Express API]
  Worker[Reporting worker] -->|Projected ServiceAccount token| API
  API -->|HTTPS / trusted certificate / JWKS| Entra
  API -->|TokenReview / in-cluster credentials| K8s[Kubernetes API]
```

## Prerequisites and start

- Docker running (Docker Desktop on macOS/Windows; Linux containers).
- `kind`, `kubectl`, Node.js LTS (22.12+; containers use Node 24), and pnpm 10.
- Available loopback ports **3000** and **8443**.
- Internet access to the package/container registries.

Run from this directory (`auth-poc/`):

```sh
pnpm install
pnpm build
pnpm test
pnpm run up
pnpm smoke
```

**Use `pnpm run up`, not `pnpm up`: pnpm reserves `up` as its built-in dependency
update alias.** The workspace provides the requested `up` script, but pnpm cannot
dispatch it without `run`. Other scripts can use their short names.

The cross-platform Node lifecycle scripts create/reuse the dedicated kind cluster
`identity-poc`, pull the official Entra Local image, build/load both applications,
deploy the manifests, export the emulator's public TLS certificate, and wait for
readiness. No Bash, hosts-file changes, host networking, or manually maintained
port-forward processes are required. Do not reuse an unrelated cluster with this
name; an existing cluster must have the port mappings created by this script.

Kubeconfig and the trusted certificate are generated under ignored `.local/`.
Commands below explicitly target this kubeconfig rather than changing your
current Kubernetes context.

## Try it

The API exposes public `GET /health`, and protected `GET /whoami` and `GET /data`.
`/data` contains three products with total quantity 25.

```sh
curl -i http://localhost:3000/whoami
# 401
pnpm --silent token
# Prints only a real RS256-signed delegated access token.
```

Copy the printed token into the Authorization header of a request to
`http://localhost:3000/whoami`, using the `Bearer` authentication scheme.
For example, in a POSIX shell:

```sh
TOKEN="$(pnpm --silent token)"
SCHEME='Bearer'
curl -H "Authorization: $SCHEME $TOKEN" http://localhost:3000/whoami
curl -H "Authorization: $SCHEME $TOKEN" http://localhost:3000/data
```

In PowerShell:

```powershell
$token = pnpm --silent token
$scheme = 'Bearer'
Invoke-RestMethod http://localhost:3000/whoami -Headers @{ Authorization = "$scheme $token" }
```

The response is a `user` principal with `provider: "entra"`, a subject, and an
optional name. The API requires the exact configured issuer/audience, a valid
RS256 signature, expiration, and delegated `access_as_user` scope. ID tokens do
not satisfy the audience/scope requirements.

### Entra Local compatibility note

We inspected the upstream [README](https://github.com/cmaneu/entra-local),
[token configuration](https://github.com/cmaneu/entra-local/blob/v0.1.1/docs/token-configuration.md),
container setup, and token-generation implementation.
Entra Local 0.1.1's existing
`POST /admin/api/apps/{appId}/token-generate` endpoint signs access tokens with
**empty `scp`** and an API-URI audience. They cannot pass delegated scope
validation; adding a scope field to that request is not supported.

Rather than weaken authentication or change upstream, `pnpm token` scripts the
emulator's supported authorization-code + PKCE flow with seeded Bob, the
`local-web-client`, and `local-api`. It captures the authorization redirect
without opening a browser or running a callback server. It requests
`api://cccccccc-0000-0000-0000-000000000007/access_as_user`, yielding the API's
GUID audience and `scp: "access_as_user"`. No real credentials are involved.

The admin generator is used directly for negative examples:

```sh
pnpm --silent token expired
pnpm --silent token invalidSignature
pnpm --silent token idToken
pnpm --silent token unscoped
```

Each prints a token rejected with 401. Admin-generated access tokens also have a
different audience and no delegated scope, so their rejection alone does not
isolate expiration/signature checking; unit tests exercise those checks using
otherwise valid claims.

### Worker and rejected Kubernetes tokens

```sh
kubectl --kubeconfig .local/kubeconfig -n identity-poc logs deployment/reporting-worker -f
```

Every 30 seconds the worker rereads its read-only projected token file, calls
both protected endpoints, and prints its `service` principal and report.
The token requests audience `urn:identity-poc:api` and a 3600-second lifetime;
Kubernetes handles projection and rotation. No default API token is mounted in
the worker and it has no RBAC bindings.

Generate test tokens with:

```sh
# Authorized worker, correct audience -> 200
kubectl --kubeconfig .local/kubeconfig -n identity-poc create token reporting-worker --audience=urn:identity-poc:api --duration=10m
# Worker, wrong audience -> 401
kubectl --kubeconfig .local/kubeconfig -n identity-poc create token reporting-worker --audience=wrong-audience --duration=10m
# Valid token, unauthorized ServiceAccount -> 403
kubectl --kubeconfig .local/kubeconfig -n identity-poc create token api --audience=urn:identity-poc:api --duration=10m
```

Use the printed value in the same Authorization header as above.
`pnpm smoke` automates all five scenarios against **both endpoints**, uses the
worker's actual projected token for the success case, checks negative Entra
variants, verifies worker reporting, and confirms the worker cannot create
TokenReviews. It needs the local cluster administrator privileges in the
generated kubeconfig to mint the negative test tokens and check RBAC.

## Networking, TLS, and the two trust models

Both services run inside kind. Docker port mappings expose only loopback
`http://localhost:3000` and `https://localhost:8443`. Worker traffic stays on
`http://api.identity-poc.svc.cluster.local:3000`.

The token issuer is exactly:

```text
https://localhost:8443/11111111-1111-1111-1111-111111111111/v2.0
```

That is an **identity string**, not an address the API tries to contact.
The API fetches JWKS separately at
`https://entra-local.identity-poc.svc.cluster.local:8443/11111111-1111-1111-1111-111111111111/discovery/v2.0/keys`.
Entra Local's `PUBLIC_ORIGIN` gives its generated certificate the internal DNS
name; its `ISSUER` sets the exact external issuer above. Its certificate also
covers `localhost`. Therefore host and Pod networking never assume that a Pod's
`localhost` is the host.

Setup exports the generated self-signed public certificate through `kubectl exec`
over the authenticated Kubernetes control channel. The API mounts it via a
ConfigMap and trusts it with `NODE_EXTRA_CA_CERTS`. Host token requests explicitly
use that certificate as their trust anchor. No TLS verification is disabled.
Entra Local calls it a CA certificate, though it is actually a self-signed
server certificate. `pnpm run up` refreshes trust and restarts the API after
redeployments; emulator data and signing keys are intentionally ephemeral.

- **Entra verification:** `jose` verifies JWTs locally with cached public JWKS
  keys, configured issuer/audience, expiration, and delegated scope. Configure
  `ENTRA_ISSUER`, `ENTRA_AUDIENCE`, and `ENTRA_JWKS_URL` to change provider details.
- **Kubernetes verification:** the API uses its in-cluster credentials and the
  Kubernetes TokenReview API with an explicit requested audience. It requires
  `authenticated: true`, the returned expected audience, and exactly
  `system:serviceaccount:identity-poc:reporting-worker`. Only the API can create
  TokenReviews. Invalid reviews, wrong audiences, and review outages fail closed
  with 401; authenticated but disallowed identities get 403.

The unverified issuer only routes to one validator. It never establishes trust;
an Entra validation failure does not fall back to Kubernetes.

## Windows on Azure (AKS)

This optional path tests **both the API and reporting worker on Windows**, including
the API's in-cluster TokenReview credentials and the worker's projected, rotating
ServiceAccount token. It is not a Windows-only cluster: AKS requires a Linux
system pool, which also runs the Linux-only Entra Local emulator.

### Prerequisites

- An Azure subscription with quota for one Linux VM (`Standard_D2s_v5`) and one
  Windows VM (`Standard_D4s_v5`), plus temporary capacity during node upgrades.
  **These resources cost money**, including idle VMs, disks, ACR storage, and
  outbound networking. The AKS Free tier does not make the worker nodes free.
- Permission to create a dedicated resource group, AKS, and ACR, and assign
  `AcrPull` to the kubelet managed identity (for example, subscription Owner).
  The signed-in identity also needs ACR push and AKS credential access.
- A **Windows Server 2025 x64 build host with a Windows container Docker engine**,
  or a compatible Windows development host using Hyper-V isolation. Linux Docker,
  WSL's Linux engine, and the default Linux Docker Desktop mode cannot build these
  images. Check that `docker info --format '{{.OSType}}'` prints `windows`.
- PowerShell **7.4+**, Azure CLI **2.60+** with Bicep installed, `kubectl` with
  Kustomize support, and Node.js **22.12+**. pnpm is needed for local unit tests,
  not for the Azure setup/smoke scripts.
- Access to Azure, MCR, GHCR, nodejs.org, and npm registries, sufficient disk space
  for multi-gigabyte Windows images, and free localhost ports **3000** and **8443**.

The node pool uses `Windows2025`, the images use `servercore:ltsc2025`, and the
overlay selects Windows build `10.0.26100`. Keep these aligned if changing the OS.
Choose an AKS Kubernetes version **1.32 or later** supported in your region for
Windows2025; don't assume that an old version remains available. See Microsoft's
[Windows AKS guidance](https://learn.microsoft.com/azure/aks/windows-best-practices)
and [Windows container compatibility](https://learn.microsoft.com/virtualization/windowscontainers/deploy-containers/version-compatibility).

### Provision and deploy

Run in PowerShell from `auth-poc/`:

```powershell
az login
az account set --subscription "<your-subscription-id>"
az bicep install
az aks get-versions --location eastus --output table
$version = Read-Host "Supported Kubernetes version from the list"
$rg = "identity-poc-windows-test" # Dedicated to this disposable demo
./scripts/azure-up.ps1 -ResourceGroup $rg -Location eastus -KubernetesVersion $version
./scripts/azure-smoke.ps1
```

Setup prompts securely for a Windows node administrator password. Use a unique
14–123 character password meeting AKS complexity rules (three of lowercase,
uppercase, digits, symbols), and reuse it for redeployment. The Bicep parameter is
secure; the script passes it through a temporary process environment variable,
not command-line arguments or a checked-in parameter file. Do not enable shell
tracing/debug logging or commit credentials.

`infra/azure.bicep` provisions a one-node Linux system pool, a tainted one-node
Windows user pool, Azure CNI Overlay, and an admin-disabled Basic ACR with
managed-identity pulls. `infra/azure.bicepparam` supplies the prompted password
and selected Kubernetes version. You can override `-ClusterName`, `-LinuxVmSize`,
and `-WindowsVmSize` on the setup script when needed for regional availability.
This intentionally small cluster is not highly available or production hardened.

Setup builds the `api` and `worker` targets in `Dockerfile.windows`, pushes
timestamp-tagged images to ACR, renders `infra/kustomization.yaml`, and applies
it. Node 24 is installed from its official Windows archive with SHA-256
verification. Both containers run as `ContainerUser`; unsupported Linux security
context fields are removed by the overlay. Windows image downloads and initial
node provisioning can take tens of minutes.

The existing namespace, ServiceAccounts, TokenReview RBAC, audience, and token
lifetime are reused unchanged. The worker explicitly reads
`C:/var/run/api-token/token`. The API uses the standard auto-mounted Kubernetes
credentials (the client library's `/var/run/secrets/...` resolves on the `C:`
drive in this image). Entra's public certificate is exported over the Kubernetes
control channel and mounted at `C:/etc/entra/ca.pem`; TLS validation stays enabled.

All generated manifests, the certificate, logs, and the dedicated kubeconfig go
under ignored `.azure/`, which is also excluded from the Docker build context.
The scripts always specify context `identity-poc-azure` and never change your
default kubeconfig. Local Kind still uses `.local/`.

### Verify and troubleshoot

`azure-smoke.ps1` starts **127.0.0.1-only** port forwards, runs the existing smoke
suite, and stops its forwarding processes even when tests fail. It also checks
the nodes' OS and `process.platform` in both applications, so a successful Linux
deployment cannot masquerade as a Windows test. Expected results include:

- Windows placement for both applications, and a public healthy API.
- Missing token → 401; projected worker token → 200 on both protected endpoints.
- Wrong workload audience → 401; a valid but unauthorized ServiceAccount → 403.
- Delegated Entra user → 200; invalid Entra variants → 401.
- Worker logs a service identity and total quantity 25, and cannot create TokenReviews.

The kubeconfig needs cluster-admin-equivalent permissions for the smoke test's
token creation, node inspection, exec, and RBAC impersonation checks. This tests
**Kubernetes ServiceAccounts**, not Windows domain accounts/gMSA or Azure Workload
Identity. It verifies a real projected token; observe the worker for over an hour
if you also want to exercise token rotation across expiry.

```powershell
$k = @("--kubeconfig", ".azure/kubeconfig", "--context", "identity-poc-azure")
kubectl @k get nodes -L kubernetes.io/os,node.kubernetes.io/windows-build
kubectl @k -n identity-poc get pods -o wide
kubectl @k -n identity-poc logs deployment/reporting-worker --tail=20
kubectl @k -n identity-poc get events --sort-by=.lastTimestamp
```

For `ImagePullBackOff`, check the ACR image/tag and kubelet `AcrPull` assignment;
new role assignments can take several minutes to propagate. For pending Pods,
check VM quota/capacity, node readiness, Windows build labels, and taints. For
image OS mismatch errors, use a matching Windows build host and rebuild both
targets. For port-forward failures, stop local Kind or other listeners on 3000/
8443 and inspect `.azure/*-forward.err`. Rerunning setup refreshes certificate
trust and restarts the applications; it does not delete the cluster.

Both Services are **ClusterIP**, with no public ingress or NodePort. Never expose
Entra Local's unauthenticated admin API. AKS's control-plane endpoint is public
and authenticated; the dedicated kubeconfig is sensitive. Application traffic
within this isolated lab remains HTTP, not production-grade transport security.

Local validation (no Azure resources needed; `kubectl` is needed by overlay tests):

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
az bicep build --file infra/azure.bicep --stdout
kubectl kustomize infra
```

### Azure cleanup

Delete **only the dedicated demo resource group** after testing. This destroys
the cluster, workloads, and registry; AKS also removes its managed node resource
group. Wait for deletion to finish and verify both groups are gone.

```powershell
az group delete --name $rg --yes
Remove-Item -Recurse -Force .azure
```

Built Windows images remain on your build host. `pnpm down` only deletes Kind,
not Azure resources, and leaves `.azure/` intact. The Azure smoke script restores
its `IDENTITY_POC_TARGET` environment setting on exit.

## Cleanup (local Kind)

```sh
pnpm down
```

Deletes the **entire dedicated `identity-poc` kind cluster**, including its RBAC,
workloads, and emulator data, and removes `.local/`. Built Docker images remain
in the local image cache.

## Security limitations

**Entra Local is an intentionally insecure development emulator. Never expose it
publicly or use it for production identity validation.** Its unauthenticated admin
API can mint tokens and its seeded identities are public test data.

HTTP is acceptable only in this isolated demonstration. **Use TLS to protect
bearer tokens in production**, including worker-to-API traffic. Tokens must not
be logged, committed, or shared. The emulator's certificate and local kubeconfig
are development artifacts, not production trust infrastructure.

The API uses a basic per-IP in-memory limit of 120 requests/minute to bound
authentication requests; `/health` is exempt. It is not a distributed limiter.
This POC omits production authorization policies, resource
isolation/network policies, high availability, and production credential
management. The API has a cluster-scoped TokenReview permission (only `create`
on `tokenreviews`); guard that identity in real deployments. A slow/unavailable
TokenReview is rejected rather than bypassed. For a real tenant, configure its
issuer, API audience, and HTTPS JWKS URL and remove emulator trust.
