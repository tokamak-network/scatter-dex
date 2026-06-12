# 증명 시스템 보안 모델

## 1. 위협 모델

| 행위자 | 능력 | 목표 |
|--------|------|------|
| 악의적 사용자 | 임의 증명 생성 시도, preimage 유출 가능 | 타인 자금 탈취, 이중지출 |
| 악의적 릴레이어 | 온체인 트랜잭션 순서 제어, 수수료 조작 시도 | 샌드위치 공격, 수수료 부정 인출, 주문 가로채기 |
| 관찰자 | 온체인 이벤트/상태 수집 | 거래 상관관계 추출(체인 분석) |
| 오너(신뢰최소) | verifier 교체, 화이트리스트, 수수료 | 제한된 권한, 타임락 필수 |

## 2. 주요 방어 메커니즘

### 2.1 Pubkey 바인딩 (#128, Commitment v2)

**공격**: preimage `(secret, token, amount, salt)` 가 유출되었다고 가정.

**v1 취약성**: 공격자가 해당 preimage 로 authorize 증명을 만들 수 있음 → 자금 탈취.

**v2 방어**: commitment 에 `pubKeyAx, pubKeyAy` 가 포함되어 있어 공격자는:
- 동일 pubKey 로 증명하려면 EdDSA 서명이 필요(서명 키 미보유 → 실패)
- 다른 pubKey 로 commitment 를 재계산하면 트리 멤버십 실패

**비용**: 회로당 ~50–80 constraints (BabyCheck + small-order).

### 2.2 Nullifier 도메인 분리 (#tags.circom)

동일 `(secret, x)` 쌍이 서로 다른 태그 아래에서 **다른** 해시를 생성하므로, escrow nullifier 로 소진된 값이 nonce/claim nullifier 로 재사용되어도 충돌 없음.

### 2.3 Claim 토큰 강제 (#127 HIGH fix)

**공격**: 릴레이어가 USDC 주문을 받으면서 claim 리프에는 무가치 토큰을 넣어 분배 → 사용자는 claim 시점에 비로소 속임수 인지.

**방어**: `authorize.circom` 에서 각 사용된 claim 의 `token === buyToken` 을 강제.

### 2.4 최소 수령 보장 (Fee Semantics, 2026-04-14)

```
totalLocked × 10000 ≥ buyAmount × (10000 − maxFee)
```

**의미**: 최악의 경우(relayer 가 maxFee 전체 사용) 에도 사용자에게 약속한 net 수령량을 claim 분배가 커버하도록 강제.

### 2.5 Relayer 바인딩

- authorize 의 `orderHash` 에 `relayer` 가 포함되어 EdDSA 서명으로 잠김.
- 공개 신호로도 노출되어 온체인에서 `msg.sender == relayer` 또는 등록된 릴레이어인지 확인.
- 결과: **증명을 다른 릴레이어가 탈취 사용 불가**.

### 2.6 비동기 루트 안전성

`settleAuth` 는 maker/taker 의 루트가 달라도 허용. 이로 인해 "오래된 루트로 이중지출" 이 가능하지 않은가?

**증명**: 이중지출을 위해선 동일 escrow nullifier 가 두 번 소진되어야 함. nullifier 는 commitment preimage 의 결정론적 함수이므로 같은 UTXO 는 같은 nullifier 를 낳음. 서로 다른 루트라도 onchain `nullifiers[]` 세트가 단일 진실(single source of truth) → 두 번째 시도는 revert.

### 2.7 자기거래(self-trade)는 의도적으로 허용 — D1

자기거래 방지 체크는 **존재하지 않는다**
([ADR-001](../../architecture/adr/001-no-self-trade-detection.md)).
온체인 자기거래 검사는 per-trader-stable 공개 신호를 요구해 거래
클러스터링 오라클이 되고, 자금 무결성은 nullifier 가 이미 보장한다.
같은 키 양쪽 정산이 **성공**하는 positive 테스트로 결정이 잠겨 있다.

