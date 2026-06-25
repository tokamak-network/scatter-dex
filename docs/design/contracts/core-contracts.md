# 핵심 컨트랙트 상세

## 1. CommitmentPool.sol

> 파일: `contracts/src/zk/CommitmentPool.sol`
> 상속: `IncrementalMerkleTree`, `ReentrancyGuardUpgradeable`, `PausableUpgradeable`, `Ownable2StepUpgradeable` (프록시 업그레이드형)

### 1.1 역할

- 모든 사용자 예치금의 **UTXO 에스크로** 역할.
- 커밋먼트를 Poseidon Merkle tree 에 삽입·관리(deposit / insertCommitment).
- Nullifier 세트로 이중지출 방지.
- 세틀먼트 계약에 대해 **자금 이동 허가**(withdraw / transfer) 제공.

### 1.2 주요 상태 변수

| 변수 | 타입 | 설명 |
|------|------|------|
| `withdrawVerifier` | `IVerifier` (set-once in `initialize`) | 출금 증명용 Groth16 verifier (프록시 이전엔 immutable) |
| `depositVerifier` | `IDepositVerifier` (set-once in `initialize`) | 예치 증명용 verifier |
| `authorizedSettlement` | `address` | 허가된 PrivateSettlement 컨트랙트 |
| `nullifiers` | `mapping(uint256 => bool)` | 출금 에스크로 nullifier 소진 기록 |
| `whitelistedTokens` | `mapping(address => bool)` | 토큰 허용 리스트(O(1) 핫패스 체크) |
| `_whitelistedTokenSet` | `EnumerableSet.AddressSet` (private) | 위 매핑의 열거 가능한 미러 — `getWhitelistedTokens` 가 전체 목록 반환 |
| `sanctionsList` | `ISanctionsList` (optional) | 제재 주소 확인 |
| `identityGate` | `IIdentityRegistry` (optional) | zk-X509 신원 게이트. `address(0)` = 비활성. deposit·withdraw 양쪽에 적용 |
| `BN254_FIELD_MODULUS` | `uint256 constant` | 필드 범위 체크 상수 |
| pause 상태 | `PausableUpgradeable` (ERC-7201) | 비상 정지. `paused()` 게터 제공(구 `bool public paused` 는 deprecated placeholder) |

### 1.3 외부 함수

| 함수 | 호출자 | 설명 |
|------|--------|------|
| `deposit(proofA,B,C, commitment, token, amount)` | 사용자 | 예치 증명 검증 후 tree 에 commitment 삽입. `transferFrom` 과 정확한 금액 바인딩 검증. |
| `withdraw(proof…, root, nullifierHash, newCommitment, token, amount, recipient, relayer)` | 사용자/릴레이어 | 출금 증명 검증 → nullifier 소진 → 잔액 차이만큼 change commitment 삽입. |
| `withdrawFor(...)` | `authorizedSettlement` 만 | 세틀먼트 경로용(세틀먼트 중 pause 여부 무시). |
| `insertCommitment(commitment)` | `authorizedSettlement` 만 | 세틀 후 잔여 commitment 를 tree 에 삽입, leafIndex 반환. |
| `transferToSettlement(token, amount)` | `authorizedSettlement` 만 | 클레임 집행을 위해 토큰을 PrivateSettlement 로 이동. |
| `transferFee(recipient, token, amount)` | `authorizedSettlement` 만 | 릴레이어 수수료 전송. **수수료 상한은 여기가 아니라 상류 PrivateSettlement 에서 주문 단위로 적용**(불변식 4 참조) — `transferFee` 자체엔 풀 잔액 % 캡 없음. |
| `getWhitelistedTokens()` | view | 현재 화이트리스트 토큰 전체 배열(오프체인/프론트 소스). 순서 비보장. |
| `syncWhitelistedTokenSet(tokens[])` | owner | 업그레이드 후 backfill — 레거시 매핑 항목을 열거 세트에 시드(매핑에 여전히 true 인 것만 add, 멱등). |
| `queueSetAuthorizedSettlement / activateAuthorizedSettlement` | owner | 세틀먼트 변경 24시간 타임락. |
| `setSanctionsList / setTokenWhitelist / setIdentityGate` | owner | 구성 관리. |
| `pause() / unpause()` | owner | 비상 정지/해제(`PausableUpgradeable`). deposit·withdraw 는 `whenNotPaused`, `withdrawFor` 는 미적용(진행 중 세틀 완료 보장). |

### 1.4 핵심 불변식

