# 회로 상세 스펙

각 회로의 목적, 공개/비공개 입력, 주요 제약 조건, 특수 기능을 정리한다.

> 표기: `P_n(…)` = n-input Poseidon.

---

## 1. deposit.circom — 에스크로 초기화

### 목적
예치 시 새 commitment 가 올바른 v2 포맷이며, 사용자의 EdDSA 공개키가 안전한(대차수 부분군) 점임을 증명.

### 입력

**공개(3):** `commitment`, `token`, `amount`

**비공개:** `secret`, `salt`, `pubKeyAx`, `pubKeyAy`

### 제약 조건

1. **Commitment 바인딩**
   `commitment === P_7(3, secret, token, amount, salt, pubKeyAx, pubKeyAy)`

2. **BabyJub 곡선 위 점(BabyCheck)**
   `a·x² + y² = 1 + d·x²·y²` — 유효 곡선 점.

3. **소차수 부분군 거부(small-order rejection)**
   `8·P` 를 3회 point doubling 으로 계산, `(8·P).x ≠ 0` assert.
   → identity `(0,1)` 을 포함한 8개 small-order 점 전부를 거부.
   (초안의 `pubKeyAx ≠ 0` 단독 검사를 PR #129 에서 완전한 부분군 검사로 대체.)

### 특수 기능
- **EdDSA 서명 없음** — 커밋먼트 자체와 온체인 `transferFrom` 이 금액을 원자적으로 바인딩.
- **공개키 검증은 여기서만** — 이후 회로들은 생략 가능.

---

## 2. authorize.circom — Half-Proof 주문 인가 (메인)

### 목적
한 사용자가 자신의 주문 측을 독립 증명. 두 개의 authorize 증명이 `settleAuth` 에서 결합되어 스왑을 완성. (단독으로도 `settleWithDex` / `scatterDirectAuth` 에서 소비됨.)

템플릿(`authorize_template.circom`) + 티어별 래퍼 구조: 티어 16(기본, 22,826 제약) / 64(56,474) / 128(101,338) — 티어 = claims 슬롯 수.

### 입력

**공개 신호 (14개 입력 + 1개 출력 = 15):**

| # | 신호 | 설명 |
|---|------|------|
| 1 | `commitmentRoot` | 트리 루트 (maker/taker 가 달라도 됨) |
| 2 | `nullifier` | escrow nullifier = `P_3(0, secret, salt)` |
| 3 | `nonceNullifier` | nonce nullifier = `P_3(1, secret, nonce)` |
| 4 | `newCommitment` | 잔여 commitment (v2 포맷, 0 가능) |
| 5 | `sellToken` | 판매 토큰 |
| 6 | `buyToken` | 구매 토큰 |
| 7 | `sellAmount` | 판매량 (126-bit) |
| 8 | `buyAmount` | 기대 최소 수령량 (126-bit) |
| 9 | `maxFee` | 릴레이어 최대 수수료 bps (≤ 10000) |
| 10 | `expiry` | 만료 unix 타임스탬프 |
| 11 | `claimsRoot` | claims Merkle root (깊이 4/6/7 — 티어별) |
| 12 | `totalLocked` | claim 총합 (128-bit) |
| 13 | `relayer` | 바인딩된 릴레이어 주소 |
| 14 | `orderHash` | EdDSA 서명된 주문 해시 |
| 15 | `pubKeyBind` *(출력)* | `P_3(pubKeyAx, pubKeyAy, nullifier)` — 컴플라이언스용. circom 이 출력을 앞에 배치하므로 verifier 의 pubSignals 배열에선 **index 0** |

**비공개:** `secret`, `balance`, `salt`, `pubKeyAx/Ay`, Merkle path (depth=20), `nonce`, `newSalt`, EdDSA `(sigS, sigR8x, sigR8y)`, 티어 크기(16/64/128)만큼의 claim preimage.

### 제약 조건

1. **범위 체크**: sellAmount/buyAmount 126-bit, balance/totalLocked 128-bit 등.

2. **Commitment 멤버십**
   `P_7(3, secret, sellToken, balance, salt, pubKeyAx, pubKeyAy)` 로 계산한 리프의 Merkle root == `commitmentRoot`.

3. **Nullifier 도출**: 에스크로/논스 공식 그대로.

4. **잔액 충분성**: `sellAmount ≤ balance` (LessEqThan 128).

5. **잔여 commitment**:
   ```
   newBalance = balance - sellAmount
   newCommitment = (newBalance > 0)
       ? P_7(3, secret, sellToken, newBalance, newSalt, pubKeyAx, pubKeyAy)
       : 0
   ```

6. **Claims 검증**
   - 각 사용된 리프 `P_5(claimSecret, recipient, token, amount, releaseTime)`.
   - **토큰 강제(#127 HIGH fix)**: 사용된 claim 의 `token == buyToken` — 그렇지 않으면 릴레이어가 USDC 주문을 받고 무가치 토큰으로 분배할 수 있음.
   - 사용되지 않은 리프는 amount=0.
   - 합 = `totalLocked`, 패딩된 트리의 루트 = `claimsRoot`.

7. **최소 수령 보장(Fee-semantics, 2026-04-14)**
   ```
   totalLocked × 10000 ≥ buyAmount × (10000 − maxFee)
   ```
   → 최악의 경우에도 claim 분배가 net 수령량을 커버.

8. **Order hash & EdDSA 서명**
   ```
   orderHash = P_9(sellToken, buyToken, sellAmount, buyAmount,
                   maxFee, expiry, nonce, claimsRoot, relayer)
   EdDSA.verify((pkAx, pkAy), (sigS, R8x, R8y), orderHash)
   ```

9. **Relayer 바인딩**: `relayer * relayer` 더미 제약으로 circom 최적화 제거 방지.

10. **pubKeyBind 출력**
    `pubKeyBind = P_3(pubKeyAx, pubKeyAy, nullifier)` — 거래마다 다르므로 외부 체인 분석으로 연결 불가. 릴레이어는 사용자의 pubKey 를 아는 경우에 한해 오프체인 검증.

### 특수 기능
- **비동기 루트**: maker/taker 루트 동일성 요구 없음.
- **pubKey 비공개**: 온체인에 노출되지 않으므로 claim recipient 평문과 결합한 지갑 그래프 재구성 공격 차단.
- **AuthClaimsRoot 최적화**: 내부 `isUsed` 루프를 호출 측에서 mute 처리해 ~4K 제약 절감.

---

## 3. withdraw.circom — 직접 출금

**공개(7):** `root`, `nullifierHash`, `newCommitment`, `tokenHash`, `withdrawAmount`, `recipient`, `relayer`.

**비공개:** commitment preimage(`pubKeyAx/Ay` 포함) + Merkle path + `newSalt` + EdDSA 서명 `(sigS, sigR8x, sigR8y)`.

**제약 (6,348):**
1. v2 commitment 멤버십
2. `nullifierHash = P_3(0, secret, salt)`
3. `tokenHash = P_1(token)` — 토큰을 해시로 노출(원본 ERC20 주소는 회로 외부에서 비교)
4. 잔액 범위 + change commitment (v2, 같은 pubkey)
5. **EdDSA 게이트 (2026-05-19)**: 커밋먼트에 바인딩된 pubKey 로
   `P_2(nullifierHash, recipient)` 에 서명 — 노트 파일 복사만으로는
   출금 불가, 유출된 증명을 다른 recipient 로 재사용 불가
   (`recipient` 는 서명 메시지에 직접 제약됨)
6. `relayer * relayer` 바인딩

---

## 4. claim.circom — Claims Tree 리프 청구

**공개(6):** `claimsRoot`, `nullifier`, `amount`, `token`, `recipient`, `releaseTime`.

**비공개:** `claimSecret`, `leafIndex`, path(티어별 depth 4/6/7).

**제약:**
1. `claimLeaf = P_5(claimSecret, recipient, token, amount, releaseTime)`
2. Merkle inclusion → root == `claimsRoot`
3. `nullifier = P_3(2, claimSecret, leafIndex)` — claim 도메인
4. 공개 입력 바인딩(제곱)

제약: 1,555 (티어 16) / 2,041 (64) / 2,284 (128). 가장 작은 회로.

---

## 5. cancel.circom — 주문 취소 & 에스크로 회전

**공개(5):** `commitmentRoot`, `oldNullifier`, `oldNonceNullifier`, `newCommitment`, `submitter`.

**비공개:** old commitment preimage + path + `freshSalt` + EdDSA 서명 `(sigS, R8x, R8y)`.

**제약 (10,708):**
1. 기존 commitment 멤버십.
2. `oldNullifier = P_3(0, secret, salt)`, `oldNonceNullifier = P_3(1, secret, nonce)`.
3. 회전 commitment = 동일 `(secret, token, balance, pubKey)` + **새 salt**.
4. 잔액 128-bit 범위.
5. EdDSA(`cancelMsg = P_2(oldNonceNullifier, submitter)`) 검증.
6. `submitter * submitter` 바인딩.

**설계 근거**: 릴레이어가 쥐고 있는 authorize 증명은 오프체인 soft-cancel 로는 취소가 안 되므로, 온체인 nullifier 소진만이 trustless 취소를 보장.

---

## 6. tags.circom — 도메인 분리 상수

```circom
function TAG_ESCROW_NULL()   { return 0; }
function TAG_NONCE_NULL()    { return 1; }
function TAG_CLAIM_NULL()    { return 2; }
function TAG_COMMITMENT_V2() { return 3; }
```

**컨센서스 크리티컬**: 값 변경은 기존 커밋먼트/nullifier 무효화. 오프체인 동기 구현:
- `zk-relayer/src/core/tags.ts`
- `frontend/app/lib/zk/tags.ts`
