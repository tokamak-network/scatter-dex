# Security & Roadmap Tracker

보안 감사 / 기능 / UX / 운영 항목의 단일 트래커. 작업 시작 시 브랜치명을
기입해 동시 작업 충돌을 막는다. 완료된 라운드별 감사는 본문 하단 `Archive`
섹션에 요약만 보관한다.

> ⬜ TODO | 🔧 IN PROGRESS (브랜치) | ⚠️ PARTIAL | ✅ DONE (PR/커밋) | ❌ WON'T DO (사유)

---

## Open items

| # | 영역 | 항목 | 상태 | 비고 |
|---|------|------|------|------|
| 12 | mobile | 앱 키 보안 (Keychain/Keystore + 생체인증) | ⬜ | `feat/mobile-app` 전용 (main 범위 외) |
| 15 | mobile | 네비게이션 (hamburger 메뉴) | ⬜ | `feat/mobile-app` 전용 (main 범위 외) |
| 21 | infra | 테스트넷 배포 (Sepolia / Titan L2) | ⬜ | 최근 fee redesign / cross-relayer / claim guard 모두 main 반영됨, 좋은 타이밍 |
| 27 | UX | Cancel "Commitment rotation" 친화적 설명 | ⚠️ | 한 줄 메시지 있음 ("Escrow rotated to new commitment", `private-history/page.tsx:727`); 더 친화적 설명 여지 |
| 28 | UX | 가스비 추정 패널 가시성 강화 | ⚠️ | `GasEstimate` 이미 계산됨 — `private-order/page.tsx:567` 의 `useState`, `<FeeBreakdown>` 으로 1508 line 에서 렌더. 가시성 보강은 주관 영역 |
| 29 | tech-debt | Dead `private_orders` / full-proof 경로 정리 | ⬜ | 아래 #29 메모 참고 |
| 30 | relayer | `/api/p2p/orders` schema 정합성 — authorize 폴백 매칭 | ⬜ | `OrderSummary` 와 P2P 라우트 검증 필드 불일치로 P2P fallback 시 authorize 매칭이 동작하지 않음. PR #308 Copilot finding |
| 31 | relayer | authorize 오더북 pair 인덱스 (O(N) → O(pair)) | ⬜ | 현재 cross-relayer 매칭 시 전체 Map 스캔. 10k cap 안에서는 무시 가능, 트래픽 늘면 우선순위 상향. PR #308 gemini finding |
| R-14 | relayer | 부하 테스트 (k6/artillery) | ⬜ | 동시 주문/정산 부하 시나리오 |

### #29 범위 메모 (2026-04-15 갱신)

