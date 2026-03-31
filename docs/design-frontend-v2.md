# Frontend V2 Redesign

**Status: IN PROGRESS**
**Branch: feat/frontend-v2**
**Directory: frontend_v2/**

## Design Reference

`/Users/zena/Downloads/stitch/` — "Kinetic Ether" 디자인 시스템 기반

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

## 작업 순서

1. [x] 디자인 파일 확인 (screen.png + code.html + DESIGN.md)
2. [ ] frontend_v2/ Next.js 프로젝트 생성
3. [ ] lib/ 디렉토리 기존 코드 복사
4. [ ] 공통 레이아웃 (헤더 + 사이드바) 구현
5. [ ] 랜딩 페이지 구현
6. [ ] Trade/Escrow 페이지 구현
7. [ ] Trade/Order 페이지 구현
8. [ ] Trade/Book 페이지 구현
9. [ ] Dashboard 페이지 구현
10. [ ] Claim 페이지 구현
11. [ ] Relayers 페이지 구현
12. [ ] 반응형 확인
