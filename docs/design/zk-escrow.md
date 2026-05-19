# Design: ZK Escrow + Private Settlement

**Status: HISTORICAL DESIGN RECORD** — this document captures the original monolithic `settle.circom` / `settlePrivate()` design. That path has since been superseded by the **Half-proof architecture** (`circuits/authorize.circom` + `PrivateSettlement.settleAuth(makerProof, takerProof)`), and the legacy `circuits/settle.circom`, `ISettleVerifier.sol`, `settlePrivate()` function, and `PrivateSettled` event have been removed. For the current settlement flow, see [../architecture/architecture-v2.md](../architecture/architecture-v2.md) and [circuit-split/design.md](circuit-split/design.md). The sections below are preserved for historical/archival reference.

## Overview

에스크로를 Merkle commitment 기반으로 바꾸고, settle 시 ZK proof로 거래 당사자를 숨김.

## Architecture

```
현재:
  deposit → deposits[address][token] = balance (공개)
  settle  → settle(makerOrder, takerOrder) (양쪽 주소 공개)
  claim   → claimHash로 수신자 숨김

제안:
  deposit → Merkle tree에 commitment 추가 (주소/잔액 숨김)
  settle  → settle(zkProof, claimHashes) (주소 없음)
  claim   → Stealth address + claimHash (수신자 숨김)
```

## 1. ZK Escrow (Deposit)

### 구조

```
commitment = H(ownerSecret, token, balance, salt)

온체인 저장:
  - commitmentTree: Merkle tree of all commitments
  - commitmentRoot: current Merkle root
  - nullifiers: used nullifier tracking (이중 사용 방지)
```

### Deposit 흐름

```
1. 유저가 ownerSecret 생성 (로컬, 비공개)
2. commitment = H(ownerSecret, token, balance, salt) 계산
3. deposit(commitment, token, amount) 호출
   - identityGate.isVerified(msg.sender) 확인
   - token 전송 받음
   - commitment을 Merkle tree에 추가
   - commitmentRoot 업데이트
4. 유저가 commitment 정보를 로컬에 보관
```

### 프라이버시

- deposit TX에서 msg.sender는 보임 (불가피)
- 하지만 commitment과 msg.sender의 연결은 이 TX에서만 보임
- 이후 settle/claim에서는 commitment으로만 참조
- 같은 유저가 여러 번 deposit하면 commitment이 다 다름 (salt)

### 한계

- deposit TX 자체는 msg.sender 공개 (온체인 TX 한계)
- deposit 직후 settle하면 타이밍으로 연결 가능 → 시간 지연 필요

## 2. Private Settlement (Settle)

### ZK Proof 내용

```
prove {
  // Private inputs (숨겨짐)
  makerSecret, makerSalt, makerBalance, makerToken
  takerSecret, takerSalt, takerBalance, takerToken
  makerSig, takerSig

  // Public inputs (공개됨)
  commitmentRoot    // 현재 Merkle root
  newCommitmentRoot // 업데이트된 Merkle root
  claimHashes[]     // 수신자용 해시
  nullifier1        // maker의 이전 commitment 무효화
  nullifier2        // taker의 이전 commitment 무효화
  newCommitment1    // maker의 새 commitment (잔액 차감 후)
  newCommitment2    // taker의 새 commitment (잔액 차감 후)

  // 증명하는 것
  1. maker/taker의 commitment이 현재 Merkle tree에 존재
  2. maker/taker의 서명이 유효
  3. 토큰/가격이 호환
  4. 에스크로 잔액 충분
  5. 새 commitment = 이전 잔액 - 거래 금액
  6. nullifier가 올바르게 계산됨
  7. claimHash가 올바르게 생성됨
}
```

### Settle 흐름

```
1. 릴레이어가 양쪽 주문 수신 (오프체인)
   - 주문에 주소 없음, ZK proof of escrow만 있음
2. 릴레이어가 매칭
3. ZK proof 생성 (릴레이어 또는 유저)
4. settle(proof, nullifiers, newCommitments, claimHashes) 온체인
   - Verifier가 proof 검증
   - nullifier 등록 (이중 사용 방지)
   - 새 commitment을 tree에 추가
   - claimHash로 ClaimSchedule 생성
5. 온체인에 보이는 것: proof, nullifiers, newCommitments, claimHashes
   → 누가 거래했는지 안 보임
```

