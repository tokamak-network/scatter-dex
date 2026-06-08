# deploy/runtime

Self-contained docker compose stack that runs on a single VM (GCP e2-micro target).

## Layout

| File | Role |
| --- | --- |
| `compose.yml` | shared-orderbook + settlement-verifier (zk-relayer behind the `relayer` profile, opt-in) |
| `compose.tls.yml` | overlay that adds Caddy with auto Let's Encrypt |
| `Caddyfile` | subdomain routing (`orderbook.<DOMAIN>`, `zk.<DOMAIN>`) |
| `.env.example` | env template — copy to `.env` |
| `start.sh` / `stop.sh` / `logs.sh` | convenience wrappers |

## Prerequisites on the host

- Docker Engine + compose plugin
- Pre-built images pushed to a registry (use `deploy/ci/build-and-push.sh`)
- For `settlement-verifier`: `RPC_URL` + `PRIVATE_SETTLEMENT_ADDRESS`

The following are needed **only** when running the `relayer` profile
(per-operator); the default orderbook box does not use them:

- `${CIRCUITS_BUILD_DIR}` populated with the same artifacts as `circuits/build/` from the repo
- `${RELAYER_KEY_FILE}` containing the relayer's signing key (single line)

## Direct-port mode (no domain)

For IP-only testing on a fresh VM:

```bash
cp .env.example .env
# Fill in SHARED_ORDERBOOK_IMAGE, IMAGE_TAG, CORS_ORIGINS,
# and (for the verifier) RPC_URL + PRIVATE_SETTLEMENT_ADDRESS…
./start.sh
```

The default bring-up starts `shared-orderbook` (reachable on
`http://<VM_IP>:4000`) and `settlement-verifier` (no exposed port — it only
reads the chain and the shared DB). `zk-relayer` is **not** started.

## Relayer profile (per-operator)

`zk-relayer` runs per-operator, not on the central box. An operator who wants
it co-located enables the `relayer` Compose profile — this additionally needs
`ZK_RELAYER_IMAGE`, `RPC_URL`, `COMMITMENT_POOL_ADDRESS`,
`PRIVATE_SETTLEMENT_ADDRESS`, `${RELAYER_KEY_FILE}`, and `${CIRCUITS_BUILD_DIR}`:

```bash
docker compose --profile relayer up -d
```

It then exposes `http://<host>:3002`.

## TLS mode (with a domain)

> `Caddyfile` routes `zk.<DOMAIN>` → `zk-relayer`. That backend only exists
> when the `relayer` profile is enabled, so on the default (orderbook-only)
> box just point `orderbook.<DOMAIN>`; `zk.<DOMAIN>` applies only to a host
> that co-locates a relayer.

Point `orderbook.<DOMAIN>` (and `zk.<DOMAIN>` only with the `relayer` profile)
A records at the VM, then:

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
