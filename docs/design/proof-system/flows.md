# 증명 시스템 플로우 & 시퀀스 다이어그램

## 1. 전체 생애주기 흐름도

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │                         오프체인 클라이언트                              │
  │   ┌───────────┐     ┌──────────────┐     ┌──────────┐   ┌─────────┐  │
  │   │ BabyJub    │────▶│ commitment v2│────▶│ deposit   │   │ cancel  │  │
  │   │ 키쌍 생성   │     │ 해시 생성    │     │ 증명 생성 │   │ 증명    │  │
  │   └───────────┘     └──────────────┘     └────┬─────┘   └────┬────┘  │
  │                                                 │              │       │
  │                       ┌─────────────┐           │              │       │
  │                       │ authorize   │◄──────────┼──────────────┤       │
  │                       │ 증명 (maker)│           │              │       │
  │                       └─────────────┘           │              │       │
  │                                                 │              │       │
  │                       ┌─────────────┐           │              │       │
  │                       │ authorize   │           │              │       │
  │                       │ 증명 (taker)│           │              │       │
  │                       └──────┬──────┘           │              │       │
  └───────────────────────────────┼──────────────────┼──────────────┼───────┘
                                  │                  │              │
                                  ▼                  ▼              ▼
       ┌───────────────────────────────────────────────────────────────────┐
       │                          온체인                                     │
       │                                                                   │
       │   pool.deposit ───▶ MerkleTree 삽입 ─┐                            │
       │                                      │                            │
       │   settlement.settleAuth(M+T proof)   │                            │
       │        ▲                             │                            │
       │        │ batch verify(5-pair)        │    pool.insertCommitment   │
       │        │ or 2 × authorize            ├───▶ (change comm)         │
       │        │                             │                            │
       │        │ + cross-side check          │    pool.transferToSettle   │
       │        │  (C1 토큰, C2 가격, C4 캡) │                            │
       │        │                             │                            │
       │        │                             │    FeeVault.deposit or     │
       │        │                             │    ERC20.transfer(fee)     │
       │        │                             │                            │
       │        │                             ▼                            │
       │        │                      claimsGroup 등록                    │
       │        │                             │                            │
       │   settlement.cancelPrivate ◀─────────┤                            │
       │        │ nullifier burn + new comm   │                            │
       │        ▼                             ▼                            │
       │   settlement.claimWithProof ──▶ ERC20.transfer / WETH.withdraw    │
       │   pool.withdraw             ──▶ ERC20.transfer                    │
       └───────────────────────────────────────────────────────────────────┘