## 3. Claim (Stealth Address)

기존 claimHash 메커니즘 + Stealth address 결합:

```
1. maker가 taker의 meta-address로 stealth address 생성
2. claimHash = H(secret, stealthAddress)
3. settle 시 claimHash 온체인 등록
4. taker가 stealth address의 개인키 유도 → claim
```

## 4. 프라이버시 분석

| 단계 | 공개 | 숨김 |
|------|------|------|
| Deposit | msg.sender, token, amount | commitment 내용 |
| Settle | proof, nullifiers, claimHashes | maker, taker, 거래 쌍 |
| Claim | stealthAddress, amount | 수신자 실제 신원 |

### 남은 위험

- **deposit TX**: msg.sender 공개 → commitment과 연결 가능
  - 완화: 시간 지연, 여러 deposit 혼합
- **릴레이어**: 주문 내용을 알 수 있음 (매칭 필요)
  - 완화: 주소 없이 proof만 받으면 릴레이어도 모름
- **통계적 분석**: 금액/토큰/타이밍으로 추론 가능
  - 완화: 고정 금액 denomination, 시간 지연

## 5. 구현 고려사항

### ZK 회로 (SP1 zkVM)

zk-X509에서 이미 SP1 사용 중 → 같은 인프라 활용 가능

```
회로가 검증해야 할 것:
1. Merkle proof (commitment이 tree에 있는지)
2. ECDSA 서명 검증 (주문 유효성)
3. 산술 연산 (잔액 차감, 가격 호환)
4. 해시 연산 (nullifier, commitment, claimHash)
```

### 가스비

- ZK proof 검증: ~300K gas (Groth16)
- 현재 settle: ~450K gas
- 차이: proof 검증 비용 추가되지만, calldata 감소로 상쇄 가능

### 증명 생성 시간

- SP1 Groth16: 수 분 (서버급)
- 릴레이어가 생성하면 유저 대기 시간 증가
- 유저가 생성하면 클라이언트 부담

## 6. 단계적 접근

Phase 1: Stealth address for claims (ZK 불필요)
Phase 2: ZK escrow (Merkle commitment 기반 deposit)
Phase 3: ZK settle (private settlement proof)

## 7. Claims 구조 은닉 (Claim ZK Proof)

### 문제

Phase 3에서 maker/taker 주소를 숨기더라도 `claimHashes[]`가 public input으로 공개됨.
settle tx의 calldata/이벤트를 통해:
- 클레임 개수
- 각 클레임 금액, releaseDelay
- claimHash 목록
이 전부 노출되어 정산 ↔ 클레임 연결이 추적 가능.

### 해결: claimsRoot

개별 claimHash 배열 대신 Merkle root 1개만 공개.

```
현재:  settle(proof, nullifiers, newCommitments, [hash1, hash2, hash3])
                                                  ↑ 쪼갠 구조 노출

제안:  settle(proof, nullifiers, newCommitments, claimsRoot, totalLocked)
                                                  ↑ root 1개만 공개
```

### Claim Merkle Tree 구조

```
leaf = Poseidon(secret, recipient, token, amount, releaseTime)

        claimsRoot
        /        \
     H01          H23
    /    \       /    \
 leaf0  leaf1  leaf2  leaf3
```

하나의 settle에서 생긐 모든 claims (maker측 + taker측)를 하나의 tree로 구성.
tree depth는 고정 (depth=4 → 최대 16 claims, 현재 max 10+10=20이므로 depth=5).

### 온체인 저장 변경

```solidity
// 기존: 개별 claimHash → schedule
mapping(bytes32 => ClaimSchedule) public schedules;

// 제안: claimsRoot → 전체 잠금 정보
struct ClaimsGroup {
    bytes32 claimsRoot;     // Merkle root of all claim leaves
    address token;          // 잠긴 토큰 (maker측/taker측 별도 그룹)
    uint96  totalLocked;    // 그룹 내 총 잠금 금액
    uint96  totalClaimed;   // 지금까지 클레임된 총액
}
mapping(bytes32 => ClaimsGroup) public claimsGroups;

// 이중 클레임 방지
mapping(bytes32 => bool) public claimNullifiers;
```

