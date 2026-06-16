# ZK circuit artifacts (deployed networks)

How the Groth16 zkeys, WASMs, and on-chain verifiers stay in sync on **deployed**
networks (Sepolia, etc.). For the **local anvil** build rationale (why artifacts
are gitignored and rebuilt with every `./scripts/dev.sh` run), see
[local-setup.md](./local-setup.md#prerequisite-zk-circuit-artifacts).

## The rule: do NOT rebuild to "refresh" a deployed network

On a deployed network the Groth16 verifiers are already on-chain, each locked to
one specific zkey build. **Never `npm run build` the circuits to refresh Sepolia
assets** — a rebuild draws a fresh phase-2 beacon, producing a zkey that no
longer pairs with the deployed verifier, so every proof reverts with
`InvalidProof()` (custom-error selector `0x09bde339`).

The "build them together" rule is for **local anvil only**.

## Canonical set + distribution

The **canonical** artifact set is pinned by the committed
`circuits/zk-manifest.json` (sha256 per artifact), verified to pair with all
Sepolia verifiers. The bytes themselves are **not** in git — `circuits/build` is
generated/gitignored — because zkeys are large (~256 MB) and non-reproducible.

They are distributed as fixed bytes via a public GCS bucket
(`gs://zkscatter-zk-artifacts`, content-addressed by sha256). Frontends serve the
prover assets from `apps/<app>/public/zk/` (gitignored; the browser fetches
`/zk/<circuit>.wasm` + `/zk/<circuit>_final.zkey` at runtime). A fetch step
(`predev`/`prebuild`/CI, `scripts/fetch-zk-assets.mjs`) downloads and
checksum-verifies the manifest-pinned bytes into `public/zk`, so these always
match the on-chain verifiers.

## Troubleshooting `InvalidProof()` (`0x09bde339`)

`execution reverted (unknown custom error) data=0x09bde339` means the served zkey
does not pair with the on-chain verifier. Either:

- the frontend serves a **stale zkey** → re-fetch the canonical asset, **or**
- the **on-chain verifier is stale** → redeploy it from the canonical zkey and
  re-point via the admin **Verifier rotation** page (`/protocol/settlement`).

Confirm pairing with:

```bash
node scripts/check-zk-pairing.mjs
```

It exports the zkey's vkey and checks its `alpha`/`IC` G1 constants appear in the
verifier's on-chain bytecode via `eth_getCode`.

## Rotating circuits (rebuild + verifier redeploy)

When a circuit's zkey is regenerated and its on-chain verifier redeployed, refresh
the distribution so everyone gets the new bytes:

```bash
# 1. redeploy each rotated circuit's verifier, re-point it (admin Verifier
#    rotation page or setXVerifier), and record the new address in the ledger:
#      contracts/deployments/<chainId>.json
# 2. with the new circuits/build/ in place, upload + repin (needs gcloud auth):
./scripts/upload-zk-artifacts.sh          # uploads new sha256 objects, regenerates the manifest
# 3. commit the new pins AND the updated ledger so consumers + the guard agree:
git add circuits/zk-manifest.json contracts/deployments/<chainId>.json
git commit -m "chore(zk): rotate <circuit> — repin + re-pointed verifier"
# 4. sanity-check the canonical set pairs with the (now updated) deployed verifiers:
node scripts/check-zk-pairing.mjs         # all N verifiers pair ✓
```

The ledger update in steps 1/3 is essential: `check-zk-pairing.mjs` reads verifier
addresses from `contracts/deployments/<chainId>.json`, so a stale ledger makes the
guard check the wrong (old) verifier. Objects are content-addressed
(`gs://zkscatter-zk-artifacts/zk/<sha256>`), so a rotation only *adds* objects —
old builds stay reachable and nothing is overwritten.
