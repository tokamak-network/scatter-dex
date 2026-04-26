# Pro Trade Form v1 — 기획서

이 문서는 `feat/pro-trade-form-v1` PR의 **기획자 정합 문서**다. 코드 들어가기 전 의사결정을 종이에 박아두는 곳. PR이 머지되면 PRO_REPOSITION으로 흡수되고 이 파일은 archive.

## 1. 출발점 — 왜 지금 이 PR인가

PR #437 (UI primitives) 머지 후 `apps/pro` 워크벤치는 **5개 모달 + 헤더 + My Position 패널**까지 갖춰졌다. 다음 launch-blocker 묶음 (PRO_REPOSITION §7 Critical 7개 중 4개 미해결):

- ❌ Pair selector — ETH/USDC 하드코드
- ❌ Network switcher — DEMO_NETWORK 고정
- ❌ Order detail drawer — 별도 PR
- ❌ `/inbox` (stealth 수신) — 별도 PR
- ❌ Empty/error 상태 next-step CTA — 부분 처리됨

`/inbox`와 detail drawer는 별도 PR로 남기고, **이 PR은 "주문 폼이 production-grade로 바뀌는 한 PR"**.

## 2. 타겟 페르소나 — "Jihwan" 재확인

- 준전문가 / OTC 트레이더, 포지션 $20K–$1M, 월 5–30 거래
- 한국·아시아 시장 비중 큼 (Tokamak Network 모회사 + KISA-registered relayers + TON 페어 출시)
- 경쟁: Uniswap (UI 익숙) / CowSwap (MEV 보호) / Hyperliquid (속도)
- 차별화: **Big trades, privately split** — 한 주문 → 16명까지 비공개 분배 + per-claim vesting + Ethereum mainnet 결제

## 3. 토큰 화이트리스트 + 마켓 (확정)

**4 토큰**: ETH · USDC · USDT · TON  
**내부 wrap**: ETH는 UI에서 "ETH"로 표시, 온체인 note token = WETH 주소. SDK의 `withNativeEthAlias(tokens, wethAddress)` 헬퍼 사용.

| 토큰 | UI symbol | onchain | 카테고리 | quote market 자격 |
|---|---|---|---|---|
| ETH | ETH | WETH (wrap) | base + quote | ✓ ETH 마켓 |
| USDC | USDC | USDC | stable + quote | ✓ USDC 마켓 |
| USDT | USDT | USDT | stable + quote | ✓ USDT 마켓 |
| TON | TON | TON | base only | — |

**3 마켓 × 7 페어** (Upbit 컨벤션 — 마켓 = quote 기준):

| 마켓 (quote) | 페어 (base/quote) | featured |
|---|---|---|
| **USDC 마켓** | ETH/USDC, TON/USDC | ETH/USDC ★, TON/USDC ★ |
| **USDT 마켓** | ETH/USDT, TON/USDT | ETH/USDT ★ |
| **ETH 마켓** | USDC/ETH, USDT/ETH, TON/ETH | — |

**제외**: USDT/USDC 및 USDC/USDT — stable/stable 양방향 모두 같은 거래라 listing 안 함. Self-pair (ETH/ETH 등) 자동 제외.

**디폴트 페어**: ETH/USDC.

## 4. 페이지 IA

### 4.1 `/app` (워크벤치) — 본 PR의 핵심

**Flat pair dropdown** (마켓 탭 제거 — 4 토큰 / 7 페어에 적합한 단순 인터페이스):

```
┌─────────────────────────────────────────────────────┐
│ Workbench  [Pair: ETH/USDC ▾]            View → … │
├─────────────────────────────────────────────────────┤
│ [My Position]  [Order form]              [Orderbook]│
│  Balance        Buy/Sell tabs             ETH/USDC  │
│  Open orders    Price                     ask rows  │
│  Ready to claim Size [25%][50%]           ────────  │
│  Notes          ▸ Advanced settings       bid rows  │
│                 [Sign & submit]                     │
└─────────────────────────────────────────────────────┘
```