### Settle 회로 변경

기존 Phase 3 회로에 추가:

```
public inputs:
  commitmentRoot, newCommitmentRoot
  nullifier1, nullifier2
  newCommitment1, newCommitment2
  claimsRootMaker         // maker측 claims의 Merkle root
  claimsRootTaker         // taker측 claims의 Merkle root
  totalLockedMaker        // maker측 총 잠금액 (검증용)
  totalLockedTaker        // taker측 총 잠금액

private inputs:
  (기존) + makerClaims[], takerClaims[]

prove:
  (기존) +
  claimsRootMaker = MerkleRoot(makerClaims[])
  claimsRootTaker = MerkleRoot(takerClaims[])
  sum(makerClaims[].amount) == totalLockedMaker
  sum(takerClaims[].amount) == totalLockedTaker
  totalLockedMaker ≤ takerSellAmount - takerFee
  totalLockedTaker ≤ makerSellAmount - makerFee
  각 claim의 releaseDelay ≥ minReleaseDelay
```

### Claim 회로 (신규)

```
public inputs:
  claimsRoot        // settle 시 등록된 root
  nullifier         // 이중 클레임 방지
  amount            // 수령 금액
  token             // 토큰 주소
  recipient         // 수신자 주소 (스텔스 가능)
  releaseTime       // 릴리스 시점

private inputs:
  secret            // 클레임 시크릿
  leafIndex         // 트리 내 위치
  merklePath[]      // inclusion proof 경로

prove:
  1. leaf = Poseidon(secret, recipient, token, amount, releaseTime)
  2. MerkleProof(leaf, leafIndex, merklePath) == claimsRoot
  3. nullifier = Poseidon(secret, leafIndex)
```

컨트랙트 검증:
```solidity
function claimWithProof(
    bytes proof,
    bytes32 claimsRoot,
    bytes32 nullifier,
    address token,
    uint96  amount,
    address recipient
) external {
    // 1. claimsRoot가 등록되어 있는지 확인
    ClaimsGroup storage group = claimsGroups[claimsRoot];
    require(group.totalLocked > 0, "unknown claimsRoot");

    // 2. nullifier 미사용 확인
    require(!claimNullifiers[nullifier], "already claimed");

    // 3. 총 클레임액 초과 확인
    require(group.totalClaimed + amount <= group.totalLocked, "exceeds locked");

    // 4. ZK proof 검증
    require(claimVerifier.verify(proof, [claimsRoot, nullifier, amount, token, recipient, releaseTime]));

    // 5. releaseTime 확인 (proof에서 검증된 값 사용)
    // → releaseTime이 public input이므로 컨트랙트에서 block.timestamp >= releaseTime 체크

    // 6. 상태 업데이트 + 토큰 전송
    claimNullifiers[nullifier] = true;
    group.totalClaimed += amount;
    IERC20(token).transfer(recipient, amount);
}
```

### 프라이버시 효과

| 항목 | Phase 3 (기존) | Phase 3 + Claims 은닉 |
|------|---------------|---------------------|
| maker/taker 주소 | 숨김 | 숨김 |
| 거래 토큰/금액 | 숨김 | 숨김 |
| 클레임 개수 | **노출** | **숨김** |
| 각 클레임 금액 | **노출** | **숨김** |
| releaseDelay 패턴 | **노출** | **숨김** |
| 정산 ↔ 클레임 연결 | **가능** | **불가** |
| 클레임 시 수신자 | 노출 | 노출 (스텔스로 완화) |

### 가스비 비교

| 동작 | 현재 | Phase 3 + Claims 은닉 |
|------|------|---------------------|
| settle | ~450K | ~300K (calldata 감소 + proof 검증) |
| claim (직접) | ~60K | ~260K (proof 검증 +200K) |
| claim (gasless) | ~80K | ~280K (proof 검증 +200K) |

클레임 비용 증가가 단점이지만, settle 비용 감소 + 프라이버시 확보로 상쇄.

### 증명 생성

| 회로 | 생성 주체 | 예상 시간 | 비고 |
|------|----------|----------|------|
| Settle proof | 릴레이어 (서버) | ~10-30s | Merkle proof + 서명 검증 + 산술 |
| Claim proof | 클라이언트 (브라우저) | ~3-5s | Merkle inclusion만 (가벼움) |

