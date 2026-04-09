# Test Scenarios: User & Relayer Perspectives

## User Scenarios

### U1: Basic Order Lifecycle (Happy Path)
1. User deposits ETH → WETH → CommitmentPool
2. User creates EdDSA key
3. User signs order with relayer address (Poseidon 9-input hash)
4. User submits to relayer → receives "pending" status
5. Order matches locally → "settled" with txHash
6. User waits for releaseTime → submits gasless claim
7. User receives ETH (auto-unwrapped)

### U2: Cross-Relayer Settlement (Happy Path)
1. User A submits sell-WETH/buy-USDC to Relayer A
2. User B submits sell-USDC/buy-WETH to Relayer B
3. Relayer B discovers match via shared orderbook
4. Relayer B sends Trade Offer to Relayer A
5. Relayer A settles on-chain
6. Both users see "settled" + crossRelayer: true
7. Fee split: Relayer A gets maker fee, Relayer B gets taker fee

### U3: Order Expiry
1. User submits order with short expiry
2. No match found before expiry
3. Order status becomes "expired"
4. User's commitment is NOT consumed (can reuse)

### U4: Order Cancellation
1. User submits order → "pending"
2. User decides to cancel → signs cancel with EdDSA
3. Relayer cancels order → "cancelled"
4. Shared orderbook also cancels

### U5: Same-Token Scatter (ScatterDirect)
1. User deposits WETH
2. User creates scatter order (sellToken == buyToken)
3. Relayer settles via withdraw circuit (no counterparty needed)
4. Recipients receive tokens via claims

### U6: Claim After Cross-Relayer Settlement
1. Cross-relayer settlement completes (U2)
2. User A claims from Relayer A (their relayer) → works
3. User B claims from Relayer B (their relayer) → should work
4. Edge: User B tries to claim from Relayer A → should also work (claim is on-chain)

### U7: Multiple Claims from Same Order
1. User creates order with 3 claims (different recipients/amounts)
2. Settlement completes
3. Each claim can be submitted independently
4. Double-claim attempt → reverts (nullifier already spent)

### U8: Wrong Relayer in Signature
1. User signs order with Relayer A's address
2. User submits to Relayer B
3. Relayer B tries to verify → EdDSA signature mismatch → rejected

## Relayer Scenarios

### R1: Local Settlement
1. Relayer receives maker order → pending
2. Relayer receives taker order → matches locally
3. Relayer generates ZK proof with (makerRelayer, takerRelayer) = (self, self)
4. Relayer submits settlement → both fees to self

### R2: Cross-Relayer as Maker's Relayer (Settling)
1. Relayer A has User A's order
2. Receives Trade Offer from Relayer B (taker's full order)
3. Re-verifies taker EdDSA signature (with Relayer B's address in hash)
4. Generates proof: makerRelayer=A, takerRelayer=B
5. Submits on-chain → maker fee to A, taker fee to B
6. Returns txHash to Relayer B

### R3: Cross-Relayer as Taker's Relayer (Discovering)
1. Relayer B has User B's order
2. Sees remote order from Relayer A on shared orderbook
3. Discovers match
4. Sends Trade Offer to Relayer A
5. Receives settlement response
6. Updates local order status

### R4: Trade Offer Rejection
1. Relayer B sends Trade Offer to Relayer A
2. Relayer A finds maker order already matched/cancelled/expired
3. Relayer A returns { status: "rejected", reason: "..." }
4. Relayer B restores taker to "pending"

### R5: Shared Orderbook Server Down
1. Server goes offline
2. Relayers switch to P2P mode (cached peer list)
3. Orders exchanged directly via /api/p2p/orders
4. Matching still works (relayer-side)
5. Server comes back → relayers reconnect

### R6: FeeVault Claim
1. Relayer settles orders → fees accumulate in FeeVault
2. Relayer calls vault.claim(token)
3. Receives net amount (after platform fee)
4. Treasury receives platform fee

### R7: Reactive Matching (WS Notification)
1. Relayer B has pending local order
2. Relayer A posts new order → shared orderbook broadcasts via WS
3. Relayer B receives notification
4. onRemoteOrderArrived triggers → finds local match
5. Sends Trade Offer → settlement

## Edge Cases

### E1: Race Condition — Double Matching
1. Both relayers discover the match simultaneously
2. Both send Trade Offers to each other
3. Only one should succeed (lockingOrders prevents double)

### E2: Expired Remote Order
1. Relayer A posts order with 5-min expiry
2. 4 minutes pass
3. Relayer B discovers match, sends Trade Offer
4. Relayer A tries to settle but order expired during proof generation
5. Settlement reverts → both orders restored

### E3: Taker Fee Higher Than MaxFee
1. User B sets maxFee = 10 bps
2. Relayer B charges 30 bps
3. Should be rejected at order submission time

### E4: Self-Trade Prevention
1. Same user (same EdDSA key) submits maker and taker
2. Circuit enforces: makerPubKey != takerPubKey → proof fails

### E5: Malicious Relayer — Fee Redirection Attempt
1. Relayer A receives Trade Offer with taker data
2. Relayer A tries to change takerRelayer to own address
3. Fails because taker's EdDSA signature includes Relayer B's address
4. Proof verification fails → InvalidProof

### E6: Stale Commitment Root
1. Settlement proof generated with old commitment root
2. New deposits added between proof gen and submission
3. Contract checks isKnownRoot → should still pass (root history)
4. But if too old → fails

### E7: Same Nonce Reuse After Cancellation
1. User submits order with nonce=1 → cancelled
2. User tries nonce=1 again → should work (nonce nullifier not spent)
3. But if settled then cancelled → nonce nullifier spent → rejected

### E8: Multiple Relayers Same User
1. User A submits to Relayer A with relayerA in signature
2. User A submits different order to Relayer B with relayerB in signature
3. Both orders are valid (different nonces)
4. Both can be matched independently
