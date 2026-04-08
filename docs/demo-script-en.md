# Demo Script: Scheduled Private ETH Transfers to Multiple Addresses

> A step-by-step demonstration of zkScatter's ZK proof-based private transfer functionality.
> Deposit ETH, then distribute it to multiple addresses with time-locked releases.

---

## Step 1: Escrow (Deposit)

**Screen: Private Escrow (`/trade/private-escrow`)**

This is the escrow screen.

First, **select a local folder**. zkScatter stores all secret data (commitment notes, trading keys) **only on your computer**, not on any server. JSON note files will be created in this folder. If you lose these files, your deposited funds cannot be recovered — backups are essential.

Select **WETH (Wrapped ETH)** as the token and enter the amount to deposit.

Clicking "Deposit Privately" triggers three internal operations:

1. Wrap ETH into WETH (for ERC-20 compatibility)
2. Approve the CommitmentPool contract to spend the token
3. **Generate a Poseidon hash commitment and deposit it**

The only thing recorded on-chain is a single hash: `Poseidon(ownerSecret, token, amount, salt)`. External observers see only this hash — **they cannot determine who deposited, how much, or which token**. Every deposit looks identical on-chain.

Once the deposit is confirmed, a new entry appears in the notes list on the left. It shows an "Active" status badge along with the leafIndex (position in the Merkle tree) and commitment hash.

### Note File Structure (stored locally)

```json
{
  "note": { "ownerSecret": "...", "token": "0x...", "amount": "...", "salt": "..." },
  "commitment": "0x...",
  "tokenSymbol": "WETH",
  "amount": "1.0",
  "leafIndex": 42,
  "txHash": "0x...",
  "createdAt": 1712537600
}
```

---

## Step 2: Create Order

**Screen: Private Order (`/trade/private-order`)**

This is the order creation screen.

### Generate/Unlock Trading Key

A trading key is required first. Clicking "Generate with Wallet" derives an **EdDSA key pair (Baby Jubjub curve)** from a MetaMask signature. The key is encrypted with AES-GCM and saved to the local folder. This key is used to sign orders and is separate from your wallet private key.

### Select Commitment

Opening the folder displays the previously deposited notes. Since we are transferring ETH, select the WETH deposit.

### Order Configuration

For this demo — **scheduling ETH transfers to multiple addresses** — the settings are:

- **Sell Token**: WETH
- **Buy Token**: WETH (same token — Scatter Direct mode)
- **Amount**: The full deposited amount

Same-token orders do not require counterparty matching; the relayer settles them immediately.

### Fee Configuration

Select the relayer fee rate (presets: 0.1%, 0.3%, 0.5%, 1%). This fee compensates the relayer for generating ZK proofs and covering gas costs. The fee summary shows the net amount recipients will receive.

### Recipient Configuration (Key Part)

This is the core feature. **Up to 10 recipient addresses** can be added. For each recipient:

- **Address**: The receiving wallet (standard address or stealth address)
- **Amount**: How much WETH this recipient receives
- **Release time**: The earliest time the recipient can withdraw (e.g., 10 minutes, 1 hour, 1 day)

For example:

| Recipient | Amount | Claimable After |
|-----------|--------|-----------------|
| Address A | 0.3 ETH | 10 minutes |
| Address B | 0.5 ETH | 1 hour |
| Address C | 0.2 ETH | 24 hours |

The "Fill Rest" button auto-fills the remaining net amount.

### Select Relayer and Submit

After selecting a relayer and clicking "Submit Private Order":

1. Compute each recipient's claim leaf hash: `Poseidon(secret, recipient, token, amount, releaseTime)`
2. Pad to 16 leaves and build a depth-4 **Claims Merkle tree**
3. **Sign the order content + claims root with EdDSA**
4. Submit the signed order to the relayer API (`/api/private-orders`)

**No blockchain transaction occurs during this step.** Everything is off-chain.

After submission, a **claims bundle JSON file** is saved locally and downloaded simultaneously. This file contains the secrets each recipient needs to withdraw their funds.

---

## Step 3: Relayer Settlement

When the relayer receives the order, it performs the following:

### Validation

1. **Verify EdDSA signature** — confirm the order has not been tampered with
2. **Validate fee and expiry**
3. Since this is a same-token (WETH to WETH) order, process in **Scatter Direct mode** (immediate settlement)