1. **커밋먼트 바인딩**: 예치 증명이 `Poseidon(TAG_COMMITMENT_V2, secret, token, amount, salt, pubKeyAx, pubKeyAy) == commitment` 를 강제.
2. **Nullifier 유일성**: `!nullifiers[nullifierHash]` 검사로 이중 출금 방지.
3. **루트 최신성**: 출금 증명의 `root` 는 `isKnownRoot()` 링 버퍼에 존재해야 함.
4. **수수료 상한(상류 적용)**: 릴레이어 수수료는 `CommitmentPool.transferFee` 가 아니라 **PrivateSettlement(`SettleVerifyLib`)** 에서 주문 단위로 사용자 서명 `maxFee` 대비 검증된다 — `validateCrossSide`: `feeToken × 10000 ≤ buyAmount × maxFee`(각 쪽), `validateScatterAuth`: `fee × 10000 ≤ sellAmount × maxFee`. `transferFee` 에 풀 잔액 % 캡을 두면 유동성 초기처럼 한 쌍이 풀 잔액 대부분을 차지하는 정당한 세틀까지 거부되므로 두지 않는다. 운영자 드레인 방지는 `authorizedSettlement` 24시간 타임락이 담당.
5. **신원 게이트(선택)**: `identityGate` 가 설정되면 활성 참여자가 현재 zk-X509 검증 상태여야 한다 — deposit 의 `msg.sender`, withdraw 의 `msg.sender` 와 `recipient`. `isVerified` 가 만료 신원도 false 로 처리하므로 만료분도 거부. `address(0)` = 비활성(sanctions 와 동일 opt-in). `withdrawFor`(세틀 경로)는 caller 검사를 건너뛰고 수령자만 `_executeClaim` 에서 게이팅.
6. **필드 범위 검증**: `commitment`, `amount` 를 BN254 modulus 이하로 선검사(증명 실패 시 15만 가스 절약).
7. **Fee-on-transfer 방어**: `transferFrom` 전후 잔액 차분 비교.

### 1.5 이벤트

- `CommitmentInserted(commitment, leafIndex, timestamp)`
- `Withdrawal(recipient, nullifierHash, newCommitment, amount)`
- `FeeTransferred(recipient, token, amount)`
- `TokenWhitelistUpdated`, `AuthorizedSettlementUpdated`, `SettlementChangeQueued`, `SanctionsListUpdated`, `IdentityGateUpdated`
- `Paused(address)` / `Unpaused(address)` 는 `PausableUpgradeable` 가 발행(구 `Paused(bool)` 폐기)

---

## 2. PrivateSettlement.sol

> 파일: `contracts/src/zk/PrivateSettlement.sol`
> 시스템에서 가장 큰 컨트랙트 — ZK 세틀먼트 엔진 본체.

### 2.1 역할

3종 세틀먼트 플로우를 통합 관리하고 Claims Group(수령자 Merkle tree) 을 등록, 이후 사용자가 개별 Claim 증명으로 토큰을 수령하도록 한다.

| 플로우 | 증명 형태 | 호출자 | 용도 |
|--------|----------|--------|------|
| `settleAuth` | half-proof 2개(`authorize.circom` ×2) | maker.relayer 또는 taker.relayer | **메인 플로우**. 사용자가 로컬에서 증명 생성, 릴레이어는 witness 불가시. |
| `settleWithDex` | half-proof 1개 + DEX 스왑 | self-relayer (permissionless) | 시장가 주문용. 화이트리스트된 DEX 라우터로 스왑 후 Claims 등록. |
| `scatterDirectAuth` | authorize 증명 1개 | 증명에 바인딩된 릴레이어 | 동일 토큰 스캐터의 half-proof 판(`sellToken == buyToken` 강제). |