S-M14 (PR #215, scatterDirectAuth) 이후 모든 프런트 주문은 `authorize_orders`
경로로만 들어옴. `POST /api/private-orders` 는 410 Gone. 남은 dead 코드:

- **Relayer**: `core/orderbook.ts` `PrivateOrderbook`, `core/private-submitter.ts`
  `submitPrivateSettle`/`submitScatterDirect`, `core/matcher.ts` `PrivateMatcher`,
  `core/cross-relayer-matcher.ts` 전체, `routes/orders.ts` `GET /:pubKeyAx`,
  `types/order.ts` `PrivateOrder`/`StoredPrivateOrder`/`PrivateMatch`/
  `CrossRelayerMatch`/`parsePrivateOrder`/`serializePrivateOrder`/`pairKey`,
  `core/db.ts` `private_orders` 테이블, 테스트 5개 (`orderbook.test.ts`,
  `matcher.test.ts`, `cross-relayer-matcher.test.ts`, `scenarios.test.ts`,
  `e2e-private-flow.ts`).
- **Frontend**: `private-history/page.tsx:323` `GET /api/private-orders/:pubKeyAx`
  호출 (현재 항상 빈 배열). authorize 기반 히스토리로 교체.
- **Contract** (별도 감사): `PrivateSettlement.settlePrivate()` 온체인 함수.
  배포된 컨트랙트에서 제거하려면 재배포 필요 — 테스트넷 배포 (#21) 시 같이 검토.

기존 메모의 "단순 삭제 시 cross-relayer 매칭 0" 경고는 **PR #308
(`AuthorizeCrossRelayerMatchService`) 도입으로 해소됨**. 이제는 dead 경로를
지워도 cross-relayer 매칭이 authorize 쪽에서 정상 동작.

---

## 결정 — 작업하지 않음

| # | 항목 | 사유 |
|---|------|------|
| 24 | Safari File System API 미지원 대체 경로 | 작업하지 않기로 결정 (2026-04-14) |
| R-11 | 부분 체결 (partial fill) | 작업하지 않기로 결정 (2026-04-14) |
| R-12 | AMM/DEX 라우팅 (미매칭 주문 자동 라우팅) | N/A — 지정가 주문 설계상 해당 없음 |

---

## Archive — 완료된 작업

이 섹션은 **참고용**이다. 운영 중 같은 이슈가 재발하면 어느 PR 에서 처리됐는지
역추적할 수 있게 요약만 남긴다. 자세한 내용은 git history.

### 1차 보안 감사 (2026-04-11) — C-1 ~ L-9

<details>
<summary>전체 13건 모두 ✅ 처리</summary>

| # | 이슈 | PR |
|---|------|----|
| C-1 | settleWithDex MEV/sandwich (deadline + slippage + 1inch split) | #151, #172, #188 |
| C-2 | claim.circom token/releaseTime 미구속 | #176 |
| C-3 | 하드코딩 프라이빗 키 (.env 노출) | #175 |
| H-3 | transferFee 풀 드레인 벡터 (per-tx cap + setAuthorizedSettlement timelock) | #178 |
| H-4 | SSRF in /api/swap (chainId 검증) | #178 |
| H-5 | claimCount 범위 미검증 (ZK 회로) | #179 |
| H-6 | Admin API 키 노출 + 약한 검증 (timing-safe) | #177 |
| M-6 | CORS `["*"]` | #180 |
| M-7 | API rate limiting | #181 |
| M-8 | pubKeyBind 체인 분석 링크 가능성 | #182 |
| M-9 | 클라이언트 사이드 SSRF (claim) | #183 |
| M-10 | DB 파일 퍼미션 644 | #184 |
| M-11 | cross-relayer 매칭 race condition | #186 |
| L-5~L-9 | 5건 LOW (stealth secret URL, XSS→EdDSA, localStorage 격리, DB 암호화, withdraw recipient/relayer 바인딩) | #187 |

</details>

### settleWithDex 라운드 (2026-04-11) — C-4 ~ M-15

<details>
<summary>10건 ✅ 처리</summary>

| # | 이슈 | 커밋 |
|---|------|------|
| C-4 | feeVault 미설정 + dexPlatformFeeBps > 0 → revert | `ab4f847` |
| C-5 | 프론트 DEX calldata에 fee 차감 전 sellAmount 인코딩 | `ab4f847` |
| C-6 | sellToken == buyToken 시 Panic(17) underflow | `75db603`, `d25a4f3` |
| H-7 | settleWithDex 릴레이어 레지스트리 체크가 일반 사용자 차단 | `ab4f847` |
| H-8 | settleAuth/settlePrivate sanctions 체크 누락 | `feeec6d` |
| H-9 | WithdrawVerifier delta == gamma (phase-2 미실행) | `0b578c9` |
| M-12 | DexSwapFailed 가 두 실패 구분 불가 | `3b40e73` |
| M-13 | Uniswap router 주소 오류 (SwapRouter vs SwapRouter02) | `3b40e73` |
| M-14 | minReceive 부동소수점 반올림 | `3b40e73` |
| M-15 | setSanctionsList EOA 체크 없음 | `206dc51` |

</details>

### 컨트랙트 감사 일반 (H-1, H-2, M-1, M-3~M-5, L-1~L-4)

<details>
<summary>10건 ✅ 처리 / 문서화</summary>

H-1 fee-on-transfer 회계 / H-2 exiting relayer updateInfo / M-1 owner
2단계 이전 / M-3~M-5 claimHash 영구 / withdraw identity / 양측 fee
(설계상 의도) / L-1~L-4 (releaseDelay 0, unpause delay, bond slashing,
unbounded loop) — 모두 처리 또는 문서화 완료.

</details>

### 릴레이어 메인넷 준비 (R-1 ~ R-10, R-13)

<details>
<summary>11건 ✅ 처리</summary>

| # | 이슈 | PR |
|---|------|----|
| R-1 | 가스 추정 (gas-guard) | #198, #200 |
| R-2 | TX 재시도 (send-phase + wait timeout + receipt recovery + pending TX DB) | #201 |
| R-3 | 헬스체크 `/health` | #202 |
| R-4 | RPC 페일오버 (FallbackProvider) | #202 |
| R-5 | 커밋먼트 재인덱싱 체크포인트 | #202 |
| R-6 | authorize 주문 SQLite 영속화 + 재시작 복원 | #202 |
| R-7 | Admin API (fee/drain/balance/pause) | #205 |
| R-8 | 인메모리 런타임 메트릭스 | #214 |
| R-9 | 운영 가이드 (operations-guide.md) | #216 |
| R-10 | OFAC 제재 목록 연동 | #217 |
| R-13 | API 라우트 테스트 (Tier-1 + Tier-2) | #218, #222, #224 |

</details>

### 2차 보안 감사 (S-C1, S-H1~H7, S-M1~M15)

<details>
<summary>23건 ✅ 처리</summary>

ownerSecret 레거시 제거 (S-C1, PR #197) / settle.circom claim token 검증
(S-H1) / withdraw.circom range check (S-H2, 확인) / note 직렬화 pubKey
(S-H3, S-H4) / CSP/COOP/COEP (S-H5, PR #187) / cross-relayer secrets
평문 제거 (S-H6, PR #197) / authorize orders DoS 방어 (S-H7, PR #203) /
회로 최적화/검증 (S-M1~M5, PR #179/#207/#204) / RelayerRegistry
ReentrancyGuard (S-M6, PR #208) / FeeVault claim 프론트런 (S-M7, PR #209)
/ Trade Offer 검증 (S-M8, PR #210) / rate limiter identity-based (S-M9,
PR #212) / Worker secrets 제로화 (S-M12, PR #211) / totalLocked bit-width
정합 (S-M13, PR #206) / scatterDirect → authorize 마이그레이션 (S-M14,
PR #215) / shared orderbook 연동 (S-M15, PR #213).

</details>

### 기능 / UX 라운드 (#14 ~ #28)

<details>
<summary>9건 ✅ + 2건 ⚠️ + 2건 ❌ (active 항목은 위 Open items 참고)</summary>

| # | 항목 | PR |
|---|------|----|
| 14 | 폴더 선택 전역화 | #190 |
| 16 | 에러 메시지 친화적 | #194 |
| 17 | 주문 후 다음 단계 안내 | #290 |
| 18 | DEX 가격 로딩 폴백 | #191 |
| 19 | 다중 지갑 지원 (WalletConnect) | #193 |
| 20 | Batch Claim (`claimWithProofBatch`, MAX_CLAIM_BATCH_SIZE=20) | (이전 세션) |
| 22 | Order 키 파생 UX — 자동 키 언락 | #195 |
| 23 | Limit↔Market 전환 시 상태 초기화 | #195 |
| 25 | Claims 16개 cap 사유 표시 (툴팁) | #290 |
| 26 | Stealth/Cross-relayer 툴팁 설명 | #290 |

</details>

### 2026-04-15 추가 (cross-relayer 사이클)

<details>
<summary>최근 세션에서 처리된 4건 — 모두 main 머지</summary>

| 영역 | 항목 | PR |
|------|------|----|
| relayer | Authorize cross-relayer matching (`AuthorizeCrossRelayerMatchService` + P2P trade-offer + WS reconcile-on-reconnect) | #308 |
| frontend | Claim UI 정산 대기 가드 (`useClaimsGroupStatus` + 10s 폴링 + 3-버튼 + batch gate) | #310 |
| relayer | Shared-OB id derivation from nullifier (post-restart cleanup 정상화) | #313 |
| docs | Dead `private_orders` 청소 tracker (#29) 등재 | #306 |

</details>