### ZK Proof Generation

1. Query all `CommitmentInserted` events from the CommitmentPool to **reconstruct the depth-20 Merkle tree**
2. Extract the **Merkle path proof (path elements + indices)** for the user's deposit
3. **Compute nullifier**: `Poseidon(secret, salt)` — prevents double-spending
4. Assemble **circuit inputs** including claims root, fees, and change commitment
5. **Generate Groth16 proof with snarkjs** (using `settle.wasm` + `settle_final.zkey`)

### On-Chain Submission

Submit the proof via **`PrivateSettlement.settlePrivate()`** (or `scatterDirect()` for same-token orders).

What happens on-chain:

- Mathematical verification of the ZK proof (~200K gas)
- Commitment Merkle proof validation
- Nullifier recorded (prevents reuse)
- Claims root registered (enables recipients to claim later)
- Fee deducted and deposited into FeeVault (relayer claims later, platform fee auto-deducted)

**What on-chain observers see**: ZK proof bytes, nullifier hash, and new commitment hash only. Who sent to whom, how much, and which token — all completely hidden.

---

## Step 4: Recipient Withdrawal (Gasless Claim)

**Screen: Private Claim (`/trade/private-claim`)**

This is the screen where recipients withdraw their funds.

Recipients receive the **claims bundle JSON file** downloaded earlier. (In production, this should be delivered via an encrypted channel.)

> **Security note:** Even if the claim JSON is leaked to a third party, fund theft is impossible. The `recipient` is bound as a public input in the ZK claim circuit — no matter who generates the proof, tokens are always sent to the originally designated recipient address. However, leaking the secret reveals the existence of the claim and the recipient address to the third party, so encrypted delivery is recommended for privacy.

Uploading the file displays all claims in the bundle:

- Claim #1: 0.3 WETH to Address A (claimable after 10 minutes)
- Claim #2: 0.5 WETH to Address B (claimable after 1 hour)
- Claim #3: 0.2 WETH to Address C (claimable after 24 hours)

Select a claim whose release time has passed and click "Generate Proof & Claim":

### Browser-Side ZK Proof Generation (~0.5s)

- What the proof asserts: "I know the secret for a specific leaf in this claims tree"
- Made public: claims root, nullifier, amount, token, recipient address, release time
- Kept hidden: which leaf (the secret value)

### On-Chain Submission via Relayer

1. Submit the proof to the **relayer API (`/api/private-claim`)**
2. Relayer verifies the proof off-chain first (rejects invalid proofs to save gas)
3. Checks that the nullifier has not been spent
4. **Submits `PrivateSettlement.claimWithProof()` on-chain — relayer pays the gas**
5. Smart contract transfers tokens directly to the recipient address

### Why Gasless?

The recipient's new wallet needs zero ETH. The relayer pays gas, and fees were already deducted during settlement. Since no external ETH funding reaches the new wallet, **the link between the deposit address and withdrawal address is completely severed**.

---

## Step 5: Order History

**Screen: Private History (`/trade/private-history`)**

Track the full status of all orders on the history screen.

Unlocking the trading key queries the relayer for order statuses. Each order shows its current state:

- **pending**: Order received
- **matched**: Matched with counterparty (for cross-token orders)
- **settled**: ZK proof submitted, on-chain settlement complete

Click an order to view details:

- Claim status for each recipient ("Claimed" or "Pending")
- Transaction hash for each executed claim
- Download individual claim JSON files for unclaimed entries

If there is remaining balance (change), it stays in the pool as a new commitment and can be used for future orders.

---

## Summary

| Step | Action | Visible On-Chain |
|------|--------|-----------------|
| Deposit | ETH to CommitmentPool | One Poseidon hash |
| Order | EdDSA signature, sent to relayer | Nothing (off-chain) |
| Settlement | Relayer submits ZK proof | Proof bytes + nullifier |
| Claim | Recipient submits claim proof | Proof bytes + recipient address |

We deposited 1 ETH and distributed it to 3 recipients with staggered release times. Yet on-chain, **there is no mathematically traceable link between the deposit and the withdrawals**. This is zkScatter's Cryptographic Privacy.
