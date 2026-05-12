# deploy/runtime

Self-contained docker compose stack that runs on a single VM (GCP e2-micro target).

## Layout

| File | Role |
| --- | --- |
| `compose.yml` | shared-orderbook + zk-relayer, ports exposed directly |
| `compose.tls.yml` | overlay that adds Caddy with auto Let's Encrypt |
| `Caddyfile` | subdomain routing (`orderbook.<DOMAIN>`, `zk.<DOMAIN>`) |
| `.env.example` | env template — copy to `.env` |
| `start.sh` / `stop.sh` / `logs.sh` | convenience wrappers |

## Prerequisites on the host

- Docker Engine + compose plugin
- `${CIRCUITS_BUILD_DIR}` populated with the same artifacts as `circuits/build/` from the repo
- `${RELAYER_KEY_FILE}` containing the relayer's signing key (single line)
- Pre-built images pushed to a registry (use `deploy/ci/build-and-push.sh`)

## Direct-port mode (no domain)

For IP-only testing on a fresh VM:

```bash
cp .env.example .env
# Fill in SHARED_ORDERBOOK_IMAGE, ZK_RELAYER_IMAGE, RPC_URL, contract addresses…
./start.sh
```

The services are reachable on `http://<VM_IP>:4000` and `http://<VM_IP>:3002`.

## TLS mode (with a domain)

Point `orderbook.<DOMAIN>` and `zk.<DOMAIN>` A records at the VM, then:

```bash
# In .env
DOMAIN=zkscatter.example
ACME_EMAIL=ops@example.com

./start.sh   # auto-detects DOMAIN, applies compose.tls.yml
```

Caddy obtains certs on first start.

## Notes

- Both DBs (`shared-orderbook.db`, `zk-relayer-data`) are stored in named volumes.
  Back them up with `docker run --rm -v orderbook-data:/data alpine tar -C / -czf - data`.
- `start.sh` runs `docker compose pull` so new image tags are picked up automatically.
- `compose.tls.yml` drops the upstream port mappings — only ports 80/443 are open
  in TLS mode.