Claim 회로는 Merkle inclusion + nullifier 계산만이라 constraint 수가 적음 (~10K).
브라우저 WASM (snarkjs)으로 충분히 실시간 생성 가능.

### 구현 스택

```
circom (Settle 회로 + Claim 회로)
  → snarkjs (trusted setup + 증명 생성)
  → Groth16 Verifier.sol (온체인 검증)

해시 함수: Poseidon (ZK-friendly, circomlib 제공)
Merkle tree: depth=5 (최대 32 leaves)
```

### Refund 처리

현재는 depositor가 `refundUnclaimed(claimHash)` 호출.
은닉 후에는 claimHash를 모르므로:

```
방법 1: 타임아웃 기반 일괄 환불
  - claimsGroup에 expiry 추가
  - expiry 이후 totalLocked - totalClaimed 전액 depositor에게 환불
  - depositor 주소도 ZK로 숨기려면 별도 회로 필요

방법 2: Depositor ZK proof 환불
  - depositor가 "이 claimsRoot를 생성한 사람"임을 증명
  - 미클레임 잔액 회수
```

방법 1이 단순하고 실용적. depositor 주소는 settle proof의 commitment에 이미 포함되어 있으므로,
claimsGroup에 `depositorCommitment`을 저장하고 환불 시 knowledge proof로 증명 가능.

## 8. Phase 3b: Private Settlement — 구체 설계

### 8.1 현재 settle()이 하는 일 (→ ZK로 옮겨야 할 것)

```
settle(makerSig, takerSig, makerOrder, takerOrder, makerFee, takerFee)

검증:
  1. maker ≠ taker (자기 거래 방지)
  2. EIP-712 서명 검증 (maker, taker)
  3. nonce 미사용 확인
  4. 만료 시간 확인
  5. 토큰 호환 (maker.sell == taker.buy, vice versa)
  6. 토큰 화이트리스트
  7. 가격 호환 (maker.sell × taker.sell ≤ maker.buy × taker.buy)
  8. 수수료 ≤ maxFee
  9. claims 합계 ≤ 수령액 - 수수료
  10. 에스크로 잔액 충분

실행:
  - nonce 소비
  - 에스크로 차감
  - 수수료 분배 (relayer + protocol)
  - dust 지급
  - ClaimSchedule 생성
  - Settled 이벤트 emit
```

### 8.2 ZK 안으로 들어가는 것 vs 컨트랙트에 남는 것

| 로직 | 위치 | 이유 |
|------|------|------|
| 서명 검증 | **ZK 회로** | 서명자 주소를 숨기려면 |
| nonce 검증 | **ZK 회로** (nullifier로 대체) | maker/nonce 매핑 노출 방지 |
| 만료 시간 | **ZK 회로** | public input으로 현재 시간만 전달 |
| 토큰 호환 | **ZK 회로** | 토큰 주소를 숨기려면 |
| 가격 호환 | **ZK 회로** | 금액을 숨기려면 |
| claims 합산 검증 | **ZK 회로** | claims 구조를 숨기려면 |
| 에스크로 잔액 | **ZK 회로** (Merkle proof) | commitment 기반 에스크로 (Phase 2) |
| 토큰 화이트리스트 | **컨트랙트** | public 정책, ZK에 넣을 필요 없음 |
| 수수료 분배 (relayer/protocol) | **컨트랙트** | 실제 토큰 전송은 온체인 |
| ClaimSchedule 생성 | **컨트랙트** (claimsRoot 저장) | 상태 변경은 온체인 |
| nullifier 등록 | **컨트랙트** | 이중 사용 방지 상태 |

### 8.3 새 컨트랙트 인터페이스

