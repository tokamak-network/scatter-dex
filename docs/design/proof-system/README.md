# zkScatter ZK 증명 시스템 설계

> 본 디렉토리는 zkScatter 의 Zero-Knowledge 증명 시스템을 회로(circuit) 단위와 전체 아키텍처 관점에서 상세히 설명한다.

## 0. Executive Summary

zkScatter 는 **Poseidon 해시**와 **BabyJub 곡선(EdDSA)** 기반 Groth16 회로 5종 패밀리(deposit / authorize / withdraw / claim / cancel — authorize·claim 은 16/64/128 티어 변형 존재)를 조합해 프라이버시 보존 정산을 구현한다. 핵심 설계 포인트:

- **Half-proof 아키텍처**: 각 거래자가 자신의 witness(잔액, 비밀, 서명키)를 릴레이어에 노출하지 않고 자기 쪽 주문만 독립적으로 증명(`authorize.circom`). 릴레이어는 두 증명을 매칭해 온체인 `settleAuth` 로 제출.
- **Commitment v2 (#128 Hardened)**: `Poseidon(3, secret, token, amount, salt, pubKeyAx, pubKeyAy)` — 서명 공개키를 커밋먼트에 바인딩해 preimage 유출 시에도 위조 서명 공격을 차단.
- **도메인 분리 Nullifier 3종**: Escrow(0), Nonce(1), Claim(2) 태그로 네임스페이스 충돌 방지.
- **비동기 루트(Asynchronous Root)**: maker/taker 가 서로 다른 과거 루트로 증명을 생성해도 각각 링 버퍼에 존재하면 유효.
- **Claims Tree(티어별 깊이 4/6/7)**: 세틀먼트 결과가 다수 수령자(16/64/128명)에게 분배될 수 있도록 Merkle root 만 공개하고 개별 수령자 정보는 claim 시점까지 숨김.
- **Batch 검증 최적화**: 두 authorize 증명을 Fiat-Shamir 로 병합해 5-페어링 하나로(~24% 가스 절감). 양측 동일 티어일 때만 적용.

## 1. 시스템 구성도

```
                        ┌────────────────────────────────────────────────┐
                        │              오프체인 (브라우저 / 릴레이어)        │
                        │                                                │
                        │  사용자 지갑 (BabyJub 키쌍, secret/salt 관리)       │
                        │        │                                       │
                        │        ▼                                       │
                        │  snarkJS/circom 증명 생성                       │
                        │   ─ deposit / authorize / claim / cancel        │
                        │   ─ withdraw                                    │
                        │        │                                       │
                        │        ▼                                       │
                        │  릴레이어(zk-relayer) ←─ order matching         │
                        │        │                                       │
                        └────────┼────────────────────────────────────────┘
                                 │ proof + public signals
                                 ▼
    ┌─────────────────────────────────────────────────────────────────────┐
    │                              온체인                                   │
    │                                                                     │
    │  ┌──────────────────┐                  ┌─────────────────────────┐  │
    │  │  CommitmentPool  │◄────transfer─────│   PrivateSettlement    │  │
    │  │ (MerkleTree 깊이20)│   withdrawFor   │  settle/claim/cancel    │  │
    │  │ + nullifier set  │                  │  + claimsGroup 레지스트리 │  │
    │  └───┬──────────────┘                  └────┬────────────────────┘  │
    │      │ 검증                                    │ 검증                 │
    │      ▼                                      ▼                      │
    │  Deposit/Withdraw            Authorize / BatchAuthorize / Claim     │
    │  Verifier                    / Cancel Verifier (Groth16, 티어별)     │
    │                                                                     │
    └─────────────────────────────────────────────────────────────────────┘
```

## 2. 회로 목록 & 규모

| # | 회로 | 공개 신호 | 제약조건(실측) | 용도 |
|---|------|-----------|-------------|------|
| 1 | `deposit.circom` | 3 | 400 | 예치 시 commitment ↔ (token, amount, pubKey) 바인딩 + BabyCheck |
| 2 | `authorize.circom` (티어 16) | 15 | 22,826 | Half-proof 주문 인가(한 당사자) |
| 2a | `authorize_64.circom` / `authorize_128.circom` | 15 | 56,474 / 101,338 | 상위 티어(claims 64/128개) |
| 3 | `withdraw.circom` | 7 | 6,348 | 직접 출금 |
| 4 | `claim.circom` (티어 16) | 6 | 1,555 | Claims tree 리프 청구 |
| 4a | `claim_64.circom` / `claim_128.circom` | 6 | 2,041 / 2,284 | 상위 티어 |
| 5 | `cancel.circom` | 5 | 10,708 | 대기 주문 취소 + commitment 회전 |
| 6 | `tags.circom` | — | 0 | 도메인 분리 상수(컴파일 타임 인라인) |

> 제약조건 수는 `snarkjs r1cs info circuits/build/*.r1cs` 실측값 (2026-06-12).

## 3. 문서 내비게이션

- [commitments-and-nullifiers.md](commitments-and-nullifiers.md) — 커밋먼트 v2, nullifier 3종, Merkle tree 구조
- [circuits.md](circuits.md) — 회로별 상세 스펙 (입력·제약·특수기능)
- [flows.md](flows.md) — 사용자/릴레이어 기준 플로우 다이어그램, 시퀀스 다이어그램
- [security.md](security.md) — 위협 모델 및 방어 근거(#127, #128 등)

## 4. 설계 원칙

1. **최소 누출 원리(Minimal Leakage)**: 증명이 공개하는 신호는 온체인 검증에 필요한 최소 정보(nullifier, 새 commitment, token/amount 범위, relayer) 로 한정.
2. **도메인 분리(Domain Separation)**: 모든 Poseidon 해시에 태그 상수를 넣어 preimage 재사용 공격 차단.
3. **Defense-in-Depth**: 커밋먼트 v2 로 preimage 유출 시에도 EdDSA 서명 키 미보유 시 공격 불가.
4. **비트폭 안전성(Bit-width Safety)**: sellAmount·buyAmount 는 126-bit 로 제한 — 곱 연산 시 BN254 필드 오버플로 방지.
5. **비동기 매칭(Async Matching)**: 루트 동일성 대신 nullifier 로 안전성을 보장해 거래 체결 가능 창을 확대.
6. **가스 분할 부담**: 비싼 BabyCheck·small-order 체크는 **예치 시 1회**만 수행, 이후 회로는 트리 멤버십만 검증.
