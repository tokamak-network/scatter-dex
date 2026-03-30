# Design: Remove `maker` from Order Struct

**Status: REJECTED**

## Motivation

현재 Order struct에 `maker` 주소가 평문으로 포함되어 있다. 에스크로에 예치된 자금은 이미 zk-X509 인증을 통과한 것이므로, settle 시점에 maker 주소를 명시할 필요가 없다. `ecrecover(signature)`로 서명자를 복구하면 된다.

## Conclusion (결론)

**maker 주소를 숨기는 것은 불필요하다.**

에스크로 잔액(`deposits[address][token]`)이 온체인에 있기 때문에 누구든 조회할 수 있다. deposit TX 자체가 `msg.sender`를 공개하므로, 주문에서 maker를 빼거나 pseudonym으로 대체해도 온체인에서 address ↔ 에스크로 매핑이 드러난다.

현재 설계가 ZK 없이 달성 가능한 최적의 프라이버시:
- **입력은 공개**: deposit — 누가 넣었는지 보임 (온체인 TX)
- **출력은 비공개**: claim — 누가 받는지 숨김 (claimHash)
- **입출력 연결 끊김**: scatter settlement (금액 분할 + 시간 지연 + fresh 주소)

maker 주소가 공개되어도 자금의 **최종 목적지**는 claimHash 뒤에 숨겨져 있어 프라이버시가 유지된다.

```
현재:  Order = { maker, sellToken, buyToken, sellAmount, buyAmount, ... }
       → recover(sig) == maker 검증 (중복)

변경:  Order = { sellToken, buyToken, sellAmount, buyAmount, ... }
       → maker = recover(sig)  (서명에서 추출)
```

## 핵심 원칙

- **거래(오더북)는 투명** — 토큰, 금액, 호가 모두 공개
- **입출력 연결은 끊김** — claimHash + 시간지연 + 금액분할로 달성 (기존)
- **maker 주소 제거는 추가 프라이버시** — 릴레이어가 `ecrecover`로 복구 가능하지만, 주문 데이터 자체에 평문 주소가 없어짐
- **ZK 사용하지 않음**

## 변경 범위

### 1. `ScatterSettlement.sol` — Order struct

```solidity
// 변경 전
struct Order {
    address maker;      // ← 제거
    address sellToken;
    address buyToken;
    uint256 sellAmount;
    uint256 buyAmount;
    uint256 maxFee;
    uint256 expiry;
    uint256 nonce;
    ClaimInfo[] claims;
}

// 변경 후
struct Order {
    address sellToken;
    address buyToken;
    uint256 sellAmount;
    uint256 buyAmount;
    uint256 maxFee;
    uint256 expiry;
    uint256 nonce;
    ClaimInfo[] claims;
}
```

### 2. `ScatterSettlement.sol` — settle()

```solidity
// 변경 전
function settle(
    bytes calldata makerSig,
    bytes calldata takerSig,
    Order calldata makerOrder,
    Order calldata takerOrder,
    uint256 actualFee
) external nonReentrant {
    ...
    _validateSettle(makerSig, takerSig, makerOrder, takerOrder, actualFee);
    nonces[makerOrder.maker][makerOrder.nonce] = NonceState.Settled;
    deposits[makerOrder.maker][makerOrder.sellToken] -= makerOrder.sellAmount;
    ...
}

// 변경 후
function settle(
    bytes calldata makerSig,
    bytes calldata takerSig,
    Order calldata makerOrder,
    Order calldata takerOrder,
    uint256 actualFee
) external nonReentrant {
    ...
    // Recover maker/taker addresses from signatures
    address maker = ECDSA.recover(_hashOrder(makerOrder), makerSig);
    address taker = ECDSA.recover(_hashOrder(takerOrder), takerSig);

    _validateSettle(maker, taker, makerOrder, takerOrder, actualFee);
    nonces[maker][makerOrder.nonce] = NonceState.Settled;
    nonces[taker][takerOrder.nonce] = NonceState.Settled;
    deposits[maker][makerOrder.sellToken] -= makerOrder.sellAmount;
    deposits[taker][takerOrder.sellToken] -= takerOrder.sellAmount;
    ...
}
```

### 3. `ScatterSettlement.sol` — _validateSettle()

```solidity
// 변경 후
function _validateSettle(
    address maker,
    address taker,
    Order calldata makerOrder,
    Order calldata takerOrder,
    uint256 actualFee
) internal view {
    if (maker == taker) revert SelfTrade();
    // 서명 검증은 이미 settle()에서 recover로 완료
    // 나머지 검증은 동일
    if (nonces[maker][makerOrder.nonce] != NonceState.Unused) revert NonceConsumed();
    if (nonces[taker][takerOrder.nonce] != NonceState.Unused) revert NonceConsumed();
    ...
    if (deposits[maker][makerOrder.sellToken] < makerOrder.sellAmount) revert InsufficientEscrow();
    if (deposits[taker][takerOrder.sellToken] < takerOrder.sellAmount) revert InsufficientEscrow();
}
```

