# Design: ZK Settle + Stealth Address

**Status: ACTIVE**

## Architecture: A + ZK Settle + Stealth

릴레이어 모델 유지, settle TX만 ZK로 불투명화, claim에 Stealth address 적용.

```
오프체인 (릴레이어):
  - 주문 수신, 매칭 (기존과 동일)
  - 릴레이어가 양쪽 주문 내용을 앎 (컴플라이언스)
  - ZK proof 생성 → settle TX 제출

온체인:
  - settle(zkProof, nullifiers, claimHashes)
  - 누가 거래했는지 안 보임
  - claimHash → Stealth address로 수학적 프라이버시
```

## 프라이버시 분석

| 항목 | 릴레이어 | 온체인 관찰자 |
|------|----------|--------------|
| 거래 당사자 | 앎 (오프체인) | 모름 (ZK) |
| 거래 금액/토큰 | 앎 (오프체인) | 모름 (ZK) |
| 자금 목적지 | claimHash만 앎 | 모름 (Stealth) |
| 참여자 신원 | 모름 (zk-X509) | 모름 (zk-X509) |

## Phase 1: Stealth Address (컨트랙트 변경 없음)

### 변경 범위

프론트엔드 + 릴레이어만 변경. 컨트랙트는 claimHash 구조 그대로.

```
수신자: meta-address 공개 (spendingPubKey, viewingPubKey)
송신자: meta-address → stealth address 자동 생성
        claimHash = H(secret, stealthAddress)
수신자: 온체인 스캔 → stealth key 유도 → claim
```

### 파일

- `frontend/src/lib/stealth.ts` — 신규: stealth address 생성/스캔
- `frontend/src/components/OrderForm.tsx` — meta-address 입력 → stealth 생성
- `frontend/src/app/claim/page.tsx` — stealth key 유도 + claim
- `relayer/` — ephemeralPubKey 저장/전달

### 의존성

- EIP-5564 stealth address 표준
- secp256k1 elliptic curve 연산 (ethers.js로 가능)

## Phase 2: ZK Settle (컨트랙트 변경)

### 목표

settle TX calldata에서 maker/taker 주소, 금액, 토큰을 숨김.
proof만으로 유효한 거래임을 검증.

### 현재 settle

```solidity
function settle(
    bytes calldata makerSig,      // ← 제거
    bytes calldata takerSig,      // ← 제거
    Order calldata makerOrder,    // ← 제거 (ZK proof 내부로)
    Order calldata takerOrder,    // ← 제거 (ZK proof 내부로)
    uint256 actualFee             // ← 제거 (ZK proof 내부로)
) external nonReentrant
```

### 새 settle

```solidity
function settle(
    bytes calldata proof,           // ZK proof
    bytes32[] calldata nullifiers,  // maker/taker nonce 무효화
    bytes32[] calldata claimHashes, // 수신자용 해시
    uint256[] calldata claimAmounts,// claim 금액
    address[] calldata claimTokens, // claim 토큰
    uint48[] calldata releaseTimes  // release 시간
) external nonReentrant
```

### ZK 회로가 증명하는 것

```
Public inputs (온체인 공개):
  - nullifiers[]
  - claimHashes[]
  - claimAmounts[]
  - claimTokens[]
  - releaseTimes[]
  - relayerAddress (msg.sender)
  - settlementContractAddress
  - chainId

Private inputs (숨겨짐):
  - makerAddress, takerAddress
  - makerSig, takerSig
  - sellToken, buyToken
  - sellAmount, buyAmount
  - makerNonce, takerNonce
  - actualFee
  - makerEscrowBalance, takerEscrowBalance

증명 내용:
  1. makerSig → ecrecover → makerAddress 유효
  2. takerSig → ecrecover → takerAddress 유효
  3. makerAddress != takerAddress (self-trade 방지)
  4. sellToken == buyToken 호환 (cross-check)
  5. 가격 호환: sellAmount * takerSellAmount <= buyAmount * takerBuyAmount
  6. 수수료: actualFee <= makerMaxFee, actualFee <= takerMaxFee
  7. 에스크로 충분: deposits[maker][sellToken] >= sellAmount
  8. 에스크로 충분: deposits[taker][takerSellToken] >= takerSellAmount
  9. nullifiers 올바르게 계산
  10. claimHashes/amounts/tokens 올바르게 계산
  11. 수수료 분배 정확
```

### 에스크로 상태 업데이트 문제

ZK proof 안에서 에스크로 잔액을 검증하려면, 온체인 상태를 proof에 넣어야 함.

옵션 A: **에스크로는 기존 구조 유지, settle 시 컨트랙트가 차감**
```solidity
function settle(proof, ...) {
    // proof 검증
    verifier.verify(proof, publicInputs);

    // 에스크로 차감 — 하지만 maker 주소를 알아야 함!
    // → proof 내부에서 maker를 숨기면 차감 불가
}
```
→ 문제: 컨트랙트가 차감하려면 주소 필요

