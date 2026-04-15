# 핵심 컨트랙트 상세

## 1. CommitmentPool.sol

> 파일: `contracts/src/zk/CommitmentPool.sol`
> 상속: `IncrementalMerkleTree`, `ReentrancyGuard`, `Ownable2Step`

### 1.1 역할

- 모든 사용자 예치금의 **UTXO 에스크로** 역할.
- 커밋먼트를 Poseidon Merkle tree 에 삽입·관리(deposit / insertCommitment).
- Nullifier 세트로 이중지출 방지.
- 세틀먼트 계약에 대해 **자금 이동 허가**(withdraw / transfer) 제공.

### 1.2 주요 상태 변수

| 변수 | 타입 | 설명 |
|------|------|------|
| `withdrawVerifier` | `IVerifier` (immutable) | 출금 증명용 Groth16 verifier |
| `depositVerifier` | `IDepositVerifier` (immutable) | 예치 증명용 verifier |
| `authorizedSettlement` | `address` | 허가된 PrivateSettlement 컨트랙트 |
| `nullifiers` | `mapping(uint256 => bool)` | 출금 에스크로 nullifier 소진 기록 |
| `whitelistedTokens` | `mapping(address => bool)` | 토큰 허용 리스트 |
| `sanctionsList` | `ISanctionsList` (optional) | 제재 주소 확인 |
| `BN254_FIELD_MODULUS` | `uint256 constant` | 필드 범위 체크 상수 |
| `paused` | `bool` | 비상 정지 플래그 |

### 1.3 외부 함수

| 함수 | 호출자 | 설명 |
|------|--------|------|
| `deposit(proofA,B,C, commitment, token, amount)` | 사용자 | 예치 증명 검증 후 tree 에 commitment 삽입. `transferFrom` 과 정확한 금액 바인딩 검증. |
| `withdraw(proof…, root, nullifierHash, newCommitment, token, amount, recipient, relayer)` | 사용자/릴레이어 | 출금 증명 검증 → nullifier 소진 → 잔액 차이만큼 change commitment 삽입. |
| `withdrawFor(...)` | `authorizedSettlement` 만 | 세틀먼트 경로용(세틀먼트 중 pause 여부 무시). |
| `insertCommitment(commitment)` | `authorizedSettlement` 만 | 세틀 후 잔여 commitment 를 tree 에 삽입, leafIndex 반환. |
| `transferToSettlement(token, amount)` | `authorizedSettlement` 만 | 클레임 집행을 위해 토큰을 PrivateSettlement 로 이동. |
| `transferFee(recipient, token, amount)` | `authorizedSettlement` 만 | 릴레이어 수수료 전송(풀 잔액 10% 상한). |
| `queueSetAuthorizedSettlement / activateAuthorizedSettlement` | owner | 세틀먼트 변경 24시간 타임락. |
| `setSanctionsList / setTokenWhitelist / setPaused` | owner | 구성 관리. |

### 1.4 핵심 불변식

1. **커밋먼트 바인딩**: 예치 증명이 `Poseidon(TAG_COMMITMENT_V2, secret, token, amount, salt, pubKeyAx, pubKeyAy) == commitment` 를 강제.
2. **Nullifier 유일성**: `!nullifiers[nullifierHash]` 검사로 이중 출금 방지.
3. **루트 최신성**: 출금 증명의 `root` 는 `isKnownRoot()` 링 버퍼에 존재해야 함.
4. **풀 수수료 캡**: `transferFee` 가 풀 잔액의 10% 초과 시 revert → 운영자 주도 드레인 방지.
5. **필드 범위 검증**: `commitment`, `amount` 를 BN254 modulus 이하로 선검사(증명 실패 시 15만 가스 절약).
6. **Fee-on-transfer 방어**: `transferFrom` 전후 잔액 차분 비교.

### 1.5 이벤트

- `CommitmentInserted(commitment, leafIndex, timestamp)`
- `Withdrawal(recipient, nullifierHash, newCommitment, amount)`
- `FeeTransferred(recipient, token, amount)`
- `TokenWhitelistUpdated`, `AuthorizedSettlementUpdated`, `SettlementChangeQueued`, `SanctionsListUpdated`, `Paused`

---

## 2. PrivateSettlement.sol

> 파일: `contracts/src/zk/PrivateSettlement.sol`
> 시스템에서 가장 큰 컨트랙트 — ZK 세틀먼트 엔진 본체.

### 2.1 역할

4종 세틀먼트 플로우를 통합 관리하고 Claims Group(수령자 Merkle tree) 을 등록, 이후 사용자가 개별 Claim 증명으로 토큰을 수령하도록 한다.

| 플로우 | 증명 형태 | 호출자 | 용도 |
|--------|----------|--------|------|
| `settlePrivate` | 풀 증명 1개(`settle.circom`) | maker.relayer 또는 taker.relayer | 단일 릴레이어가 양쪽 witness 를 모두 본 상태에서 집행(레거시). |
| `settleAuth` | half-proof 2개(`authorize.circom` ×2) | 한쪽 릴레이어 | **메인 플로우**. 사용자가 로컬에서 증명 생성, 릴레이어는 witness 불가시. |
| `settleWithDex` | half-proof 1개 + DEX 스왑 | self-relayer (permissionless) | 시장가 주문용. 화이트리스트된 DEX 라우터로 스왑 후 Claims 등록. |
| `scatterDirect / scatterDirectAuth` | 출금 증명 / authorize 증명 | 릴레이어 | 동일 토큰 1자 → 여러 수령자 분배(스캐터). |