### 4. `ScatterSettlement.sol` — _hashOrder()

```solidity
// 변경 전: ORDER_TYPEHASH에 maker 포함
bytes32 public constant ORDER_TYPEHASH = keccak256(
    "Order(address maker,address sellToken,...)"
);

// 변경 후: maker 제거
bytes32 public constant ORDER_TYPEHASH = keccak256(
    "Order(address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 maxFee,uint256 expiry,uint256 nonce,ClaimInfo[] claims)ClaimInfo(bytes32 claimHash,uint256 amount,uint256 releaseDelay)"
);
```

### 5. `ScatterSettlement.sol` — _createSchedules()

```solidity
// 변경: maker/taker를 파라미터로 받음
function _createSchedules(
    address maker,
    address taker,
    Order calldata makerOrder,
    Order calldata takerOrder
) internal returns (bytes32[] memory claimHashes) {
    ...
    // depositor를 maker/taker 파라미터에서 가져옴
    schedules[ch] = ClaimSchedule({
        token: takerOrder.sellToken,
        amount: safeAmt,
        releaseTime: safeTime,
        claimed: false,
        depositor: maker     // ← makerOrder.maker 대신
    });
    ...
}
```

### 6. `ScatterSettlement.sol` — cancelOrder()

```solidity
// 변경 없음 — msg.sender로 nonce 취소
function cancelOrder(uint256 nonce) external {
    if (nonces[msg.sender][nonce] != NonceState.Unused) revert NonceConsumed();
    nonces[msg.sender][nonce] = NonceState.Cancelled;
    emit NonceCancelled(msg.sender, nonce);
}
```

### 7. Settled 이벤트

```solidity
// 변경: maker/taker를 별도 파라미터로
event Settled(address indexed maker, address indexed taker, bytes32[] claimHashes);
// settle() 내부에서 recover된 주소 사용
emit Settled(maker, taker, claimHashes);
```

### 8. Frontend — signing.ts

```typescript
// 변경 전: Order에 maker 포함
const types = {
    Order: [
        { name: "maker", type: "address" },    // ← 제거
        { name: "sellToken", type: "address" },
        ...
    ]
};

// 변경 후
const types = {
    Order: [
        { name: "sellToken", type: "address" },
        { name: "buyToken", type: "address" },
        ...
    ]
};
```

### 9. Relayer — order matching

릴레이어가 매칭 시 필요한 정보:
- sell/buy 토큰, 금액 → Order struct에 있음
- 에스크로 잔액 확인 → `ecrecover(sig)`로 주소 복구 후 온체인 조회

릴레이어가 `ecrecover`를 호출하면 maker 주소를 알 수 있지만, **주문 데이터 자체에는 주소가 없음.**

### 10. Relayer API — orders endpoint

```typescript
// 변경: order data에 maker 없음, signature에서 복구
// GET /api/orders/:address → 서명에서 maker 복구하여 필터링
```

## 가스 영향

- Order struct에서 `address` (20 bytes) 제거 → calldata 절약
- `ecrecover`는 settle()에서 이미 호출 중 → 추가 비용 없음 (기존 `recover + ==` 비교 제거)
- 순 효과: **가스 절약** (calldata 감소 + 비교 연산 제거)

## 보안 고려사항

- **서명 검증**: `ecrecover`로 대체 — 동일한 보안 수준
- **replay 방지**: nonce가 `recover(sig)` 주소에 매핑 — 동일
- **인증**: deposit 시점에 이미 인증 완료 — 영향 없음
- **self-trade**: `recover(makerSig) != recover(takerSig)` — 동일

## 파일 변경 목록

| 파일 | 변경 |
|------|------|
| `contracts/src/ScatterSettlement.sol` | Order struct, settle, _validateSettle, _hashOrder, _createSchedules |
| `contracts/test/ScatterSettlement.t.sol` | Order 생성에서 maker 제거 |
| `contracts/test/IdentityGate.t.sol` | 동일 |
| `contracts/test/E2ELocal.t.sol` | 동일 |
| `contracts/test/GasBenchmark.t.sol` | 동일 |
| `contracts/script/DeployLocal.s.sol` | 영향 없음 |
| `frontend/src/lib/signing.ts` | EIP-712 type에서 maker 제거 |
| `frontend/src/components/OrderForm.tsx` | orderData에서 maker 제거 |
| `relayer/src/core/submitter.ts` | settle 호출 시 order 구조 변경 |
| `relayer/src/routes/orders.ts` | ecrecover로 maker 복구 |
| `docs/PAPER.md` | Order struct 업데이트 |