단, 별개의 가드로 `settleAuth` 는 **동일 nullifier 양측 제출**을
intra-tx 에서 거부한다(PR #133) — 같은 커밋먼트로 두 증명을 만들어
`2 × totalLocked` 를 빼가는 풀 드레인을 차단하는 검사이며, 자기거래
방지가 아니라 이중지출 방지다.

### 2.8 pubKeyBind 로 **온체인 링크성 차단**

과거 초안은 `pubKeyHash = Poseidon(pubKeyAx, pubKeyAy)` 를 공개 신호로 두었으나, 이는 동일 사용자의 모든 거래를 한 해시값으로 묶는 **영구 식별자**가 되어 Tornado Cash 식 역추적 벡터가 된다.

v2 는 `pubKeyBind = P_3(pubKeyAx, pubKeyAy, nullifier)` — 거래마다 nullifier 가 다르므로 외부 관찰자에게 다른 값으로 보인다. 단, 사용자 pubKey 를 이미 알고 있는 릴레이어는 재계산 가능 → **컴플라이언스 분리 신뢰 모델** 달성.

### 2.9 Small-Order Key 공격 차단(#deposit.circom)

BabyJub 의 identity point `(0, 1)` 및 6개의 order ≤ 8 점은 서명 위조 가능. 예치 시점에서 `8·P ≠ identity` 를 assert 해 대차수(prime-order) 부분군 원소만 허용.

### 2.10 Withdraw EdDSA 게이트 (2026-05-19)

**공격**: 노트 파일(`zkscatter-note-*.json` 또는 동등한 외부 백업)이
유출되었다고 가정. preimage `(ownerSecret, salt, pubKeyAx, pubKeyAy)`
이 공격자 손에 들어옴.

**v1 취약성 (이번 게이트 이전)**: 위 preimage 만으로 `withdraw.circom`
증명이 만들어졌다. 회로는 Merkle 멤버십 + nullifier + token + recipient
바인딩만 검사했고, **EdDSA 서명 검증이 없었다** → 공격자가 임의
`recipient` 로 자금을 빼낼 수 있었다. authorize/cancel/settle 회로는
이미 EdDSA 게이트가 있었으나 withdraw 만 빠져 있었던 일관성 구멍.

**v2 방어 (이번 PR)**: withdraw 회로가 `Poseidon(nullifierHash,
recipient)` 에 대한 EdDSA 서명을 추가로 요구한다. 서명용 pubKey 는
commitment 안에 이미 박혀 있는 `pubKeyAx/Ay` 이며, 매칭 개인키는
`keccak256(wallet.signMessage(DEFAULT_DERIVE_MESSAGE))` 로
**예치자 지갑에서만** 파생된다 (`packages/sdk/src/zk/eddsa.ts`).
→ 노트 파일만 복사한 공격자는 서명 키가 없어 회로를 통과할 수 없다.

**비용**: ~4,600 추가 constraints (총 6,348 — `snarkjs r1cs info` 실측),
프루빙 시간 ~1.5s → ~2.0s desktop 측정 기준. EdDSAPoseidonVerifier 의
기존 authorize/cancel 사용과 동일한 패턴.

**메시지 바인딩 선택**: `Poseidon-2(nullifierHash, recipient)`.
- `nullifierHash` 포함 → 다른 노트의 sig 를 재사용 불가
- `recipient` 포함 → leaked proof 를 다른 주소로 리디렉트 불가
- authorize 의 `orderHash` (Poseidon-9), cancel 의 `cancelMsg`
  (Poseidon-2(nonceNullifier, submitter)) 와 다른 input 셋 → 회로 간
  서명 재생 불가.

**남는 한계**: 노트 파일 **분실** 시 자금 회복은 여전히 불가능 (지갑이
있더라도 `ownerSecret/salt` 가 임의값이라 재구성 불가). 결정적 노트
파생 (`HKDF(walletSig, "owner", index)`) 은 commitment v3 마이그레이션
필요로 별도 작업 트랙. 클라이언트 측 자동 암호화 백업이 단기 mitigation.

### 2.11 Bit-width 안전성

sellAmount × buyAmount 와 같은 곱은 BN254 필드(254-bit) 내부에서 수행. 각 오퍼랜드를 **126-bit** 로 제한하면 결과가 252-bit ≤ 필드 크기 → 래핑(wrap) 공격 차단.

## 3. 알려진 제약 / 비 목표

- **On-chain pubKey 복구 불가**: 비밀키 분실 시 자금 회수 경로 없음. 클라이언트가 키 백업을 책임.
- **컴플라이언스 신뢰**: `pubKeyBind` 는 자발적 공개(릴레이어 협조)가 전제. 완전 익명을 원하면 릴레이어 간 pubKey 를 공유하지 않도록 운영 정책 필요.
- **Claim 만료 없음**: 수령 책임은 사용자. 오너가 임의 회수 불가(설계상).
- **Relayer 슬래싱 없음**: 악성 릴레이어는 실패한 settle 시 가스만 손실.

## 4. 암호학 프리미티브 선택 이유

| 프리미티브 | 선택 이유 |
|-----------|----------|
| **Poseidon** | ZK 친화적(낮은 제약 수), Circom/snarkJS 기본 지원 |
| **BabyJub** | Poseidon 과 같은 BN254 스칼라 필드 위 곡선 → EdDSA 내장 검증 저비용 |
| **Groth16** | 검증 게이트 수 적음, 증명 짧음(8개 G1/G2 포인트) — 온체인 gas 최적 |
| **BN254** | EVM `ecPairing` 사전 컴파일 지원 |

## 5. 관련 ADR / 보고서

- [`docs/architecture/architecture-v2.md`](../../architecture/architecture-v2.md) — half-proof 모델 도입 결정
- `docs/circuit-split/bit-width-audit.md` — 126/128-bit 범위 감사 (docs 재구성 때 삭제 — git 히스토리에서 열람)
- `SECURITY_ISSUES.md` — 이슈 #127(HIGH), #128(CRITICAL), #150(pubKeyBind) 해결 이력
- 감사 온보딩: [`docs/security/AUDIT.md`](../../security/AUDIT.md), [`docs/security/HARDENING.md`](../../security/HARDENING.md)

## 6. 체크리스트: 새 회로 도입 시 점검 사항

- [ ] 모든 Poseidon 호출에 도메인 태그 포함.
- [ ] `balance`, `totalLocked` 등 128-bit 범위 assert.
- [ ] 곱셈 피연산자 126-bit 제한.
- [ ] 공개 신호에 `x * x` 제약으로 circom 최적화 회피.
- [ ] 새 nullifier 는 tags.circom 에 상수 추가.
- [ ] 온체인 컨트랙트에 nullifier 세트 매핑 확보.
- [ ] oracle/릴레이어 바인딩이 필요한 주소는 공개 신호로 반드시 노출.
- [ ] snarkJS 생성 verifier 의 공개 신호 수가 컨트랙트 `uint[n]` 배열과 일치.