```solidity
function settlePrivate(
    bytes   calldata proof,           // Groth16 proof
    // ── Nullifiers (이전 commitment 무효화) ──
    bytes32 makerNullifier,           // maker의 에스크로 commitment nullifier
    bytes32 takerNullifier,           // taker의 에스크로 commitment nullifier
    bytes32 makerNonceNullifier,      // maker의 nonce nullifier (재사용 방지)
    bytes32 takerNonceNullifier,      // taker의 nonce nullifier
    // ── New commitments (잔액 업데이트) ──
    bytes32 makerNewCommitment,       // maker의 새 에스크로 commitment
    bytes32 takerNewCommitment,       // taker의 새 에스크로 commitment
    // ── Claims ──
    bytes32 claimsRootMaker,          // maker측 claims Merkle root
    bytes32 claimsRootTaker,          // taker측 claims Merkle root
    uint96  totalLockedMaker,         // maker측 총 잠금액
    uint96  totalLockedTaker,         // taker측 총 잠금액
    address tokenMaker,               // maker가 받을 토큰 (= taker의 sell 토큰)
    address tokenTaker,               // taker가 받을 토큰 (= maker의 sell 토큰)
    // ── Fee ──
    uint256 totalFee,                 // 총 수수료 (relayer에게)
    // ── Merkle roots ──
    bytes32 currentRoot               // 현재 commitment tree root (검증용)
) external nonReentrant {
    // 1. currentRoot가 유효한 Merkle root인지 확인
    require(knownRoots[currentRoot], "unknown root");

    // 2. nullifier 미사용 확인 + 등록
    require(!nullifiers[makerNullifier], "spent");
    require(!nullifiers[takerNullifier], "spent");
    require(!nonceNullifiers[makerNonceNullifier], "nonce used");
    require(!nonceNullifiers[takerNonceNullifier], "nonce used");
    nullifiers[makerNullifier] = true;
    nullifiers[takerNullifier] = true;
    nonceNullifiers[makerNonceNullifier] = true;
    nonceNullifiers[takerNonceNullifier] = true;

    // 3. 토큰 화이트리스트 확인
    require(whitelistedTokens[tokenMaker], "token not whitelisted");
    require(whitelistedTokens[tokenTaker], "token not whitelisted");

    // 4. ZK proof 검증
    require(settleVerifier.verify(proof, [
        currentRoot,
        makerNullifier, takerNullifier,
        makerNonceNullifier, takerNonceNullifier,
        makerNewCommitment, takerNewCommitment,
        claimsRootMaker, claimsRootTaker,
        totalLockedMaker, totalLockedTaker,
        tokenMaker, tokenTaker,
        totalFee
    ]));

    // 5. 새 commitment을 tree에 추가
    commitmentTree.insert(makerNewCommitment);
    commitmentTree.insert(takerNewCommitment);
    knownRoots[commitmentTree.root()] = true;

    // 6. claims 그룹 등록
    claimsGroups[claimsRootMaker] = ClaimsGroup({
        token: tokenMaker,
        totalLocked: totalLockedMaker,
        totalClaimed: 0,
        expiry: uint48(block.timestamp) + REFUND_WINDOW
    });
    claimsGroups[claimsRootTaker] = ClaimsGroup({
        token: tokenTaker,
        totalLocked: totalLockedTaker,
        totalClaimed: 0,
        expiry: uint48(block.timestamp) + REFUND_WINDOW
    });

    // 7. 수수료 분배
    // tokenMaker에서 makerFee, tokenTaker에서 takerFee
    // → totalFee는 proof 내에서 검증됨
    // → 실제 토큰 전송은 commitment 차감으로 처리됨 (에스크로 내부)

    emit PrivateSettled(
        makerNullifier, takerNullifier,
        claimsRootMaker, claimsRootTaker
    );
}
```

### 8.4 Settle ZK 회로 — 전체 명세