**Pair dropdown 내부 구조**:
```
┌─────────────────────┐
│ Featured            │
│ ★ ETH/USDC          │
│ ★ TON/USDC          │
│ ★ ETH/USDT          │
│ ─────────────       │
│ All pairs           │
│   TON/USDT          │
│   USDC/ETH          │
│   USDT/ETH          │
│   TON/ETH           │
└─────────────────────┘
```

- ★ Featured 섹션이 "디폴트 마켓" 역할 — 첫 사용자는 ★만 보면 충분
- 헤더 1 클릭 → 페어 즉시 변경 (탭+dropdown 2단계 X)
- 토큰 수 ~15+ 넘으면 quote-market 그룹 헤더 추가 (`pairsByMarket()` 헬퍼는 SDK에 이미 있음)

### 4.2 `/orders` (주문 히스토리) — 상태 필터 segmented control

```
┌─────────────────────────────────────────────────────┐
│ Orders   [All][Matching][Filled][Claimed][Cancelled]│
├─────────────────────────────────────────────────────┤
│ ord_8412  Sell  ETH/USDC  4,205   2.0   Filled  ...│
│ ord_8401  Buy   TON/USDT  5.42   500   Matching ...│
└─────────────────────────────────────────────────────┘
```

- **All / Matching / Filled / Claimed / Cancelled** — 트레이더의 일상 질문에 직접 답 ("미체결 몇 개?" "Claim 해야 할 것?")
- 디폴트: All
- 마켓 필터는 7 페어에서 거의 의미 없음 → 상태 필터로 대체

### 4.3 Order form 재구조 (Simple / Advanced) — "디폴트 vs 맞춤"

**Simple (default visible)** — 95% 사용자가 만지는 것:
- Side toggle: `Sell {base}` / `Buy {base}`
- Price: `{quote} / {base}` 라벨
- Size: `{base}` 라벨, Quick-fill (25/50/75/Max)
- Estimated fill + vs-Uniswap quote (현재 mock, 실 oracle 연결은 별도 PR)
- `[▸ Advanced settings]` 토글
- `[Sign & submit]`

**Advanced (collapsed)** — 권한 트레이더용:
- **Recipients (1–16)** — 행 빌더
  - mode: regular / stealth
  - address (empty = self for regular; `st:eth:...` for stealth)
  - amount (buy-side 토큰 단위)
  - delay (number + min/hr/day)
  - Reset / + Add / × Remove
- **Order valid until** — preset chips: 15m / 1h / 4h / 24h / 7d
- **Max relayer fee** — 슬라이더 0–100 bps, default 30

**Defaults**: 1 recipient (self), 1h expiry, 30 bps fee, immediate release. → 95% 사용자 Simple만 보면 됨.

## 5. Header 구성

| 컴포넌트 | 책임 |
|---|---|
| `PairSelector` | 모든 페어 단일 dropdown — Featured 섹션 + All pairs 섹션. 헤더 1 클릭 |
| `NetworkSwitcher` | Sepolia (active) + Mainnet (soon, disabled) |
| `RelayerPill` | 기존 그대로 |
| `ConnectWalletPill` | 기존 그대로 |
| `OrdersStatusFilter` (`/orders` 페이지) | All / Matching / Filled / Claimed / Cancelled segmented control |

## 6. 마케팅 카피 (L2 → mainnet 정정)

### 6.1 Layout metadata

**Before**: "MEV-free, balance-private, regulator-ready private limit orders on Ethereum L2."  
**After**: "MEV-free, balance-private, regulator-ready private limit orders. Up to 16 recipients per order. Ethereum mainnet settlement."

### 6.2 Landing hero (`apps/pro/app/page.tsx:18`)

**Before**: "Private limit orders on Ethereum L2 for semi-pro and OTC traders."  
**After**: "Private limit orders for semi-pro and OTC traders. Settle on Ethereum mainnet, split across up to 16 recipients per order, no balance exposure."

### 6.3 Stat sub label

**Before**: `~$0.01 / Cost per proof / L2 settlement`  
**After**: `~$0.01 / Cost per proof / Mainnet settlement`