옵션 B: **에스크로를 commitment 기반으로 변경 (Phase 2.5)**
```solidity
// deposit 시 commitment 생성
mapping(bytes32 => bool) public commitments;

function deposit(bytes32 commitment, address token, uint256 amount) {
    // 인증 확인
    // 토큰 받음
    commitments[commitment] = true;
}

// settle 시 nullifier로 commitment 소비
function settle(proof, nullifiers, newCommitments, ...) {
    // proof가 "유효한 commitment을 소비하고 새 commitment을 생성"을 증명
    // nullifier 등록 (이중 사용 방지)
    // 새 commitment 추가
}
```

옵션 C: **에스크로 상태를 Merkle tree로**
```
온체인: escrowRoot (Merkle root만 저장)
오프체인: 각 유저가 자기 leaf 관리

settle proof:
  - "maker의 leaf가 현재 tree에 있다" (Merkle proof)
  - "잔액 >= sellAmount"
  - "새 leaf = 잔액 - sellAmount"
  - newEscrowRoot 출력
```

### 권장: 옵션 B (commitment 기반)

- 옵션 A는 불가 (주소 필요)
- 옵션 C는 복잡 (Merkle tree 관리)
- 옵션 B는 Tornado Cash 패턴으로 검증됨

## Phase 2.5: Commitment-based Escrow

### Deposit

```
유저:
  1. secret 생성 (로컬)
  2. commitment = H(secret, token, amount) 계산
  3. deposit(commitment, token, amount) 호출

컨트랙트:
  1. isVerified(msg.sender) 확인
  2. 토큰 받음
  3. commitments[commitment] = true
  4. emit Deposited(commitment, token, amount)
     (msg.sender는 이벤트에 남지만, commitment과의 연결은 시간이 지나면 약화)
```

### Spend (settle 시)

```
ZK proof:
  "나는 commitment의 secret을 알고, 잔액이 충분하다"
  → nullifier = H(secret, nonce) 출력
  → 새 commitment = H(secret, token, 잔액-금액) 출력 (잔돈)

컨트랙트:
  1. proof 검증
  2. nullifier 등록 (이중 사용 방지)
  3. 새 commitment 등록 (잔돈)
  4. claimSchedule 생성
```

### Withdraw

```
ZK proof:
  "나는 이 commitment의 소유자이고, 이 주소로 출금하겠다"
  → nullifier 출력
  → recipient 주소 출력

컨트랙트:
  1. proof 검증
  2. nullifier 등록
  3. 토큰을 recipient에게 전송
```

## 전체 흐름 (Phase 1 + 2 + 2.5 완료 후)

```
1. [Deposit] Alice: deposit(commitment, WETH, 10)
   → 온체인: commitment 등록, msg.sender 보임 (불가피)

2. [Order] Alice → 릴레이어: 주문 + ZK escrow proof
   → 릴레이어: 토큰/금액으로 매칭 (Alice 주소 모를 수도 있음)

3. [Match] 릴레이어: Alice ↔ Bob 매칭
   → ZK settle proof 생성

4. [Settle] 릴레이어: settle(proof, nullifiers, claimHashes)
   → 온체인: proof 유효, nullifier 등록, claimSchedule 생성
   → 누가 거래했는지 안 보임

5. [Claim] 수신자: stealth address로 claimRelease(secret)
   → 온체인: stealth address만 보임, 실제 신원 모름
```

## 개발 순서

| Phase | 내용 | 의존성 | 예상 규모 |
|-------|------|--------|----------|
| 1 | Stealth address | 없음 | 소 (프론트엔드) |
| 2 | ZK settle proof | SP1 zkVM | 중 (회로 개발) |
| 2.5 | Commitment escrow | Phase 2 | 중 (컨트랙트 재설계) |

## SP1 zkVM 활용

zk-X509에서 이미 SP1 사용 중:
- Groth16 proof 생성
- SP1Verifier 온체인 검증
- 동일 인프라 재사용 가능

settle용 SP1 프로그램:
- ECDSA 서명 검증 (secp256k1)
- 해시 연산 (keccak256)
- Merkle proof 검증 (commitment tree)
- 산술 연산 (가격 호환, 수수료 계산)

## 설계 결정 사항

### ZK proof 생성 → 릴레이어

- 릴레이어가 매칭 후 settle TX를 제출하는 기존 역할과 일치
- 릴레이어는 이미 양쪽 주문 내용을 알고 있으므로 추가 정보 노출 없음
- 유저 입장에서 기존과 동일한 UX (서명만 하면 끝)
- 릴레이어는 Dual-CA로 규제되는 신뢰 주체


## Open Questions

- [ ] commitment에 token/amount를 포함할지, 별도 관리할지
- [ ] deposit 이벤트에 amount를 공개할지 (유동성 파악 vs 프라이버시)
- [ ] commitment tree 크기 관리 (pruning)
- [ ] withdraw 시 대기 시간 (timing attack 방지)
- [ ] 기존 테스트/프론트엔드 마이그레이션 전략
