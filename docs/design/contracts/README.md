# Scatter-DEX 컨트랙트 설계 문서

> 본 문서는 Scatter-DEX(zkScatter) 온체인 컨트랙트 시스템의 설계를 한글로 정리한 문서입니다.
> 증명(ZK) 관련 상세 설명은 [../proof-system/README.md](../proof-system/README.md) 참조.

## 1. 시스템 개요

Scatter-DEX 는 **ZK 기반 프라이버시 DEX**로, 다음 네 가지 축으로 구성된다.

1. **UTXO 커밋먼트 풀** — 사용자 예치금을 Poseidon Merkle tree 의 커밋먼트(leaf)로 보관.
2. **프라이빗 세틀먼트 엔진** — maker ↔ taker 간 ZK 증명으로 원자적 스왑을 수행하고 Claims Group 을 등록.
3. **릴레이어 & 수수료 관리** — 릴레이어 레지스트리 + FeeVault 로 수수료 적립/정산.
4. **컴플라이언스 레이어** — Identity Gate(zk-X509), Sanctions List(OFAC 블록리스트).

### 1.1 컨트랙트 구성도

```
                            ┌──────────────────────────────┐
                            │         사용자 / 릴레이어      │
                            └──────────────┬───────────────┘
                                           │ deposit / withdraw
                                           │ settle / claim
                                           ▼
┌──────────────────┐   authorized    ┌───────────────────────┐
│  CommitmentPool  │◄───settlement───│  PrivateSettlement    │
│ (IncrementalTree)│────transfer────►│ (settle/claim/cancel) │
└───────┬──────────┘                 └──────┬────────────────┘
        │                                   │
        │ 검증                              │ 검증/수수료
        ▼                                   ▼
┌──────────────────┐                 ┌───────────────────────┐
│  Deposit /       │                 │  Settle / Authorize / │
│  Withdraw Verif. │                 │  Claim / Cancel /     │
│  (Groth16)       │                 │  BatchAuthorize Verif.│
└──────────────────┘                 └───────────────────────┘
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              ▼                             ▼                             ▼
     ┌─────────────────┐           ┌─────────────────┐           ┌─────────────────┐
     │ RelayerRegistry │           │    FeeVault     │           │  SanctionsList  │
     │ (bond/cooldown) │           │ (fee + platform)│           │  / IdentityGate │
     └─────────────────┘           └─────────────────┘           └─────────────────┘
```

### 1.2 컨트랙트 목록

| 카테고리 | 컨트랙트 | 역할 |
|----------|----------|------|
| 핵심 | `zk/CommitmentPool.sol` | 예치·출금·Merkle tree 관리, 세틀먼트용 자금 이동 |
| 핵심 | `zk/PrivateSettlement.sol` | 4종 세틀먼트 플로우, Claims Group, Claim 실행 |
| 트리 | `zk/IncrementalMerkleTree.sol` | Poseidon 기반 append-only 트리 + 루트 링 버퍼 |
| 라이브러리 | `zk/SettleVerifyLib.sol` | EIP-170 회피용 외부 라이브러리(pure/view helpers) |
| Verifier | `zk/{Deposit,Withdraw,Settle,Authorize,Claim,Cancel,BatchAuthorize}Verifier.sol` | snarkJS Groth16 검증기 |
| 수수료 | `FeeVault.sol` | 릴레이어 수수료 + 플랫폼 수익 분리 적립 |
| 릴레이어 | `RelayerRegistry.sol` | 릴레이어 등록/본드/7일 쿨다운 |
| 컴플라이언스 | `IdentityGate.sol` | 다중 zk-X509 CA OR 집계 게이트 |
| 컴플라이언스 | `IssuanceApprovalRegistry.sol` | admin KYC 승인 기록(RelayerRegistry KYC AND 게이트) |
| 컴플라이언스 | `SanctionsList.sol` | OFAC 스타일 블록리스트 |
| UX | `BatchExecutor.sol` | EIP-7702 최소 배치 실행기(ERC-7579 호환) |

## 2. 세부 문서

- [core-contracts.md](core-contracts.md) — **CommitmentPool**, **PrivateSettlement** 상세
- [supporting-contracts.md](supporting-contracts.md) — FeeVault, RelayerRegistry, IdentityGate, IssuanceApprovalRegistry, SanctionsList, BatchExecutor, IncrementalMerkleTree, SettleVerifyLib, Verifier 계열
- [lifecycle.md](lifecycle.md) — 예치 → 인가 → 세틀먼트 → 클레임 → 출금 전 생애주기 및 호출 시퀀스

## 3. 신뢰 가정 및 핵심 보안 원리

1. **ZK Groth16 verifier 정확성** — 서킷 로직(커밋먼트·토큰·클레임·세틀먼트 조건)을 올바르게 강제한다.
2. **Poseidon 해시 충돌 저항성** — BN254 필드 위 Poseidon 의 충돌 불가능성.
3. **릴레이어 바인딩** — ZK 증명 안에 릴레이어 주소가 포함되어 대체·샌드위치 공격 불가.
4. **Nullifier 도메인 분리** — 에스크로/논스/클레임 세 종류를 도메인 태그로 분리해 네임스페이스 충돌 방지.
5. **타임락 & 2-step 오너십** — 세틀먼트 컨트랙트 교체 24시간, 플랫폼 수수료 변경 1일 지연.
6. **재진입 가드** — 모든 상태 변경 함수에 `nonReentrant` 적용.
7. **Fee-on-transfer 토큰 방어** — 잔액 차분으로 실제 입금액 확인.
8. **수수료 상한(상류 적용)** — 릴레이어 수수료는 `CommitmentPool.transferFee` 가 아니라 PrivateSettlement(`SettleVerifyLib.validateCrossSide` / `validateScatterAuth`)에서 주문 단위로 사용자 서명 `maxFee` 대비 검증된다(`fee × 10000 ≤ buyAmount(또는 sellAmount) × maxFee`). 운영자 드레인 방지는 `authorizedSettlement` 24시간 타임락.

## 4. 주요 알려진 제약

- 악의적 릴레이어에 대한 **본드 슬래싱 미지원**(L-3): 실패 시 가스 손실만 발생.
- `getActiveRelayers()` **O(n) 조회**(L-4): 대량 레지스트리는 오프체인 이벤트 인덱싱 권장.
- **타임스탬프 윈도우 편향**(M7): `currentTimestamp` 는 60초 과거 허용, 미래 블록 시간은 금지.
- **만료된 클레임 환불 미지원**: 세틀먼트 후 클레임은 영구 유효(사용자 책임).
- **WETH 자동 언래핑**: 클레임 시 WETH 는 ETH 로 전송됨(프론트엔드 UX 주의).
