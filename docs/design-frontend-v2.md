# Frontend V2 Redesign

**Status: COMPLETED — merged into `frontend/`**
**Directory: frontend/app/ (Next.js App Router)**

> Note: 원래 `frontend_v2/`에서 개발했으나 `frontend/`으로 통합됨.

## Design Reference

Kinetic Ether design assets (external) — "Kinetic Ether" 디자인 시스템 기반

### 디자인 원칙 (DESIGN.md 요약)

- **Dark Observatory**: 깊은 다크 배경 (#060e20), 블루 라이트 소스
- **No-Line Rule**: 1px border 금지, 배경색 차이로 경계 표현
- **Glass & Gradient**: CTA 버튼 그라데이션, 카드 backdrop blur
- **Typography**: Manrope (헤드라인) + Inter (데이터)
- **Colors**: surface #060e20, container #0f1930, primary #95aaff → #3766ff

### 레이아웃 구조

- 상단 헤더: 로고 + 메뉴 + 지갑 연결
- 좌측 사이드바: Trade 서브메뉴 (Escrow, Order, Book 등)
- 우측 메인 콘텐츠: 각 페이지

## 페이지 목록 (디자인 파일 기준)

| 디자인 파일 | 페이지 | 기능 |
|-------------|--------|------|
| home_landing_page | `/` | 랜딩 페이지 — 서비스 소개, 통계, 기능 하이라이트 |
| trade_escrow_management | `/trade/escrow` | 에스크로 관리 — Asset Portfolio, Deposit, Withdraw |
| trade_order_creation | `/trade/order` | 주문 생성 — Buy/Sell, 수신자 설정, stealth meta-address, claim link 생성 |
| trade_order_book | `/trade/book` | 오더북 — 호가창, 차트, Trade History, 간편 주문 |
| dashboard | `/dashboard` | 대시보드 — 에스크로 잔액, Claims Monitoring, Active Settlements |
| claim_stealth_gasless_receipt | `/claim` | Claim — Stealth Setup, Claim Secret, Claim Method 선택, Claim Schedule |

## 기존 frontend 대비 변경점

- 디자인 시스템 전면 교체 (Kinetic Ether)
- 사이드바 네비게이션 추가
- Trade 페이지 사이드바 서브메뉴
- Order Book에 차트 + Trade History 추가
- Order Creation에 Buy/Sell 탭 + 가격 표시 + wallet summary
- Claim 페이지 통합 (stealth setup + claim + method 선택 + schedule)
- Landing 페이지 완전 재작성

## 기존 코드 재사용

- `lib/stealth.ts` — 그대로 사용
- `lib/signing.ts` — 그대로 사용
- `lib/contracts.ts` — 그대로 사용
- `lib/config.ts` — 그대로 사용
- `lib/wallet.tsx` — 그대로 사용
- `lib/relayerApi.ts` — 그대로 사용
- `lib/multicall.ts` — 그대로 사용

컴포넌트는 전부 새로 작성 (디자인 변경).

## Multi-Relayer Aggregated Orderbook (로드맵)

릴레이어 간 유동성을 통합하기 위한 단계적 계획.
컨트랙트(Settlement) 변경 불필요 — settle()은 유효한 서명이면 누가 호출하든 동작.

### Phase A: Multi-Relayer 오더북 조회 (프론트만)

- 여러 릴레이어의 `getOrderbook(pair)` 동시 조회
- 호가를 가격 기준으로 합산/정렬하여 하나의 오더북으로 표시
- 주문 제출 시 사용자가 릴레이어 선택 (유동성/수수료 비교)

### Phase B: 최적 릴레이어 자동 선택 (프론트)

- 주문 가격 기준으로 가장 매칭 확률 높은 릴레이어 자동 추천
- 수수료 비교 → 최저 수수료 릴레이어 표시

### Phase C: Cross-Relayer Settlement (릴레이어 프로토콜)

릴레이어 A의 Alice 주문과 릴레이어 B의 Bob 주문을 매칭:

- 에스크로는 Settlement 컨트랙트 하나에 모두 있으므로 크로스 매칭 가능
- 릴레이어 간 주문 공유 프로토콜 필요 (서명 포함 주문서 교환)
- settle TX 제출 권한 + 수수료 분배 규칙 합의
- 논문의 Multi-Relayer MLS (Multi-Lateral Settlement) 모델

### 기술적 근거

- `settle(makerOrder, takerOrder, makerSig, takerSig, fee)` — 서명만 유효하면 누가 제출해도 동작
- 에스크로는 사용자 주소 기준이지 릴레이어 기준이 아님
- 릴레이어는 매칭/제출 역할만 수행

## Order 설계 — Scatter 주문 구조

### 1개 주문 = 1개 거래 의도 + 여러 수신자(Claims)

```
Order {
  maker:      주문자 지갑 주소
  sellToken:  파는 토큰 (에스크로에서 차감)
  buyToken:   받는 토큰
  sellAmount: 파는 총량
  buyAmount:  받는 총량 (= price × amount)
  maxFee:     릴레이어 최대 수수료 (bps)
  expiry:     주문 만료 시간
  nonce:      중복 방지
  claims: [   수신자 배열 — "Scatter"
    { claimHash, amount, releaseDelay },  // 수신자 1
    { claimHash, amount, releaseDelay },  // 수신자 2
    ...
  ]
}
```

- claims[]의 amount 합계 = buyAmount (또는 sellAmount, 방향에 따라)
- releaseDelay: settle TX 이후 몇 초 뒤에 claim 가능한지 (시간 분산)
- 수신자별로 Standard address 또는 Stealth Meta-Address 선택 가능

### 에스크로 잔액 제약

- settle 시 `deposits[maker][sellToken] -= sellAmount` 차감
- 여러 주문을 동시에 넣을 수 있지만, 모두 체결되면 에스크로 부족 가능
- 프론트에서 에스크로 잔액 대비 미체결 주문 합계를 표시하는 것이 바람직

## 작업 순서

1. [x] 디자인 파일 확인 (screen.png + code.html + DESIGN.md)
2. [x] frontend_v2/ Next.js 프로젝트 생성 + lib/ 복사
3. [x] 공통 레이아웃 (헤더 + 사이드바) 구현
4. [x] 랜딩 페이지 구현
5. [x] Trade/Escrow 페이지 구현 (실제 컨트랙트 연동, ETH wrap, EIP-5792)
6. [x] Trade/Order 페이지 구현 (multi-recipient scatter, EIP-712 서명)
7. [x] Claim/Stealth 페이지 — Stealth Meta-Address 생성 + Claim 실행
8. [ ] Trade/Book 페이지 — 오더북, Trade History
9. [ ] Dashboard 페이지 — 에스크로 잔액, Claims, Settlements
10. [ ] Relayers 페이지
11. [ ] 반응형 확인