```

## 2. 시퀀스: Half-Proof 세틀먼트 (메인 플로우)

```
Alice(maker)              Bob(taker)              Relayer R           PrivateSettlement       CommitmentPool
     │                         │                       │                        │                       │
     │ [사전] deposit tokenX (amountX)                 │                        │                       │
     ├────────────────────────────────────────────────────────────────────────────────────────────────▶│  tree.insert(commA)
     │                         │ [사전] deposit tokenY (amountY)                │                       │
     │                         ├───────────────────────────────────────────────────────────────────────▶│  tree.insert(commB)
     │                         │                       │                        │                       │
     │ (1) 주문 파라미터 설정 + EdDSA 서명             │                        │                       │
     │ (2) authorize.circom proof P_A 생성             │                        │                       │
     ├────────────────────────▶│                       │                        │                       │
     │    order + proof P_A    │                       │                        │                       │
     │                         │ (1)(2) authorize proof P_B 생성                │                       │
     │                         ├──────────────────────▶│                        │                       │
     │                         │     order + P_B        │                       │                       │
     │                         │                       │ order matching          │                       │
     │                         │                       │                        │                       │
     │                         │                       │ tx: settleAuth(P_A, P_B, fees)                 │
     │                         │                       ├───────────────────────▶│                       │
     │                         │                       │                        │ validateCrossSide     │
     │                         │                       │                        │ isKnownRoot(rootA)    │
     │                         │                       │                        │ isKnownRoot(rootB) ──▶│
     │                         │                       │                        │ verifyProof ×2(or batch)
     │                         │                       │                        │ nullifier burn        │
     │                         │                       │                        │ insertCommitment(newA)│
     │                         │                       │                        │◀──leafIndex──────────│
     │                         │                       │                        │ insertCommitment(newB)│
     │                         │                       │                        │ transferToSettlement  │
     │                         │                       │                        │ transferFee (FeeVault)│
     │                         │                       │                        │ claimsGroup 등록      │
     │                         │                       │◀───event PrivateSettledAuth────────────────────│
     │                         │                       │                        │                       │
     │  (3) claim.circom proof 생성 (Bob's claimsRoot 안의 Alice 리프)          │                       │
     ├──────────────────────────────────────────────────────────────────────▶│ claimWithProof          │
     │                         │                       │                        │ verify → transfer     │
     │                         │ (3) 자기 리프 claim 동일하게                   │                       │
     │                         ├──────────────────────────────────────────────▶│                       │
```

## 3. 시퀀스: Deposit

```
User                        CommitmentPool                 DepositVerifier       MerkleTree
 │                                │                                │                  │
 │ [로컬] secret, salt, pubKey 생성                                │                  │
 │ [로컬] commitment = P_7(3,…)                                    │                  │
 │ [로컬] deposit.circom proof 생성                                │                  │
 │                                │                                │                  │
 │ approve(pool, amount) on ERC20 │                                │                  │
 │ tx: deposit(proof, commitment, token, amount)                   │                  │
 ├───────────────────────────────▶│                                │                  │
 │                                │ 필드 멤버십 & 화이트리스트      │                  │
 │                                │ ERC20.transferFrom + 잔액 차분  │                  │
 │                                ├──verifyProof([commitment,tok,amt])▶│              │
 │                                │                                │                  │
 │                                ├───_insert(commitment)──────────────────────────▶ │
 │                                │◀──leafIndex────────────────────────────────────── │
 │◀── event CommitmentInserted ───│                                │                  │
```

## 4. 시퀀스: Cancel + Re-order

```
User                          PrivateSettlement          CancelVerifier          CommitmentPool
 │                                  │                          │                        │
 │ [로컬] EdDSA.sign(P_2(oldNonceNull, self))                   │                        │
 │ [로컬] cancel.circom proof 생성                              │                        │
 │                                  │                          │                        │
 │ tx: cancelPrivate(proof, signals)                            │                        │
 ├─────────────────────────────────▶│                          │                        │
 │                                  │ submitter == msg.sender 확인                       │
 │                                  │ nullifiers[oldNull]?=false │                        │
 │                                  │ nonceNullifiers[oldNonce]?=false                   │
 │                                  ├─verifyProof─────────────▶│                        │
 │                                  │ mark both nullifiers spent                          │
 │                                  ├─────pool.insertCommitment(newComm)────────────────▶│
 │◀── event PrivateCancel ──────────│                          │                        │
 │                                                                                        │
 │  [이후] 사용자는 newComm 으로 새 authorize 증명을 만들어 재주문 가능 (nonce 갱신)     │
```

## 5. 데이터 플로우: 증명 공개 신호 → 온체인 상태

```
  ┌──────────────────────────┐
  │  authorize.circom 증명    │
  │  공개 신호 15개            │
  └──────────┬───────────────┘
             │
             ▼
  ┌─────────────────────────────────────────┐
  │  SettleVerifyLib.packAuthSignals         │─── uint[15]  ──▶  AuthorizeVerifier.verifyProof
  │  (struct → flat array)                   │
  └──────────┬──────────────────────────────┘
             │ 매개변수
             ▼
  ┌─────────────────────────────────────────┐
  │  PrivateSettlement.settleAuth            │
  │   ├─ validateCrossSide(maker, taker)     │
  │   ├─ pool.isKnownRoot(maker.root)        │
  │   ├─ pool.isKnownRoot(taker.root)        │
  │   ├─ nullifiers[maker.esc] = true        │
  │   ├─ nonceNullifiers[maker.nonce] = true │
  │   ├─ (반대편 동일)                        │
  │   ├─ pool.insertCommitment(maker.newComm)│
  │   ├─ pool.transferToSettlement           │
  │   ├─ FeeVault.deposit / direct transfer  │
  │   └─ claimsGroups[rootM] = {locked,0,tkn}│
  └──────────┬──────────────────────────────┘
             ▼
  ┌─────────────────────────────────────────┐
  │ event PrivateSettledAuth(...)            │
  └─────────────────────────────────────────┘
```

## 6. 상태 머신: 한 UTXO 의 수명

```
     ┌────────┐  deposit.circom + pool.deposit    ┌──────────────┐
     │ (없음) │──────────────────────────────────▶│ In-Tree(C)   │
     └────────┘                                    └──────┬───────┘
                                                          │
       ┌──────────────────────────┬──────────────────────┼────────────────────────┐
       │                          │                      │                        │
       ▼                          ▼                      ▼                        ▼
  authorize                 withdraw              settle (legacy)             cancel
  + settleAuth              pool.withdraw         settlePrivate               cancelPrivate
       │                          │                      │                        │
       │ (escrow+nonce null burn) │ (escrow null burn)   │ (escrow+nonce burn)    │ (escrow+nonce burn)
       ▼                          ▼                      ▼                        ▼
  ┌──────────────┐        ┌──────────────┐      ┌──────────────┐        ┌───────────────┐
  │  Spent       │        │   Withdrawn  │      │   Spent      │        │  Rotated → C' │
  │  + newComm C'│        │  + newComm C'│      │   + newComm' │        │ (새 UTXO)     │
  └──────────────┘        └──────────────┘      └──────────────┘        └───────────────┘
       │                          │                      │                        │
       │ claim.circom 로 claim tree 에서 수령자 각자 청구                          │
       │                                                                           │
       ▼                                                                           ▼
  (Claims 수령 종료)                                                        (사용자 재주문 가능)
```

## 7. Batch Authorize 검증 최적화 구성도

```
   ┌──────────────────────────┐         ┌──────────────────────────┐
   │  Maker authorize proof   │         │  Taker authorize proof   │
   │   (A_m, B_m, C_m)        │         │   (A_t, B_t, C_t)        │
   └────────────┬─────────────┘         └────────────┬─────────────┘
                │                                     │
                └──────────────┬──────────────────────┘
                               ▼
                 ┌─────────────────────────────┐
                 │  BatchAuthorizeVerifier     │
                 │  Fiat-Shamir r = H(proofs)  │
                 │  LinCombo(proof_m + r·proof_t)
                 │                              │
                 │  단일 5-페어링 체크          │
                 │  e(A',B') = e(α,β)·e(IC',γ)·e(C',δ)
                 └─────────────────────────────┘
                               │
                               ▼
                         ✅ 유효 / ❌ revert

  효과: 기존 4+4 = 8 페어링 → 5 페어링 (settleAuth 당 ~70–100K gas 절감)
```