### 6.4 (선택) 새 페르소나 카드 — "Treasury / family office"

기존 3개 페르소나 카드 (Semi-pro / OTC / Privacy whale) 옆에 4번째 추가 옵션:
> **Treasury / family office** — Pay vendors, route trade proceeds across N wallets in one private order. 16 recipients, optional per-recipient vesting.

이게 multi-recipient 마케팅 정합. **Decision 필요** (3 카드 유지 vs 4 카드 확장).

## 7. SDK 추가

`packages/sdk/src/core/whitelist.ts`:
- `WhitelistedToken` interface (TokenInfo + name + category + isQuoteMarket + launchOffer)
- `LAUNCH_TOKENS: Record<string, WhitelistedToken>` — 4 entries
- `LAUNCH_PAIRS: WhitelistedPair[]` — **7 entries** (3 quote markets × base tokens, self-pairs and stable/stable excluded)
- `pairsByMarket(pairs)` → `Record<"USDC"|"USDT"|"ETH", WhitelistedPair[]>`
- `findPair(display)`
- `tokensBySymbol(tokens)` — per-network address resolver

**ETH↔WETH wrapping**:
- `DEMO_NETWORK.tokens` 에는 WETH (실 주소, `isNative: false`) entry만
- 픽커 데이터는 `withNativeEthAlias(tokens, wethAddress)` 거쳐서 가공된 결과 → 합성 ETH entry (`isNative: true`, address = WETH 주소) 가 픽커 위에 추가됨
- 디포짓 시 `note.token` = WETH 주소 (ETH 받으면 wrap 후 deposit, 진짜 wrap UX는 별도 PR — 본 PR은 ERC20 WETH 가정)
- 거래 페어 `ETH/USDC` 의 base 토큰 주소 lookup → WETH 주소가 나옴

## 8. apps/pro 추가

| 파일 | 책임 |
|---|---|
| `lib/network.ts` (수정) | `DEMO_NETWORK.tokens` 4개 entry로 채움 + `NETWORKS` list |
| `lib/tradeForm.tsx` (신규) | 워크벤치 + 모달이 공유하는 form 상태 context |
| `components/PairSelector.tsx` (신규) | quote-그룹화 dropdown |
| `components/NetworkSwitcher.tsx` (신규) | 네트워크 픽커 |
| `components/AdvancedSettings.tsx` (신규) | Recipients 빌더 + Expiry chips + Max fee 슬라이더 |
| `app/app/page.tsx` (수정) | useTradeForm 사용, dynamic 라벨, PairSelector + AdvancedSettings 통합 |
| `app/layout.tsx` (수정) | TradeFormProvider + NetworkSwitcher 헤더 추가 |
| `app/page.tsx` (수정) | 마케팅 카피 정정 |
| `components/OrderModal.tsx` (수정) | trade form context에서 multi-recipient + expiry + maxFee 읽음 |

## 9. OrderModal 변경

기존: 단일 claim, 1h expiry 하드코드, 50 bps maxFee 하드코드.

신규:
- recipients[] → ClaimEntry[] 매핑 (regular = recipient 주소, stealth = stealth-derive로 일회성 주소 생성)
- expiry preset → seconds → AuthorizeProofInput.expiry
- maxFeeBps → AuthorizeProofInput.maxFee
- recipient amount 합 검증 (post-fee receive 커버)
- Sum != 100% 일 때 submit disabled

**Stealth 주소 derive**: SDK에 `deriveStealthAddress(metaAddr)` 있다면 사용. 없으면 placeholder 주소 사용 + TODO (SDK migration 후속).

## 10. 결정 (확정 — 디폴트 제안 채택)

