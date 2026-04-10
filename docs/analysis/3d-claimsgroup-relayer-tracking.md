# 3-D 분석: ClaimsGroup에 settlingRelayer 저장 — 불필요

> **분석일**: 2026-04-10
> **결론**: 구현하지 않음
> **원안**: `ClaimsGroup` struct에 `address settlingRelayer` 필드를 추가하여 어떤 릴레이어가 어떤 claimsRoot를 정산했는지 on-chain 추적

---

## 원안 요약

```solidity
struct ClaimsGroup {
    address token;           // slot 0: 20 bytes
    uint96  totalLocked;     // slot 0: 12 bytes
    uint96  totalClaimed;    // slot 1: 12 bytes
    address settlingRelayer; // slot 1: 20 bytes (패딩 자리에 fit)
}
```

- storage packing 상 추가 가스 비용 없음 (slot 1의 20-byte 패딩 자리에 정확히 fit)
- cross-relayer 매칭 시 `msg.sender`가 아닌 각 side의 bound relayer를 저장해야 정확함
  - `claimsGroups[claimsRootMaker]` -> `makerRelayer`
  - `claimsGroups[claimsRootTaker]` -> `takerRelayer`

## 불필요한 이유

### 1. 이벤트로 이미 충분

`PrivateSettled` 이벤트 (`PrivateSettlement.sol:341`):
```
emit PrivateSettled(
    p.makerNullifier, p.takerNullifier,
    p.claimsRootMaker, p.claimsRootTaker,
    msg.sender,          // <-- 정산 릴레이어
    p.feeTokenMaker, p.feeTokenTaker
);
```

- `claimsRoot <-> relayer` 매핑은 이벤트 로그에서 이미 조회 가능
- off-chain 인덱서가 이 이벤트를 소비하여 릴레이어 추적/통계 생성

### 2. dispute-registry가 on-chain 조회를 하지 않음

`docs/dispute-registry/design.md`의 핵심 설계 원칙:

- **record-only** dispute system: bond slashing 없음, economic penalty 없음
- **컨트랙트 간 의존성 없음**: "Does not depend on DisputeRegistry having any privileged access to other contracts"
- reputation 계산은 **off-chain 인덱서**가 이벤트 로그를 읽어서 수행
- 유일한 `PrivateSettlement` 변경 제안은 `orderSettled` mapping (중복 dispute 방지용)이며, 릴레이어 추적과 무관

### 3. 보안 측면 — 추가 위험 없으나 이점도 없음

- `makerRelayer`, `takerRelayer`는 이미 ZK proof의 public signal로 on-chain 노출
- storage에 중복 저장해도 프라이버시 추가 유출 없음
- 하지만 on-chain에서 이 값을 읽는 소비자(consumer contract)가 현재 설계에 존재하지 않음

## on-chain 저장이 필요해지는 경우 (현재 해당 없음)

- dispute 컨트랙트가 `claimsRoot`로부터 책임 릴레이어를 on-chain 자동 조회 + 슬래싱
- cancel 컨트랙트가 해당 릴레이어에게 환불 책임을 on-chain 강제

이런 요구가 구체화되면 그때 추가해도 늦지 않음.

## 최종 결정

**구현하지 않음.** 이벤트 인덱싱으로 완전히 커버되며, on-chain consumer가 없는 상태에서 storage 추가는 dead code.
