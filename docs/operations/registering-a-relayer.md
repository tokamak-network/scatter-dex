# Registering a Relayer

End-to-end onboarding for a new relayer operator, from the
KYC packet they send the admin to their first appearance on the
public leaderboard.

The flow has three actors:

- **Operator** — the person / org that will run a relayer.
- **Admin (Relayer-CA owner)** — holds the IssuanceApprovalRegistry
  owner key (multisig in production). Reviews KYC offline and
  records approvals on chain.
- **zk-X509 CA** — separate system that anchors the trusted Root
  CA on chain (`IdentityRegistry.programVKey`) and issues the
  per-operator X.509 cert + ZK proof.

Each step says **who** does it, **where** (URL / page), and
**what** lands on chain.

---

## Pre-flight (one-time, per network)

These are operator-independent and should already be done in your
deployment. Skip if you're onboarding into an environment that
already has them.

- **Root CA + PROGRAM_V_KEY anchored** on the zk-X509
  `IdentityRegistry`. Set up by whoever ran the zk-X509 deploy
  script — confirm via `IdentityRegistry.effectiveProgramVKey()`.
- **`IssuanceApprovalRegistry` deployed** on the same chain.
  Operators app reads it via
  `NEXT_PUBLIC_ISSUANCE_APPROVAL_REGISTRY_ADDRESS`.
- **Relayer-CA portal URL** set via `NEXT_PUBLIC_CA_REGISTRATION_URL`
  (or the legacy `NEXT_PUBLIC_ZK_X509_URL`) so the operators app
  can hand operators a working link to the cert issuance UI.

If any of these are missing, the operators `/register` page falls
back to a generic "Open Relayer-CA verifier" link without the
admin's CN/O/C metadata — the flow still works, just less guided.

---

## Step 1 — Operator submits KYC + wallet address (off chain)

Channel: **email, in-person, encrypted file drop** — anything off
chain.

The operator hands the admin:
- ID / company registration
- The EVM address they will use to run the relayer (`msg.sender`
  on the eventual `register()` call)
- Desired display name (the CN that will show on `/leaderboard`)

Nothing on chain yet. Admin reviews via their own KYC workflow.

---

## Step 2 — Admin: publish the company's Root CA (one-time per CA)

If the Root CA isn't already anchored on chain (see Pre-flight),
the admin sets up the CA via the zk-X509 system. The CA's
PROGRAM_V_KEY (`0x006e7699…` style 32-byte hash) lands in
`IdentityRegistry.programVKey`; the CA private key stays on the
signing server.

In our reference deployment this is a one-time admin task and is
already done before any operator onboards.

**Verify**: visit `/operator-ca` on the operators app. The
"Registry address" stat shows the on-chain CA address that gates
every operator's `register()` call.

---

## Step 3 — Admin: approve the operator's wallet

**Who**: Admin (IssuanceApprovalRegistry owner)
**Where**: operators app → header `Identity ▾` → **Approve operators
(admin)** → `/admin/issuance`

Fill the **Approve a new operator** form using the data from
step 1:

| Field | Example |
|---|---|
| Operator wallet (EVM) | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` |
| Common name (CN) | `relayer3@tokamak.network` |
| Organisation (O) | `Tokamak Network` |
| Country (C, ISO-3166 alpha-2) | `KR` |
| Validity (days) | `365` |
| Expires at (unix sec, 0 = no expiry) | `0` |

Click **Approve on-chain** — your wallet (anvil #0 / multisig) signs
the tx; on confirmation the **Event history** card below shows
`Approved 0x90F79b…b906`.

> **Why is this on chain?** It makes admin decisions auditable
> (operators can verify they were approved without trusting an
> internal database) and immutable (a revoke is a new event, not a
> deletion). The actual security gate is still the zk-X509 ZK
> proof at step 5 — this approval is the **UX gate** that lets the
> operator's `/register` page surface the cert-issuance CTA with
> the right CN/O/C/validity already filled in.

---

## Step 4 — Operator: open the Relayer-CA portal from the wizard

**Who**: Operator
**Where**: operators app `/register` Step 1

The operator connects the wallet they submitted in step 1. Step 1
of the wizard auto-detects the approval and shows a green card:

```
✓ You're approved — get your certificate
   CN:       relayer3@tokamak.network
   O:        Tokamak Network · C: KR · Validity: 365 days
   [Open Relayer-CA portal ↗]   [Refresh verification status]
