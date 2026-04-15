# 전체 생애주기 및 호출 시퀀스

## 시나리오: Alice(maker) ↔ Bob(taker) 프라이빗 스왑 (Half-proof 메인 플로우)

```
[0] 초기화 (오너)
    └─ CommitmentPool 배포 → PrivateSettlement 배포
    └─ pool.queueSetAuthorizedSettlement(settlement) → 24h 후 activateAuthorizedSettlement()
    └─ pool.setTokenWhitelist, settlement.setTokenWhitelist
    └─ (옵션) settlement.setRelayerRegistry / setFeeVault / setAuthorizeVerifier / setBatchAuthorizeVerifier

[1] DEPOSIT (사용자 독립 트랜잭션)
    Alice 클라이언트:
      secret_A, salt_A, pubKey_A 생성 (로컬)
      commitment_A = Poseidon(3, secret_A, tokenX, amountX, salt_A, pkAx, pkAy)
      deposit proof 생성 (브라우저, ~수초)

    tx: pool.deposit(proof, commitment_A, tokenX, amountX)
      ├─ ERC20.transferFrom(Alice, pool, amountX) (fee-on-transfer 방어 balance delta)
      ├─ depositVerifier.verifyProof(...) → commitment ↔ (token, amount, pubKey) 바인딩 검증
      ├─ _insert(commitment_A) → Merkle tree 업데이트, leafIndex 반환
      └─ event CommitmentInserted

    Bob 동일한 흐름으로 commitment_B 예치 (tokenY, amountY)

[2] AUTHORIZE (오프체인, 사용자 로컬 증명)
    Alice 가 주문 요청을 릴레이어에 전달하면서 authorize.circom 증명 생성:
      - 공개 신호: pubKeyBind, root, escrowNull, nonceNull, newComm,
                 sellToken, buyToken, sellAmount, buyAmount, maxFee, expiry,
                 claimsRoot, totalLocked, relayer, orderHash
      - 비공개: secret, balance, salt, path[20], EdDSA signature, claim preimages

    Bob 도 마찬가지로 authorize 증명을 생성.
    두 증명은 매칭 릴레이어로 전달됨(witness 는 노출되지 않음).

[3] SETTLE (온체인 세틀먼트)
    tx: settlement.settleAuth(makerProof, takerProof, fees, ...)
      ├─ SettleVerifyLib.validateCrossSide(maker, taker, ...)
      │   ├─ C1: makerSellToken == takerBuyToken, 역도 성립
      │   ├─ C2: takerSell × takerBuy ≥ makerSell × makerBuy (가격 보호)
      │   ├─ C4: totalLocked_i + fee_i ≤ 반대편 sellAmount
      │   ├─ fee ≤ maxFee × reverseSell / 10000
      │   └─ expiry, whitelist, distinct claimsRoot 체크
      ├─ pool.isKnownRoot(maker.commRoot) && pool.isKnownRoot(taker.commRoot)
      ├─ batchAuthorizeVerifier.verifyProof 또는 authorizeVerifier ×2
      ├─ 상호 nullifier ≠ 상대 nullifier 검사
      ├─ nullifiers/nonceNullifiers 소진 기록
      ├─ pool.insertCommitment(newCommMaker), insertCommitment(newCommTaker)
      ├─ pool.transferToSettlement(tokenMaker, totalLockedMaker + feeMaker)
      │  반대편도 동일
      ├─ 수수료 라우팅:
      │   (FeeVault set) → feeVault.deposit(makerRelayer, tokenMaker, feeTokenMaker)
      │   (unset)        → ERC20.transfer(makerRelayer, feeTokenMaker)
      ├─ claimsGroups[claimsRootMaker] = {totalLocked, 0, tokenMaker} 등록
      └─ event PrivateSettledAuth

[4] CLAIM (수령자가 개별 트랜잭션으로 청구)
    Alice 가 받기로 한 claim leaf 에 대해 claim.circom 증명 생성(로컬):
      - 공개: claimsRoot, nullifier, amount, token, recipient, releaseTime
      - 비공개: claimSecret, leafIndex, path[4], pathIdx[4]

    tx: settlement.claimWithProof(proof, claimsRoot, nullifier, amount, token, recipient, releaseTime)
      ├─ 제재 확인, block.timestamp ≥ releaseTime
      ├─ claimNullifiers[nullifier] 소진 기록
      ├─ claimsGroups[claimsRoot].totalClaimed += amount (≤ totalLocked)
      ├─ 토큰 == WETH 이면 IWETH.withdraw → recipient 로 ETH 전송
      │  아니면 ERC20.transfer(recipient, amount)
      └─ event PrivateClaim

    Bob 의 수령분도 동일하게 각각 청구.

[5] WITHDRAW (청구와 독립된 잔여 에스크로 회수)
    Alice 에게 남은 commitment 가 있으면:
      withdraw.circom 증명 생성(nullifier + change commitment)
      tx: pool.withdraw(proof, root, nullifierHash, newCommitment, token, amount, recipient, relayer)
        ├─ withdrawVerifier.verifyProof
        ├─ nullifiers[nullifierHash] 소진
        ├─ (if newCommitment != 0) _insert(newCommitment)
        └─ ERC20.transfer(recipient, amount) (+ 릴레이어 수수료 있으면 분기)

[6] CANCEL (선택, 세틀 전에 주문 취소)
    tx: settlement.cancelPrivate(cancelProof, …)
      ├─ cancelVerifier 검증
      ├─ oldNullifier / oldNonceNullifier 소진
      ├─ pool.insertCommitment(newCommitment)  (같은 잔액, 새 salt 로 회전)
      └─ event PrivateCancel
```

## 주요 호출 관계 (요약)

```
User ─► CommitmentPool.deposit ─► IncrementalMerkleTree._insert
User ─► CommitmentPool.withdraw ──(fee)──► Relayer
Relayer ─► PrivateSettlement.settleAuth
                ├─► SettleVerifyLib.validateCrossSide
                ├─► (Batch)AuthorizeVerifier.verifyProof × (1|2)
                ├─► CommitmentPool.insertCommitment
                ├─► CommitmentPool.transferToSettlement
                ├─► FeeVault.deposit   (또는 직접 transfer)
                └─► ClaimsGroup 등록
Recipient ─► PrivateSettlement.claimWithProof
                ├─► ClaimVerifier.verifyProof
                └─► ERC20.transfer / IWETH.withdraw
Relayer ─► FeeVault.claim ─► (platformFee → treasury) + (나머지 → self)
```

## 단계별 가스/성능 가이드 (참고)

| 단계 | 대략 가스 | 비고 |
|------|-----------|------|
| deposit | ~350K | Poseidon 삽입 + Groth16 검증 |
| withdraw | ~350K | Groth16 + change commitment 삽입(선택) |
| settleAuth (batch verifier) | ~520K | 5-페어링 배치 + 2× insertCommitment + fee transfers |
| settleAuth (no batch) | ~620K | 4+4 페어링 |
| claimWithProof | ~180K | 단건 |
| claimWithProofBatch (N claims) | ~180K × N (최대 20) | 원자적 |
| cancelPrivate | ~320K | 단건 Groth16 + insertCommitment |

> 값은 환경에 따라 변동. 릴리즈마다 `contracts/test/*.gas.t.sol` 로 측정.