추가 기능:
- `cancelPrivate` — 에스크로 회전(old nullifier burn + new commitment 삽입) 으로 대기중 주문 취소.
- `claimWithProof / claimWithProofBatch` — Claims Group 내 leaf 증명 후 토큰 수령(최대 20개 배치, WETH → ETH 자동 언래핑).

### 2.2 주요 상태

| 변수 | 설명 |
|------|------|
| `pool` | 연동된 CommitmentPool (immutable) |
| `settleVerifier`, `claimVerifier` | 메인 Groth16 verifier (immutable) |
| `authorizeVerifier`, `cancelVerifier`, `batchAuthorizeVerifier` | 업그레이드 가능 verifier |
| `nullifiers`, `nonceNullifiers`, `claimNullifiers` | 3종 nullifier 세트 |
| `claimsGroups[root] → {totalLocked, totalClaimed, token}` | Claims Group 등록부 |
| `relayerRegistry`, `feeVault` | 선택적 모듈 |
| `whitelistedTokens`, `whitelistedDexRouters` | 허용 리스트 |
| `dexPlatformFeeBps` | DEX 플랫폼 수수료(0–500bps = 최대 5%) |
| `weth` | WETH 주소(자동 언래핑용) |

### 2.3 settleAuth 의 교차 검증 (핵심 불변식)

`settleAuth` 는 각 쪽이 독립적으로 생성한 두 증명을 결합해 다음을 온체인에서 재검증한다:

| 제약 | 수식 |
|------|------|
| **C1** 토큰 호환 | `maker.sellToken == taker.buyToken` 그리고 `maker.buyToken == taker.sellToken` |
| **C2** 가격 보호 | `taker.sellAmount × taker.buyAmount ≥ maker.sellAmount × maker.buyAmount` |
| **C4** 클레임+수수료 캡 | `totalLockedMaker + feeTokenMaker ≤ taker.sellAmount` (반대편 동일) |
| **수수료 상한** | `feeTokenMaker ≤ taker.sellAmount × taker.maxFee / 10000` |
| **만료** | 각 쪽의 `expiry ≥ block.timestamp` |
| **상호 배제** | `makerNullifier ≠ takerNullifier`, `makerNonceNullifier ≠ takerNonceNullifier` |
| **루트 유효성** | 각 쪽의 `commitmentRoot` 가 pool 의 최근 링 버퍼에 존재 (비동기 루트 허용) |

> **비동기 루트**: `settlePrivate` 은 양측 같은 루트를 요구하지만 `settleAuth` 는 각기 다른 루트를 허용한다. nullifier 가 이중지출을 막기 때문에 안전하다. 이로써 maker/taker 가 다른 블록에서 증명을 생성할 수 있다.

### 2.4 설정/권한

- `onlyOwner`: verifier 교체, 화이트리스트, 수수료, 제재, 세틀먼트 관리.
- `onlyRelayer` modifier: `settleWithDex` 는 릴레이어 레지스트리 skip(마켓 오더 개방).
- 릴레이어 바인딩: 증명 안에 릴레이어 주소가 포함 → 다른 주소 대체 불가.
- `_requireNotSanctioned` : 세틀·클레임에서 송신자·수령자 제재 확인.
- 모든 상태 변경 함수에 `nonReentrant`.

### 2.5 수수료 라우팅

```
     sellAmount (taker → maker 방향)
       │
       ├─ feeTokenMaker  ─► (FeeVault set) → FeeVault.deposit(maker.relayer, ...)
       │                    (FeeVault unset)→ 직접 maker.relayer 로 transfer
       │
       └─ totalLockedMaker ─► PrivateSettlement 로 이동, Claims Group 등록

     DEX 플로우:
       sellAmount ─► [dexPlatformFeeBps 차감 → platformRevenue]
                   ─► Router swap
                   ─► amountOut ≥ totalLocked 검증
                   ─► 잉여(positive slippage) → platformRevenue
```

### 2.6 이벤트

`PrivateSettled`, `PrivateSettledAuth`, `SettledWithDex`, `DexPlatformFeeCollected`, `DexSurplusCollected`, `PrivateCancel`, `ScatterDirect`, `ScatterDirectAuthSettled`, `PrivateClaim`, 그리고 각종 구성 이벤트.

### 2.7 연동

- `CommitmentPool`: `insertCommitment`, `transferToSettlement`, `withdrawFor`, `transferFee`
- `FeeVault`: `deposit`, `depositPlatformRevenue`
- `RelayerRegistry`: `isActiveRelayer`, `getSettlementInfo`
- `SettleVerifyLib`: `packSettleSignals`, `packAuthSignals`, `validateCrossSide`, `validateDexProof`, `validateScatterAuth`, `validateTimestampWindow`, `requireDistinctClaimsRoots`, `maybeInsertCommitment`, `registerClaimsGroup`
- Verifier 계열: Groth16 증명 검증