```
template SettleCircuit(commitTreeDepth, claimsTreeDepth) {
    // ════════════════════════════════════════
    //  PUBLIC INPUTS (온체인에 공개)
    // ════════════════════════════════════════
    signal input currentRoot;           // commitment tree root
    signal input makerNullifier;        // maker 에스크로 nullifier
    signal input takerNullifier;        // taker 에스크로 nullifier
    signal input makerNonceNullifier;   // maker nonce nullifier
    signal input takerNonceNullifier;   // taker nonce nullifier
    signal input makerNewCommitment;    // maker 새 commitment
    signal input takerNewCommitment;    // taker 새 commitment
    signal input claimsRootMaker;       // maker측 claims root
    signal input claimsRootTaker;       // taker측 claims root
    signal input totalLockedMaker;      // maker측 총 잠금액
    signal input totalLockedTaker;      // taker측 총 잠금액
    signal input tokenMaker;            // maker가 받을 토큰
    signal input tokenTaker;            // taker가 받을 토큰
    signal input totalFee;              // 총 수수료
    signal input currentTimestamp;      // block.timestamp (컨트랙트에서 주입)

    // ════════════════════════════════════════
    //  PRIVATE INPUTS (숨겨짐)
    // ════════════════════════════════════════

    // ── Maker 에스크로 commitment ──
    signal input makerSecret;
    signal input makerToken;            // maker의 sell 토큰
    signal input makerBalance;          // maker의 에스크로 잔액
    signal input makerSalt;
    signal input makerMerklePath[commitTreeDepth];
    signal input makerMerkleIndices[commitTreeDepth];

    // ── Taker 에스크로 commitment ──
    signal input takerSecret;
    signal input takerToken;            // taker의 sell 토큰
    signal input takerBalance;
    signal input takerSalt;
    signal input takerMerklePath[commitTreeDepth];
    signal input takerMerkleIndices[commitTreeDepth];

    // ── 주문 정보 ──
    signal input makerSellAmount;
    signal input makerBuyAmount;
    signal input makerMaxFee;
    signal input makerExpiry;
    signal input makerNonce;
    signal input takerSellAmount;
    signal input takerBuyAmount;
    signal input takerMaxFee;
    signal input takerExpiry;
    signal input takerNonce;

    // ── 수수료 ──
    signal input makerFee;              // bps
    signal input takerFee;              // bps

    // ── 서명 (ECDSA) ──
    signal input makerSigR, makerSigS;
    signal input makerPubKeyX, makerPubKeyY;
    signal input takerSigR, takerSigS;
    signal input takerPubKeyX, takerPubKeyY;

    // ── Claims 배열 ──
    signal input makerClaims[maxClaims][3];  // [amount, releaseDelay, leafHash]
    signal input makerClaimsCount;
    signal input takerClaims[maxClaims][3];
    signal input takerClaimsCount;

    // ════════════════════════════════════════
    //  CONSTRAINTS (증명하는 것)
    // ════════════════════════════════════════

    // 1. COMMITMENT MEMBERSHIP
    //    maker/taker의 commitment이 현재 Merkle tree에 존재
    makerCommitment = Poseidon(makerSecret, makerToken, makerBalance, makerSalt)
    MerkleProof(makerCommitment, makerMerklePath, makerMerkleIndices) === currentRoot
    // taker도 동일

    // 2. NULLIFIER 계산
    makerNullifier === Poseidon(makerSecret, makerSalt)
    takerNullifier === Poseidon(takerSecret, takerSalt)
    makerNonceNullifier === Poseidon(makerSecret, makerNonce)
    takerNonceNullifier === Poseidon(takerSecret, takerNonce)

    // 3. TOKEN COMPATIBILITY
    makerToken === tokenTaker    // maker가 파는 토큰 = taker가 받는 토큰
    takerToken === tokenMaker    // taker가 파는 토큰 = maker가 받는 토큰

    // 4. PRICE COMPATIBILITY
    makerSellAmount * takerSellAmount <= makerBuyAmount * takerBuyAmount

    // 5. EXPIRY
    currentTimestamp <= makerExpiry
    currentTimestamp <= takerExpiry

    // 6. FEE VALIDATION
    makerFee <= makerMaxFee
    takerFee <= takerMaxFee
    totalFee === (makerSellAmount * makerFee + takerSellAmount * takerFee) / 10000

    // 7. CLAIMS SUM VALIDATION
    makerFeeAmount = takerSellAmount * takerFee / 10000
    makerDistributable = takerSellAmount - makerFeeAmount
    sum(makerClaims[].amount) <= makerDistributable
    sum(makerClaims[].amount) === totalLockedMaker
    // taker도 동일

    // 8. CLAIMS ROOT
    claimsRootMaker === MerkleRoot(makerClaimLeaves[])
    // where makerClaimLeaves[i] = Poseidon(claimHash_i, amount_i, releaseDelay_i, tokenMaker)
    claimsRootTaker === MerkleRoot(takerClaimLeaves[])

    // 9. ESCROW BALANCE
    makerBalance >= makerSellAmount
    takerBalance >= takerSellAmount

    // 10. NEW COMMITMENT
    makerNewBalance = makerBalance - makerSellAmount
    makerNewCommitment === Poseidon(makerSecret, makerToken, makerNewBalance, newMakerSalt)
    // taker도 동일

    // 11. ECDSA SIGNATURE (가장 무거운 부분)
    //     주문 해시에 대한 maker/taker 서명 검증
    makerOrderHash = Poseidon(makerPubKey, makerToken, takerToken, makerSellAmount, ...)
    ECDSAVerify(makerOrderHash, makerSigR, makerSigS, makerPubKeyX, makerPubKeyY)
    // taker도 동일

    // 12. SELF-TRADE PREVENTION
    makerPubKeyX !== takerPubKeyX OR makerPubKeyY !== takerPubKeyY
}
```

