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
| 27 | UX | Cancel "Commitment rotation" 친화적 설명 | ✅ | `private-history/page.tsx:712` 친화적 2-line 메시지로 교체 — "Order cancelled successfully" + "Your sell tokens stay safe in your private balance under a new note" (2026-04-15) |
| 28 | UX | 가스비 추정 패널 가시성 강화 | ✅ | `private-order/page.tsx` 접힌 상태에서도 "↳ includes gas coverage ~X.XXXX ETH" 인라인 표시. `minFeeBps > feeBps` 인 경우 "bumped up to cover gas" 라벨 추가 (2026-04-15) |
| 29 | tech-debt | Dead `private_orders` / full-proof 경로 정리 | ✅ | PR #316 / 커밋 `e4f5da5` — `PrivateOrderbook`/`PrivateMatcher`/cross-relayer-matcher/관련 테스트 5개 삭제. 컨트랙트 `PrivateSettlement.settlePrivate()` 도 source에서 제거. 배포 반영은 #21 테스트넷 배포 시 적용 (2026-04-15) |
| 30 | relayer | `/api/p2p/orders` schema 정합성 — authorize 폴백 매칭 | ✅ | PR #318 / 커밋 `a046240` — POST 검증에서 `nonce` 제거, DELETE 권한 체크를 `lookupOrderRelayer` 콜백으로 교체. authorize 오더가 P2P fallback에서 정상 매칭됨 (2026-04-15) |
| 31 | relayer | authorize 오더북 pair 인덱스 (O(N) → O(pair)) | ✅ | `routes/authorize-orders.ts` 에 `ordersByPair` 인덱스 추가. `findMatch` + `AuthorizeCrossRelayerMatchService.onRemoteOrderArrived` 모두 pair lookup 사용 (2026-04-15) |
| R-14 | relayer | 부하 테스트 (k6/artillery) | 🔧 | **이번 PR** (`test/loadtest-r14-shared-ob` branch) — k6 기반 shared-orderbook 시나리오 4개: smoke / orders / leaderboard / settlements. `constant-arrival-rate` executor 사용으로 진짜 RPS 컨트롤: smoke(10 RPS × 30s) / load(100 RPS × 1min) / stress(1000 RPS × 2min). k6에 secp256k1 없어 서명 쓰기는 401 도달로 종료 — `verifyMessage` + body-hash 재계산 path 자체가 production-write의 cost-dominant 단계라 throughput 상한 측정에 유효. 4xx는 `http.expectedStatuses`로 expected 태깅해 실패율에서 배제. 태그(`type: read|write`) 별 p95 threshold(150/200/400ms). CI는 `workflow_dispatch` 수동 트리거 — `target` URL을 입력으로 받음(외부 staging만, 잡 안에서 서버 부팅 X). zk-relayer / on-chain settle 부하는 별도 트랙. |
| 32 | apps/pro | 메타어드레스 비밀키를 폴더 스토리지로 이전 | ✅ | **Stale (2026-05-13 확인)** — 원본 항목이 가리키던 `apps/pro/app/lib/metaAddress.tsx` 가 현재 코드베이스에 존재하지 않음 (중간 PR에서 마이그레이션됐거나 stealth 흐름이 재설계되며 모듈 자체가 사라짐). pro는 현재 `useFolderStorage` / `walletBook` 패턴을 이미 채택. 새 stealth 수신 UX가 빌드되면 그 시점에 별도 항목으로 재추가. (2026-04-30 기록 / 2026-05-13 stale 확인) |
| 34 | apps | CSP `'unsafe-eval'` 처리 | ⚠️ | **2026-05-13 부분 완료** (배포 대상 hub + pay만 처리, 나머지는 보류). PR #725로 `firebase.json`에 추가된 헤더는 타겟별로 다름. **hub** (정적 마케팅, ZK/wallet 없음): `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` (worker-src 없음, connect-src `'self'`만). **pay** (snarkjs worker + RPC + WebSocket): hub와 같지만 `img-src` += `blob:`, `worker-src 'self' blob:`, `connect-src 'self' https: wss:` 추가. 양쪽 모두 `script-src`에 `'unsafe-eval'` 없음 — XSS → RCE 경로 차단. 사이드 헤더: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. **남은 보류**: (a) **`frontend/`** — 배포 안 함 (참조 구현 only). `next.config.ts`의 `unsafe-eval`은 dev-only 영향이지만 **메인스레드 fallback 코드 경로가 실제로 존재** (`frontend/app/lib/zk/*-worker-client.ts` 4개 모두 `fallbackProve` → `*-prover.ts`에서 직접 `import("snarkjs")`). 즉 worker를 지원 안 하는 브라우저에서는 메인스레드로 폴백되므로 단순 헤더 제거 불가 — 배포 결정 나면 fallback 처리(예: 미지원 브라우저 거부) + 헤더 변경 묶음. (b) **docs / pro / relayer** — `hosting:disable`d 라 CSP 자체가 없음. 재오픈 시 hub(static) 또는 pay(worker) 패턴 복사. (2026-05-13) **갱신 (2026-06-25, 항목 #45 / 감사 A-7):** `pro`가 활성 배포로 재오픈됐음이 확인돼 PR #1084(`a70ae1c5`)로 pay 패턴 CSP를 복사 적용. 동시에 배포 3타겟(hub/pay/pro)에 `X-Frame-Options: DENY` + `Permissions-Policy` 백필. 남은 보류는 (a) `frontend/`(미배포)와 `docs`/`relayer`(hosting:disabled) 뿐. |
| 35 | shared-OB | 서명 메시지에 body hash 미포함 (replay-modify within 5min window) | ✅ | PR #693 (커밋 `9ca75a6d`) — 서명 메시지에 `:{sha256(rawBody)}` 추가, `REQUIRE_BODY_HASH=1` env로 legacy fallback 차단 가능. 양쪽 서버 모두 `express.json({ verify })`로 raw bytes 캡처. SDK `authHeaders(method, path, bodyBytes?)` API로 호출자가 body 명시. (2026-05-12) |
| 36 | shared-OB | 미검증(verified=0) settlement 행이 leaderboard/volume에 합산 | ✅ | PR #693 (`9ca75a6d`) verified-only 집계 노출 → PR #722에서 verifier 모듈 출시 → **이번 PR**에서 운영 와이어링 마무리. `src/core/verify-runtime.ts` (ethers `queryFilter` 기반 `makeEventFetcher` + `runVerifyLoop` watch 스케줄러 + `VerifyMonitor`) + `src/verify.ts` CLI (one-shot 또는 `--watch` 모드) + `/api/admin/verify-stats` (bearer-token timing-safe auth, `hasUnverifiedRows` + `oldestUnverifiedBlock` 알람 시그널). `deploy/runtime/compose.yml`에 `settlement-verifier` 서비스 (shared-orderbook 이미지 재사용, `orderbook-data` 볼륨 공유). 환경변수: `RPC_URL`, `PRIVATE_SETTLEMENT_ADDRESS`, `VERIFIER_POLL_INTERVAL_SEC` (30s), `VERIFIER_BLOCK_SAFETY_MARGIN` (6 confirmations — reorg 완화), `ADMIN_TOKEN`. (2026-05-13) |
| 37 | infra · SSRF | relayer URL SSRF guard 추가 | ✅ | PR #689 (커밋 `4135c2e0`) — `shared-orderbook` + `zk-relayer` 양쪽에 `lib/url-guard.ts` 도입. private/loopback/link-local/CGNAT/IPv4-mapped-v6(hex 포함) 거부, DNS lookup으로 hostname도 검사, 등록 시점 + 모든 outbound fetch 직전 재검사. dev escape hatch `ALLOW_PRIVATE_RELAYER_URLS=1` (scripts/dev*.sh + local docker-compose만 set). (2026-05-12) |
| 38 | SDK · relayer | `RelayerClient` txHash shape 검증 | ✅ | PR #689 (커밋 `4135c2e0`) — `submitOrder` / `submitClaim` / `submit/pollAuthorizeOrder` 모두 응답의 `txHash` 가 `^0x[0-9a-fA-F]{64}$` 인지 검증. `submitOrder`는 status가 `pending`/`queued`가 아닌데 txHash 없으면 throw. (2026-05-12) |
| 39 | shared-OB · test | body-hash / SSRF / verify-job 테스트 커버 | ✅ | (a) 베이스라인 35건 실패는 이미 중간 PR들로 회복 (확인 시점 84/84 PASS). (b) **이번 PR** — `test/auth.test.ts` (7건: body-bound accept / GET empty body / body-tamper reject / legacy fallback + warn / `REQUIRE_BODY_HASH=1` reject / timestamp skew / missing headers), `test/url-guard.test.ts` (21건: 6 private-IPv4 ranges + IPv6 loopback/ULA/link-local + IPv4-mapped hex + DNS rebind + 스킴 거부 + `ALLOW_PRIVATE_RELAYER_URLS=1` 우회), `test/verifier.test.ts` (11건: pure matcher + DB-integrated `runVerifyPass`). 합계 39 신규 / 123 total. (2026-05-13) |
| 40 | zk-relayer · test | p2p 라우트 body-hash / SSRF guard 테스트 미커버 | ✅ | **이번 PR** — `zk-relayer/test/p2p-auth.test.ts` (6건: body-bound accept / body-tamper reject / legacy fallback + warn / `REQUIRE_BODY_HASH=1` reject / missing headers / timestamp skew) `createP2PRoutes` 엔드포인트를 통해 검증. `shared-orderbook-client.ts` outbound guard는 shared-OB의 `url-guard.test.ts`가 동일 모듈을 커버. (2026-05-13) |
| 41 | apps · stealth | `apps/drop` claim 페이지의 stealth UI mock 재사용 위험 | ✅ | **2026-05-13 클로즈.** stealth 체크박스 자체를 페이지에서 제거. Phase 2.4(#668/#670/#672/#676)에서 SDK 레벨 stealth 삭제된 마당에 marketing mock에 옛 라벨 남겨두면 후속 엔지니어가 재도입 위험. JSDoc은 "drop은 privacy shape 미정 — 별도 design pass 필요"로 단순화. drop은 현재 `hosting:disable`d 상태이고 페이지는 무동작 mock이라 사용자 영향 0. 실제 drop claim 흐름이 들어올 때 fresh design pass에서 privacy 모델 결정. (2026-05-13) |
| 33 | apps/pay · UX | 수신자용 stealth wallet 인터페이스 + Stealth 메뉴 그룹화 | ⬜ | 현재 stealth 수신 흐름(메타어드레스 생성 / 공유 / ephemeralPubKey 입력 후 claim)이 `apps/pro /inbox` 에만 있음. pay 의 수신자(employees/contractors 등)는 pro 를 안 쓰기 때문에 pay 컨텍스트에서 자기 stealth wallet 을 다룰 수 있어야 함. **메뉴 구조 결정 (2026-04-30):** 단순히 `/wallet`·`/inbox` 를 top-level 에 평탄히 추가하지 말고, **"Stealth" 부모 메뉴 + 하위 "Wallet" / "Inbox" 드롭다운** 형태로 정리할 것 — pay 의 nav 가 이미 4 항목(Home/Dashboard/New payout/Address book) 이라 평탄하게 더하면 너무 많아짐. pro 도 동일하게 적용. 설계 옵션: (a) pay·pro 각각에 `/stealth/wallet`·`/stealth/inbox` 라우트 두고 같은 SDK 모듈 import, (b) shared `apps/wallet` 등으로 추출해 pro·pay 양쪽이 공유, (c) pay 의 claim link 페이지에서 메타어드레스 자동 생성·관리 통합. 항목 #32 (folder storage 이전) 와 같은 PR 또는 직후 PR 로 처리. |
| 42 | infra · SSRF | outbound fetch가 URL 가드 후 redirect를 따라가 SSRF 우회 (HIGH) | ✅ | **이번 PR** — 항목 #37 가드는 최초 URL만 검사하고 `fetch`는 기본 `redirect: "follow"`라, 공개 URL로 등록 후 307/308로 내부망·메타데이터(`169.254.169.254`)·내부 RPC(`127.0.0.1:8545`)로 돌리는 우회가 가능했음. 교차-릴레이어 outbound 3곳 모두 `redirect: "error"` 추가: `zk-relayer/src/core/shared-orderbook-client.ts` (postOrderToPeers / broadcastCancelToPeers), `authorize-cross-relayer-matcher.ts` (sendTradeOffer). 양쪽 `lib/url-guard.ts` 주석에 redirect 위협 명시. 회귀 테스트 `zk-relayer/test/cross-relayer-ssrf-redirect.test.ts` (307 redirect→internal target 미도달 검증). (2026-06-25) |
| 43 | shared-OB · zk-relayer | body-bound 서명 fail-closed 기본값 전환 (MEDIUM) | ✅ | **이번 PR** — 항목 #35 의 legacy(비-body-bound) 폴백이 `REQUIRE_BODY_HASH` 미설정 시 기본 허용이었고, 레포에 이를 강제하는 배포 산출물이 없어 5분 창 replay-modify가 열려 있었음. 전환 릴리스(#693, 2026-05) 종료 → 기본값을 fail-closed로 뒤집음: legacy는 명시적 `ALLOW_LEGACY_RELAYER_SIG=1` 일 때만 허용. `shared-orderbook/src/middleware/auth.ts` + `zk-relayer/src/routes/p2p.ts` 미러. 테스트 갱신: 기본 reject + 옵트인 accept+warn (`auth.test.ts`/`p2p-auth.test.ts`), 통합 스위트는 명시적 legacy 옵트인. (2026-06-25) |
| 44 | zk-relayer · 프라이버시 | 공개 `trade-offers` 엔드포인트 트레이더 식별자 노출 (감사 A-1, MEDIUM) | ✅ | PR #1083 (`aa40c06e`) — 공개 `GET /api/relayer/trade-offers` (`zk-relayer/src/routes/relayer-stats.ts`) 응답에서 트레이더 pubkey 등 식별 컬럼을 admin 전용 `GET /api/admin/trade-offers` 와 동일 기준으로 제거(프라이버시 invariant 일관성). 2026-06-25 전체모듈 감사 A-1. 상세: `보안_전체모듈_감사_2026-06-25.md` §A-1. (2026-06-25) |
| 45 | apps · hosting | `pro` 활성 배포에 CSP 없음 + defense-in-depth 헤더 백필 (감사 A-7, LOW) | ✅ | PR #1084 (`a70ae1c5`) — 항목 #34 의 보류분. `pro`가 funds-handling 활성 배포(`zkscatter-pro`)로 재오픈됐는데 CSP/nosniff/Referrer-Policy 부재 → pay 패턴 CSP를 `firebase.json` pro 타겟에 복사(`worker-src 'self' blob:`, `connect-src 'self' https: wss:`, `script-src` no `unsafe-eval`). 추가로 Gemini 리뷰 반영해 배포 3타겟(hub/pay/pro)에 `X-Frame-Options: DENY` + 제한적 `Permissions-Policy` 일괄 백필(divergence 0). 2026-06-25 감사 A-7. (2026-06-25) |

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
- **Contract**: `PrivateSettlement.settlePrivate()` 온체인 함수는 소스에서
  제거됨 (`chore/remove-settle-private`). 배포된 컨트랙트 반영은 테스트넷
  재배포 (#21) 시 같이 적용. 아래 Archive 섹션의 `settlePrivate` 표기는
  과거 이슈명 보존용 히스토리 기록이며, 현재 in-scope 함수가 아님.

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
