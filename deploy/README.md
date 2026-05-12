# deploy/

End-to-end deploy tooling for zkScatter. Frontend → Firebase Hosting (free),
backend (shared-orderbook + zk-relayer) → a single GCP e2-micro VM in
`us-central1` (Always Free tier).

```
deploy/
├── firebase/       Static site deploy wrapper (5 sites)
├── gcp/            GCP project bootstrap + VM lifecycle
├── ci/             Build, push, deploy, rollback container images
└── runtime/        docker-compose stack that runs *inside* the VM
```

## Cost target

| Component | Where | Monthly |
| --- | --- | --- |
| Pay / Pro / Hub / Docs / Drop | Firebase Hosting (Spark) | $0 |
| shared-orderbook + zk-relayer | GCP e2-micro `us-central1` | $0 (free tier) |
| Static external IP | GCP | ~$1.50 |
| Cloud Logging / Monitoring | GCP free tier | $0 |
| Domain DNS | Cloudflare | $0 |
| **Total** | | **~$1.50 / mo** |

## One-time setup

```bash
# 0. log in
gcloud auth login
gcloud config set project zkscatter

# 1. enable APIs, create Artifact Registry, service account, Secret Manager
./gcp/bootstrap.sh

# 2. push the relayer signing key to Secret Manager
./gcp/secrets-set.sh ~/path/to/relayer.key

# 3. set a budget alarm (optional but recommended)
./gcp/budget-alert.sh           # picks ~$1 worth in the billing currency
# or specify an amount: ./gcp/budget-alert.sh 5000   (in billing currency)

# 4. build & push the initial images
./ci/build-and-push.sh

# 5. configure the VM bringup, then create it
cp gcp/deploy.env.example gcp/deploy.env
# … edit deploy.env: RPC_URL, contract addresses, CORS_ORIGINS …
./gcp/vm-create.sh
```

After `vm-create.sh` finishes, the VM boots, fetches secrets, pulls the
images, and starts the runtime stack automatically. Check progress:

```bash
gcloud compute instances get-serial-port-output zkscatter-node \
  --zone us-central1-a | tail -200
```

Once the stack is healthy, the relayer is reachable at:

```
http://<EXTERNAL_IP>:4000   shared-orderbook
http://<EXTERNAL_IP>:3002   zk-relayer
```

## Day-to-day operations

| Task | Command |
| --- | --- |
| Build + push new images | `./ci/build-and-push.sh` |
| Build only one service | `./ci/build-and-push.sh zk-relayer` |
| Deploy a tag to the VM | `./ci/deploy.sh sha-abcdef1` |
| List tags in Artifact Registry | `./ci/list-tags.sh` |
| Roll back | `./ci/rollback.sh sha-previoussha` |
| Tail VM logs (SSH) | `gcloud compute ssh zkscatter-node --zone us-central1-a` then `cd /var/lib/zkscatter/runtime && ./logs.sh` |
| Restart on VM | re-run startup: `sudo google_metadata_script_runner startup` |
| Destroy VM | `./gcp/vm-destroy.sh` |
| Deploy a frontend site | `./firebase/deploy.sh pay` |
| Deploy all 5 frontends | `./firebase/deploy.sh` |

## Adding a domain (later)

Once a domain is ready and DNS A records for `orderbook.<DOMAIN>` and
`zk.<DOMAIN>` point at the VM's external IP:

```bash
gcloud compute instances add-metadata zkscatter-node \
  --zone us-central1-a \
  --metadata domain=zkscatter.example,acme-email=ops@zkscatter.example

# Restart the stack so the TLS overlay activates
gcloud compute ssh zkscatter-node --zone us-central1-a \
  --command 'sudo google_metadata_script_runner startup'

# Close the direct-port firewall once TLS is verified
gcloud compute firewall-rules delete zkscatter-direct
```

Caddy obtains Let's Encrypt certs on first start.

## Circuits / ZK assets

`zk-relayer` mounts `${CIRCUITS_BUILD_DIR}` (defaults to
`/var/lib/zkscatter/circuits/build` on the VM) read-only. Populate it before
first start, e.g. by rsync:

```bash
rsync -av --delete circuits/build/ \
  zkscatter-node:/var/lib/zkscatter/circuits/build/
```

A follow-up task will switch this to a GCS-backed asset pipeline so the
VM startup can self-hydrate.

## Backup

SQLite dumps land in named Docker volumes (`orderbook-data`,
`zk-relayer-data`). The simplest backup loop:

```bash
gcloud compute ssh zkscatter-node --zone us-central1-a --command '
  set -e
  for v in orderbook-data zk-relayer-data; do
    docker run --rm -v "$v":/data alpine \
      tar -C / -czf - data \
      > /tmp/"$v"-$(date +%F).tar.gz
  done
'
# Pull off the host or push to GCS
```

Automate via a Cloud Scheduler + Pub/Sub job later.

## Troubleshooting

**VM stuck on startup:**
`gcloud compute instances get-serial-port-output zkscatter-node --zone us-central1-a | tail -300`

**Image pull fails on the VM:**
The VM's service account needs `roles/artifactregistry.reader`. `bootstrap.sh`
grants it; re-run if you destroyed and recreated the SA.

**Health checks failing:**
SSH in, `cd /var/lib/zkscatter/runtime`, then `./logs.sh zk-relayer`.

**Out of memory on e2-micro:**
e2-micro caps at 1 GB RAM. Monitor with `docker stats` over SSH. If both
services together push past ~700 MB resident, upgrade to e2-small:
`gcloud compute instances set-machine-type zkscatter-node --machine-type e2-small --zone us-central1-a`
(stop the VM first).

## What this deploy intentionally does NOT do

- No Kubernetes / GKE. One VM is enough at this scale.
- No P2P relayer mesh. The shared orderbook does the coordination.
- No CI on GitHub Actions yet. Run the scripts manually until the cadence
  warrants automation.
- No multi-region. `us-central1` only.
- No TUI / web dashboard for relayer operators. Plain logs + HTTP `/health`.