### 8.5 회로 복잡도 추정

| 구성 요소 | Constraints 수 | 비고 |
|----------|---------------|------|
| Poseidon 해시 × ~12회 | ~3,000 | commitment, nullifier, claims |
| Merkle proof × 2 (depth 20) | ~12,000 | 에스크로 commitment 검증 |
| Claims Merkle root × 2 (depth 5) | ~1,500 | claims tree |
| ECDSA 검증 × 2 | **~1,500,000** | **지배적** |
| 산술 (가격, 수수료, 합산) | ~500 | |
| **총계** | **~1,517,000** | |

**ECDSA가 병목**입니다. 대안:

| 서명 방식 | Constraints | ZK 적합성 |
|----------|------------|----------|
| ECDSA (secp256k1) | ~750,000/건 | 나쁨 (비트 연산 많음) |
| EdDSA (Baby Jubjub) | ~5,000/건 | **좋음** (ZK-native 곡선) |
| Poseidon-based auth | ~2,000/건 | **최적** (해시만) |

### 8.6 서명 전략: EdDSA 전환

ECDSA를 ZK 안에서 검증하면 constraint가 150만 개 → 증명 생성 30-60초.

**현실적 해법: 주문 서명에 EdDSA (Baby Jubjub) 사용**

```
현재:  MetaMask → EIP-712 서명 (secp256k1/ECDSA)
제안:  MetaMask → EdDSA 키 유도 → 주문 서명 (Baby Jubjub/EdDSA)
```

유저 흐름:
1. MetaMask로 deterministic 메시지 서명 ("Sign to generate zkScatter trading key")
2. 그 서명의 해시로 Baby Jubjub 개인키 유도
3. 이후 주문 서명은 EdDSA로 수행
4. ZK 회로 내에서 EdDSA 검증 (~5,000 constraints, ECDSA 대비 150배 절감)

```
EdDSA 전환 시 constraint 추정:
  Poseidon × 12:        3,000
  Merkle proof × 2:    12,000
  Claims Merkle × 2:    1,500
  EdDSA 검증 × 2:      10,000
  산술:                    500
  ─────────────────────
  총계:               ~27,000    ← ECDSA 대비 55배 감소
```

이 수준이면:
- **증명 생성: ~2-5초** (서버), 브라우저 WASM도 가능
- **온체인 검증: ~200K gas** (Groth16)

### 8.7 전체 프라이버시 달성 현황 (Phase 3a+3b)

| 항목 | Phase 1 (현재) | Phase 2 | Phase 3a | Phase 3b |
|------|---------------|---------|----------|----------|
| 에스크로 잔액 | 공개 | **숨김** | 숨김 | 숨김 |
| 거래 당사자 | 공개 | 공개 | 공개 | **숨김** |
| 거래 금액 | 공개 | 공개 | 공개 | **숨김** |
| 거래 토큰 | 공개 | 공개 | 공개 | 공개* |
| 클레임 구조 | 공개 | 공개 | **숨김** | **숨김** |
| settle↔claim 연결 | 가능 | 가능 | **불가** | **불가** |
| 클레임 수신자 | 숨김 (스텔스) | 숨김 | 숨김 | 숨김 |

*토큰 주소는 claimsGroup 생성 시 필요 (컨트랙트가 어떤 토큰을 전송할지 알아야 함)
→ 토큰까지 숨기려면 모든 토큰을 하나의 pool로 통합해야 하는데, 이는 별도 연구 필요