> **제거됨(2026-06-25, #1094):** 레거시 `scatterDirect`(`withdraw.circom` 출금 증명 변형)는 withdraw proof가 `claimsRoot`를 바인딩하지 않아 릴레이어가 임의 분배를 등록할 수 있는 죽은 코드였다(S-M14에서 proof-bound `scatterDirectAuth`로 마이그레이션 완료, 프로덕션 호출자 0). 동일 토큰 스캐터는 `scatterDirectAuth`를 사용한다.

추가 기능:
- `cancelPrivate` — 에스크로 회전(old nullifier burn + new commitment 삽입) 으로 대기중 주문 취소.
- `claimWithProof / claimWithProofBatch` — Claims Group 내 leaf 증명 후 토큰 수령(최대 20개 배치, WETH → ETH 자동 언래핑).

### 2.2 주요 상태

| 변수 | 설명 |
|------|------|
| `pool` | 연동된 CommitmentPool (`initialize` 1회 설정, 재할당 없음) |
| `authorizeVerifierByTier[uint8]` | 티어(16/64/128 = max claims per side)별 authorize verifier 레지스트리. `setAuthorizeVerifier(tier, addr)` 로 owner 가 교체, `address(0)` = 해당 티어 비활성(`TierNotConfigured`) |
| `claimVerifierByTier[uint8]` | 티어별 claim verifier 레지스트리(티어마다 claims tree 깊이가 달라 단일 verifier 불가) |
| `batchAuthorizeVerifierByTier[uint8]` | 선택적 5-페어링 배치 verifier(양측 동일 티어일 때만 사용) |
| `cancelVerifier` | cancel.circom verifier(티어 무관 단일) |
| `nullifiers`, `nonceNullifiers`, `claimNullifiers` | 3종 nullifier 세트 |
| `claimsGroups[root] → {totalLocked, totalClaimed, token, tier}` | Claims Group 등록부. `tier` 로 claim 시 verifier 디스패치 |
| `relayerRegistry`, `feeVault`, `sanctionsList`, `identityGate` | 선택적 모듈(`address(0)` = 비활성) |
| `whitelistedTokens`(+열거 미러), `whitelistedDexRouters` | 허용 리스트 |
| `dexPlatformFeeBps` | DEX 플랫폼 수수료(0–500bps = 최대 5%) |
| `weth` | WETH 주소(자동 언래핑용) |

### 2.3 settleAuth 의 교차 검증 (핵심 불변식)

`settleAuth` 는 각 쪽이 독립적으로 생성한 두 증명을 결합해 다음을 온체인에서 재검증한다:

| 제약 | 수식 |
|------|------|
| **C1** 토큰 호환 | `maker.sellToken == taker.buyToken` 그리고 `maker.buyToken == taker.sellToken` |
| **C2** 가격 보호 | `taker.sellAmount × taker.buyAmount ≥ maker.sellAmount × maker.buyAmount` |
| **C4** 클레임+수수료 캡 | `totalLockedMaker + feeTokenMaker ≤ taker.sellAmount` (반대편 동일) |
| **수수료 상한** | `feeTokenMaker × 10000 ≤ maker.buyAmount × maker.maxFee` (taker 쪽 동일: `feeTokenTaker × 10000 ≤ taker.buyAmount × taker.maxFee`) — 각 쪽 사용자 서명 `maxFee` 기준(`SettleVerifyLib.validateCrossSide`) |
| **만료** | 각 쪽의 `expiry ≥ block.timestamp` |
| **상호 배제** | `makerNullifier ≠ takerNullifier`, `makerNonceNullifier ≠ takerNonceNullifier` |
| **루트 유효성** | 각 쪽의 `commitmentRoot` 가 pool 의 최근 링 버퍼에 존재 (비동기 루트 허용) |

> **비동기 루트**: `settleAuth` 는 maker/taker 가 각기 다른 루트를 사용하는 것을 허용한다(각자 링 버퍼 내 존재만 요구). nullifier 가 이중지출을 막기 때문에 안전하며, 이로써 maker/taker 가 다른 블록에서 증명을 생성할 수 있다.

### 2.4 설정/권한

- `onlyOwner`: verifier 레지스트리, 화이트리스트, 수수료, 제재·신원 게이트 관리.
- 릴레이어 레지스트리 검사(설정 시): `settleAuth` 는 양쪽 릴레이어 활성 여부를 인라인 검사, `scatterDirectAuth` 는 증명에 바인딩된 릴레이어를 검사. `settleWithDex` 와 `cancelPrivate` 는 레지스트리 검사 없음(permissionless — 시장가 주문/사용자 직접 취소).
- 릴레이어 바인딩: 증명 안에 릴레이어 주소가 포함 → 다른 주소 대체 불가.
- `_requireNotSanctioned`: 세틀 제출자·클레임 수령자 제재 확인. `_requireIdentityVerified`: `identityGate` 설정 시 클레임 수령자의 zk-X509 검증 상태 확인.
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

`PrivateSettledAuth`, `SettledWithDex`, `DexPlatformFeeCollected`, `DexSurplusCollected`, `PrivateCancel`, `ScatterDirectAuthSettled`, `PrivateClaim`, 그리고 각종 구성 이벤트.

### 2.7 연동

- `CommitmentPool`: `insertCommitment`, `transferToSettlement`, `withdrawFor`, `transferFee`
- `FeeVault`: `deposit`(릴레이어 수수료), `accrueDexFee` / `accrueDexSurplus`(DEX 플랫폼 수익)
- `RelayerRegistry`: `isActiveRelayer`
- `SettleVerifyLib`: `packAuthSignals`, `validateCrossSide`, `validateDexProof`, `validateScatterAuth`, `requireDistinctClaimsRoots`, `maybeInsertCommitment`, `registerClaimsGroup`
- Verifier 계열: Groth16 증명 검증(티어별 레지스트리 디스패치)