```

Click **Open Relayer-CA portal ↗** — opens the zk-X509 site in a
new tab (the URL `NEXT_PUBLIC_CA_REGISTRATION_URL` points at).

> **What if I see a different card?**
> - `Get your operator address verified` (yellow) — the wallet
>   isn't yet approved. Either you connected the wrong address or
>   the admin hasn't recorded the approval yet (step 3).
> - `Issuance approval was revoked` (red) — admin revoked you;
>   the reason text says why. Contact admin offline before
>   retrying.
> - `Approval window expired` — admin set a non-zero `expiresAt`
>   and the window closed; ask for a re-approval.

---

## Step 5 — Operator: issue the cert + register the ZK proof on the Relayer CA

**Who**: Operator (in the zk-X509 tab)
**Where**: zk-X509 portal (the URL step 4 opened)

In the cert issuance form:

1. Enter the same CN / O / C / Validity the admin recorded plus
   your **Operator wallet** address.
2. **Regenerate keypair** — generates an ECDSA keypair locally in
   your browser. The private key never leaves the page; download
   the `.pem` and store it in your relayer's secrets vault.
3. **Issue cert ↗** — the CA signs the cert + your browser builds
   a ZK proof that the cert binds to your operator wallet. The
   proof is submitted to `IdentityRegistry.verify(wallet, expiry,
   …)` on chain.

When this confirms, `IdentityRegistry.isVerified(yourWallet)`
returns `true`.

> **Security boundary.** This is where the actual on-chain access
> gate flips. `RelayerRegistry.register()` (step 8) reverts unless
> `IdentityRegistry.isVerified(msg.sender)` is true. The
> IssuanceApprovalRegistry from step 3 does NOT gate
> `register()` — it just shaped the operators-app UI.

---

## Step 6 — Operator: confirm verification passed

**Where**: operators app `/register` Step 1

Back in the operators tab, click **Refresh verification status**.
Step 1's check-list flips:

- ✅ Wallet connected
- ✅ Connected to *<network>*
- ✅ Operator address verified in IdentityRegistry — *Verified
  until 2027-…*

The stepper auto-advances; **Step 2 (Endpoint)** unlocks.

If the row doesn't flip, the on-chain `verify()` from step 5
might not be mined yet — wait a few seconds and click Refresh
again. If still no luck, double-check that you submitted the
zk-X509 proof from the same wallet that's currently connected.

---

## Step 7 — Operator: spin up the relayer process

**Who**: Operator (on their server)
**Where**: shell on whatever host will run the relayer

The relayer is the off-chain service Pay/Pro talk to. Two
requirements:

- The host responds at the URL you'll register (HTTPS in
  production; `/api/info` must answer with the relayer's name +
  chainId).
- The relayer's `RELAYER_PRIVATE_KEY` matches the wallet that was
  verified at step 5.

See the [Local Setup](?d=local-setup) and [Deployment](?d=deployment)
docs for the full env reference. Minimum local-setup example:

```bash
cd zk-relayer

RPC_URL=http://localhost:8545 \
COMMITMENT_POOL_ADDRESS=0x… \
PRIVATE_SETTLEMENT_ADDRESS=0x… \
FEE_VAULT_ADDRESS=0x… \
SHARED_ORDERBOOK_URL=http://localhost:4000 \
RELAYER_FEE=30 \
RELAYER_PRIVATE_KEY=0x… \
RELAYER_NAME="Relayer-C" \
RELAYER_PUBLIC_URL=http://localhost:3004 \
PORT=3004 \
DB_PATH=$(pwd)/zk-relayer-c.db \
npm run dev
```

Sanity-check:

```bash
curl -s http://localhost:3004/api/info | python3 -m json.tool
# {
#   "name": "Relayer-C",
#   "chainId": 31337,
#   "address": "0x90F79bf6…b906",
#   ...
# }
```

---

## Step 8 — Operator: register the endpoint + post a bond

**Where**: operators app `/register` Step 2 and Step 3

Step 2 fields:

- **Endpoint URL** — the URL from step 7 (`http://localhost:3004`
  in the example). The wizard runs a live probe and shows you
  exactly what `/api/info` reported (name, chainId, version,
  latency). If chainId differs from the wallet's chain the probe
  warns; you can override only after confirming the relayer is
  reachable from this app.
- **Display name** — must be unique across all active relayers;
  the wizard checks live and shows a conflict warning if not.
- **Per-trade fee** — basis points the relayer keeps per fill.

Step 3:

- **Bond** — minimum from `RelayerRegistry.minBond()`. Refundable
  after the exit cool-down.
- Click **Register on-chain**. Your wallet (verified at step 5)
  signs. On confirmation the wizard shows the tx hash.

---

## Step 9 — Verify the new relayer appears on the leaderboard

**Where**: operators app `/leaderboard`

The freshly-registered relayer shows up as a new row:

- Status dot — green when `/api/info` answers
- Settled / Volume / Revenue start at 0 until orders begin flowing
- Per-token detail row (expand the row) is empty until first fill

The same listing also appears in Pay/Pro's `RelayerPicker` — the
operator's relayer is now eligible to match orders.

---

## Troubleshooting

### `/register` Step 1 shows "Get your operator address verified" instead of the green approved card
- The connected wallet is NOT in the IssuanceApprovalRegistry. Ask
  admin to approve it (step 3).
- Or the app's `NEXT_PUBLIC_ISSUANCE_APPROVAL_REGISTRY_ADDRESS`
  isn't set — admin-recorded approvals aren't being read at all.
  Check operators `.env.local`.

### Step 2's endpoint probe stays amber with "chainId mismatch"
- The relayer process is wired to a different chain than the
  operators app. Check the `RPC_URL` env on the relayer matches
  what operators uses (`NEXT_PUBLIC_RPC_URL`).

### `register()` reverts with `NotVerified`
- Step 5 didn't finish (or the wallet that called `verify()` is
  not the same as the connected wallet). Run the zk-X509 flow
  again from the same wallet and click Refresh.

### Admin clicked Approve but operator still sees yellow card
- Approve tx might not be mined yet. The wizard reads the
  registry on page load; click Refresh on the CTA card.
- Verify the admin's tx confirmed by looking at
  `/admin/issuance` → **Event history**.

### Operator name shows as "Relayer-A" for everyone
- The relayer process didn't pass `RELAYER_NAME` env on boot —
  defaults to a generic name. Restart with `RELAYER_NAME=` set.

---

## Reference: which contract does which gate?

| Concern | Contract | Function |
|---|---|---|
| KYC decision (UX gate) | `IssuanceApprovalRegistry` | `approvals(operator)` |
| Cert ownership (security gate) | `IdentityRegistry` (zk-X509) | `isVerified(operator)` |
| Eligible to run a relayer | `RelayerRegistry` | `isActiveRelayer(operator)` |
| Public discovery | `RelayerRegistry` | `getActiveRelayers()` |

Only the `IdentityRegistry.isVerified` check is enforced by
`RelayerRegistry.register()`. Everything else is UX/audit
infrastructure built around it.
