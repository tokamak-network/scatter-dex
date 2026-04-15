# 커밋먼트 & Nullifier 스킴

## 1. Commitment v2 (Issue #128 강화 버전)

### 정의

```
commitment = Poseidon(
  TAG_COMMITMENT_V2 (= 3),   // 도메인 분리 태그
  secret,                    // 사용자 에스크로 비밀값
  token,                     // ERC20 주소 (uint160 캐스팅)
  amount,                    // 에스크로 잔액 (128-bit)
  salt,                      // 커밋먼트별 무작위값
  pubKeyAx,                  // BabyJub EdDSA 공개키 X 좌표
  pubKeyAy                   // BabyJub EdDSA 공개키 Y 좌표
)
```

### 왜 pubKey 를 커밋먼트에 바인딩하는가?

**공격 시나리오(#128, swap-the-key)**: 공격자가 `(secret, token, amount, salt)` preimage 를 알게 되더라도, 임의의 pubKey 로 다른 commitment 해시를 만들면 Merkle 트리에 없으므로 membership 증명이 불가능하고, EdDSA 서명용 private key 도 없으므로 order 서명을 만들 수 없다.

### 불변식

`deposit.circom` 에서 **단 한 번** BabyCheck + 소차수(small-order) 부분군 거부를 수행. 이후 모든 회로는 "트리 안의 commitment 는 이미 정당한 pubKey 로 만들어졌다"는 사실을 신뢰해 중복 검증을 생략 → 회로당 수천 제약조건 절감.

---

## 2. Nullifier 3종 — 도메인 분리

`tags.circom` 는 충돌을 막기 위한 상수를 정의한다:

```circom
function TAG_ESCROW_NULL()   { return 0; }  // 커밋먼트 이중지출 방지
function TAG_NONCE_NULL()    { return 1; }  // 주문 재사용 방지
function TAG_CLAIM_NULL()    { return 2; }  // 클레임 이중청구 방지
function TAG_COMMITMENT_V2() { return 3; }  // 커밋먼트 해시 도메인
```

### 세부 정의

| 태그 | 이름 | 공식 | 의미 |
|------|------|------|------|
| 0 | Escrow nullifier | `Poseidon(0, secret, salt)` | **UTXO 당 1회 소진** — 동일 commitment 로 두 번 출금/세틀 불가 |
| 1 | Nonce nullifier | `Poseidon(1, secret, nonce)` | **주문 당 1회 소진** — 동일 nonce 로 상대만 바꿔 재매칭하는 replay 차단 |
| 2 | Claim nullifier | `Poseidon(2, claimSecret, leafIndex)` | **claims tree leaf 당 1회** — 이중 청구 방지 |

### 상호작용 예시

사용자가 주문을 취소하고 다시 주문하고 싶을 때:

```
[기존 주문] escrowNullifier=E, nonceNullifier=N, commitment=C
    ▼ cancelPrivate(oldEscrow=E, oldNonce=N, newCommitment=C')
[취소 후]   E, N 은 소진됨 → relayer 가 가진 authorize 증명은 이제 무효
            C' 라는 새 커밋먼트(같은 잔액, 새 salt)가 트리에 삽입됨
    ▼ 사용자가 C' 로 새 authorize 증명 생성 (다른 secret/salt, 그러나 같은 pubKey)
[새 주문]   escrowNullifier=E', nonceNullifier=N' (nonce 변경 시)
```

---

## 3. Merkle Tree 구조

### 3.1 Commitment Tree (에스크로)

| 속성 | 값 |
|------|---|
| 깊이 | 20 (≈ 1M 리프) |
| 해시 | Poseidon(2-input) |
| 리프 | commitment v2 해시 |
| 삽입 | append-only (`_insert`) |
| 루트 | **링 버퍼** (기본 30개) → `isKnownRoot` |

**비동기 루트 모델**: maker 와 taker 가 서로 다른 과거 루트로 증명을 만들어도 각각 링 버퍼에 존재하면 `settleAuth` 에서 통과. 이중지출은 nullifier 로 차단되므로 안전.

### 3.2 Claims Tree (세틀먼트 당 분배용)

| 속성 | 값 |
|------|---|
| 깊이 | 4 (최대 16 리프) |
| 해시 | Poseidon(2-input) |
| 리프 | `Poseidon(claimSecret, recipient, token, amount, releaseTime)` |
| 공개 | `claimsRoot` 만 온체인 공개, 각 리프는 claim 시 개별 증명 |

**효과**: 세틀먼트 시점에는 수령자·금액 구조가 숨겨지고, claim 시점에도 해당 claim 만 공개됨(다른 claim 과 연결 불가).

---

## 4. 온체인 상태 매핑

```solidity
// CommitmentPool
mapping(uint256 => bool) public nullifiers;        // withdraw 전용 escrow nullifier

// PrivateSettlement
mapping(bytes32 => bool) public nullifiers;         // settle 경로 escrow nullifier
mapping(bytes32 => bool) public nonceNullifiers;    // nonce
mapping(bytes32 => bool) public claimNullifiers;    // claim
mapping(bytes32 => ClaimsGroup) public claimsGroups;// claimsRoot → {totalLocked, totalClaimed, token}
```

> withdraw 용 nullifier 와 settle 용 nullifier 는 서로 다른 컨트랙트의 독립된 매핑에 저장되나, **도메인 태그 0 을 공유**하므로 동일한 escrow commitment 에 대해서는 어느 쪽에서든 한 번만 소진되면 다른 경로에서도 재현 불가(같은 해시를 두 컨트랙트가 각자 저장하지만, 실제 공격 경로는 회로가 sellToken/recipient 를 강제 바인딩하기 때문에 차단된다).

---

## 5. Bit-width 안전성

BN254 스칼라 필드 크기는 약 254-bit. Poseidon 입력과 회로 산술은 필드 원소로 수행되므로 곱셈 오버플로를 막기 위해 다음 범위를 강제:

| 신호 | 제한 | 이유 |
|------|------|------|
| `sellAmount`, `buyAmount` | **126-bit** | `a × b` 최악 ≤ 252-bit — 필드 내 안전 |
| `balance`, `totalLocked`, claim amount | 128-bit | uint128 상한 (ERC20 현실적 최대) |
| `maxFee` | 16-bit (≤ 10000) | bps 표현 |
| `claimCount` | 5-bit (0–16) | 트리 깊이 4 |

> 세부 감사 내역: `docs/circuit-split/bit-width-audit.md`.