### 8.8 단계별 개발 로드맵

```
Phase 1: Stealth address for claims                [완료]
    └── 스텔스 주소로 수신자 숨김

Phase 2: ZK Escrow                                  [구현 완료]
    ├── circuits/withdraw.circom (~10,794 constraints — incl. EdDSA gate added 2026-05-19)
    ├── contracts/src/zk/CommitmentPool.sol (18/18 테스트 통과)
    ├── contracts/src/zk/IncrementalMerkleTree.sol (Poseidon, depth 20)
    ├── contracts/src/zk/WithdrawVerifier.sol (Groth16)
    ├── frontend/app/lib/zk/commitment.ts (note 생성/Merkle tree)
    ├── frontend/app/lib/zk/prover.ts (브라우저 ZK proof)
    └── frontend/app/trade/private-escrow/page.tsx (UI)

Phase 3b: Private Settlement + Claims 은닉           [구현 완료]
    ├── circuits/settle.circom (30,021 constraints, EdDSA)
    ├── circuits/claim.circom (1,535 constraints)
    ├── contracts/src/zk/PrivateSettlement.sol (settlePrivate + claimWithProof)
    ├── contracts/src/zk/SettleVerifier.sol + ClaimVerifier.sol (Groth16)
    ├── frontend/app/lib/zk/eddsa.ts (Baby Jubjub 키 유도/서명)
    └── relayer/src/core/zk-prover.ts (서버사이드 proof 생성)
```

## 9. 단계적 접근 (최종)

Phase 1: Stealth address for claims                  [완료]
Phase 2: ZK escrow (Merkle commitment 기반 deposit)   [구현 완료]
Phase 3b: Private settlement + claims 은닉            [구현 완료]

완료:
- [x] 통합 테스트 (E2E: ZK proof 생성 + off-chain 검증, 4/4 통과)
- [x] 컨트랙트 테스트 (Solidity: 165/165 통과)
- [x] 프론트엔드 ZK settle UI (Private Order 페이지)
- [x] 릴레이어 ZK settle 파이프라인 (private-submitter.ts)
- [x] Deploy 스크립트 (DeployPrivateSettlement.s.sol)

남은 작업:
- [ ] Production trusted setup ceremony (multi-party)
- [ ] Withdraw proof 최적화 (현재 ~53초, GPU/서버 prover 도입 시 <5초)
- [ ] 릴레이어 기존 matcher → private-submitter 라우팅 통합
- [ ] 프론트엔드 Private Claim UI (claimWithProof 호출)

## 10. 구현 결과 (Resolved Questions)

- [x] ZK proof 생성: **Settle은 릴레이어(서버)**, Withdraw/Claim은 **유저(브라우저)**
- [x] 서명 방식: **EdDSA (Baby Jubjub)** — MetaMask 서명에서 키 유도
- [x] Merkle tree depth: **20** (1M commitments), claims tree: **depth 4** (16 leaves/side)
- [x] 컨트랙트 구조: **CommitmentPool(에스크로) + PrivateSettlement(정산)** 분리

## 11. Open Questions

- [ ] deposit 시 commitment과 msg.sender 연결을 어떻게 약화시킬 것인가?
- [ ] Claim proof의 releaseTime을 public input으로 노출하면 타이밍 추적 가능 — 숨길 방법?
- [ ] 토큰 주소가 claimsGroup에 공개됨 — 토큰까지 숨기려면 unified pool 필요

## 12. 규제 친화적 프라이버시 모델

zkScatter의 핵심 차별점: **온체인 프라이버시 + 오프체인 투명성**

| 레이어 | 프라이버시 | 수사 협조 |
|--------|-----------|----------|
| 온체인 | 거래자/금액/클레임 모두 숨김 | ZK proof만 보임 |
| 릴레이어 | 주문 내용 보유 | 영장 시 거래 기록 제공 가능 |
| IdentityGate | zk-X509 신원 인증 | KYC/AML 요건 충족 |

Tornado Cash와 달리 **규제 프레임워크 안에서 동작**하는 프라이버시 DEX.
기관 고객(헤지펀드, 기업) 수요 + 합법적 서비스 가능.