| # | 질문 | 결정 |
|---|---|---|
| 1 | 4번째 페르소나 카드 (treasury / family office) 추가? | ✅ 추가 |
| 2 | 페어 listing | ✅ 7개 (stable/stable 제외) |
| 3 | Stealth recipient 진짜 derive | ⏸ placeholder UI + SDK migration 후속 |
| 4 | Recipient amount sum 부족 시 동작 | ✅ submit disabled + error message (frontend 패턴) |
| 5 | Buy side 지원 | ✅ 본 PR에서 지원 (페어 컨텍스트 풀려있어 자연스러움) |
| 6 | Network switcher 실 chain 전환 | ⏸ UI만, 실 전환은 multi-chain 후속 PR |
| 7 | 마케팅 카피 위치 | ✅ layout metadata + landing hero + StatBig sub label 모두 갱신 |
| 8 | 마켓 그룹 인터페이스 | ✅ Flat pair dropdown (마켓 탭 X) |
| 9 | `/orders` 필터 | ✅ 상태 필터 (All / Matching / Filled / Claimed / Cancelled) |
| 10 | i18n 한국어 버전 | ⏸ 영문 우선, follow-up |

**디폴트 페어 = ETH/USDC** — 추후 1줄 config 변경으로 swap 가능 (whitelist.ts featured flag).

## 11. 스코프 외 (follow-ups, 본 PR 안 함)

이번 PR 머지 후 들어갈 후속 작업 — 우선순위 순:

### A. **`apps/operators` 신설 — 릴레이어 운영자 사이트** (별도 PR)
SDK는 이미 다 있음 (`packages/sdk/src/relayer/{client,registry,profile,types}.ts`). 운영자가 자신의 릴레이어를 등록·관리할 surface 없는 게 공백.
- `/register` — 등록 + 스테이크
- `/profile` — fee / endpoint / 운영 정보 관리
- `/dashboard` — fill 통계, fee 수익
- `/orders` — 라우팅 중인 주문 모니터링

### B. `/inbox` stealth 수신 페이지
- 받은 stealth 클레임 스캔 + 클레임 CTA
- SDK migration의 stealth derive 통합 후 실 동작

### C. Order detail drawer
- `/orders` 행 클릭 시 right slide-out
- 풀 주문 정보 + tx 링크 + claim 상태 + raw signed payload

### D. `/markets` Upbit 스타일 페이지
- 토큰 수가 ~15+ 넘으면 의미 — 그때 추가
- 현재 4 토큰엔 over-engineering

### E. 실 stealth derive
- SDK의 `deriveStealthAddress()` 통합
- AdvancedSettings의 stealth mode가 진짜 receiver 생성

### F. 실 vs-Uniswap quote
- Uniswap SOR 호출
- "Estimated fill" / "vs Uniswap" 라이브 수치

### G. Multi-chain 활성 전환
- NetworkSwitcher 클릭 → DEMO_NETWORK 변경 + per-chain `IndexedDbNoteAdapter` 재초기화
- TODO 코멘트 lib/vault.tsx에 박혀있음

### H. 마케팅 카피 한국어 i18n
- next-intl 또는 단순 dictionary 기반
- 현재 영문만

### I. Simplify 후속 (본 PR Medium findings)
- `useOutsideClick` 훅 추출 (PairSelector + NetworkSwitcher 중복)
- `resetRecipients` 사용자 확인 다이얼로그
- TradeFormProvider selector 패턴 (re-render 최적화) — 프로파일링 후 결정
- PairSelector 키보드 네비 (arrow keys roving focus)

## 12. 워크플로우

표준 단계:
1. 개발 (이 문서 + 기획 정합 후)
2. 최적화
3. simplify (3 채널 review agent)
4. 테스트 (typecheck + build + 로컬 화면 확인)
5. 커밋 → 푸시 → PR
6. 봇 리뷰 영문 답글 + 반영
7. 일반 머지

## 13. 결재 체크리스트 (본 문서 합의 후 코딩 진입)

- [x] 4 토큰 / 7 페어 / Flat pair dropdown 합의
- [x] Simple/Advanced 분리 + Advanced 3개 (recipients/expiry/maxFee) 합의
- [x] 마케팅 카피 (mainnet 방향) 합의
- [x] Open questions §10의 10개 답변 확정 (디폴트 채택)
- [x] 별도 PR로 빠진 follow-up: `/markets`, `/inbox`, order detail drawer, 실 stealth derive, multi-chain 활성 전환, i18n 한국어
