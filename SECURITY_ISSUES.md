# Security Issues Tracker

보안 감사에서 발견된 이슈 목록. 작업 시 **브랜치 명을 기록**하여 동시 작업 충돌 방지.

> ⬜ TODO | 🔧 IN PROGRESS (브랜치: `xxx`) | ⚠️ PARTIAL | ✅ DONE (PR/커밋)

## TODO — 2026-04-11 전체 스택 보안 감사

### 🔴 CRITICAL (즉시 조치)

#### C-1. settleWithDex 프론트러닝/샌드위치 공격
- **파일**: `PrivateSettlement.sol:938-941`
- **내용**: DEX calldata가 멤풀에 노출되어 MEV 샌드위치 공격 가능.
- **수정**: `amountOut < totalLocked` 검증(DexOutputInsufficient) 추가 + 프론트엔드에서 slippage 기반 minReceive 설정 + 1inch Pathfinder 분할 주문으로 슬리피지 최소화
- **상태**: ⚠️ 부분 수정 (PR #151, #172). deadline은 `block.timestamp` 사용 중 — Flashbots/private mempool 권장

#### C-2. claim.circom token/releaseTime 미구속
- **파일**: `claim.circom:49-51`
- **내용**: public input `token`, `releaseTime`이 회로 내에서 equality constraint 없음. 위조된 값으로 클레임 가능.
- **수정**: `tokenSq <== token * token;` 등 바인딩 제약 추가
- **상태**: ⬜ TODO

#### C-3. 하드코딩된 프라이빗 키 (.env 파일)
- **파일**: `relayer/.env:2`, `zk-relayer/.env:2,7`, `docker-compose.yml:30,67,99`
- **내용**: Anvil 테스트 키 + Admin API 키가 버전 컨트롤에 노출. 프로덕션 배포 시 자금 탈취 위험.
- **수정**: `.env`를 `.gitignore`에 추가, `.env.example`만 유지, 시크릿 매니저 도입
- **상태**: ✅ DONE (PR #175)

### 🟠 HIGH (메인넷 전 필수)

#### H-3. transferFee 풀 드레인 벡터
- **파일**: `CommitmentPool.sol:240-246`
- **내용**: fee 금액 상한 없음, `setAuthorizedSettlement` 타임락 없이 즉시 변경 가능.
- **수정**: per-tx fee 상한 + `setAuthorizedSettlement` 타임락(24~48h) 도입
- **상태**: ⬜ TODO

#### H-4. SSRF in /api/swap (chainId 미검증)
- **파일**: `frontend/app/api/swap/route.ts`
- **내용**: `chainId` 파라미터가 URL에 직접 삽입됨. 서버사이드 요청 위조 가능.
- **수정**: chainId 숫자 검증 + src/dst/from 주소 형식 검증 + 에러 텍스트 200자 절삭
- **상태**: ✅ DONE (PR #174, 커밋 3a9bdbc + fe3b10a)

#### H-5. claimCount 범위 미검증 (ZK 회로)
- **파일**: `authorize.circom:214`, `settle.circom:189,197`
- **내용**: `claimCount`에 범위 검증 없어 필드 산술 오버플로로 로직 우회 가능.
- **수정**: `Num2Bits(5)` + `LessEqThan(5)` 범위 체크 추가 (`claimCount ≤ 16`). settle.circom도 동일 수정 + `LessThan(252)` → `LessThan(5)` 최적화 (~7,900 constraints 절감)
- **상태**: ✅ DONE (PR #179)

#### H-6. Admin API 키 노출 + 약한 검증
- **파일**: `zk-relayer/.env:7`, `zk-relayer/src/routes/vault.ts:25-37`
- **내용**: 하드코딩된 dev 키 + 타이밍 공격 취약한 단순 문자열 비교.
- **수정**: 환경변수로 분리 + `crypto.timingSafeEqual` 사용
- **상태**: ✅ DONE (PR #177)

### 🟡 MEDIUM (강력 권장)

#### M-6. CORS 기본값 `["*"]`
- **파일**: `shared-orderbook/src/config.ts:26`
- **수정**: 명시적 origin 허용 목록 설정
- **상태**: ⬜ TODO

#### M-7. API Rate Limiting 미구현
- **파일**: `frontend/app/api/swap/route.ts`, `frontend/app/api/upbit/route.ts`
- **수정**: Next.js 미들웨어 또는 rate-limit 패키지 도입
- **상태**: ⬜ TODO

#### M-8. pubKeyBind 체인 분석 링크 가능성
- **파일**: `authorize.circom:489-490`
- **수정**: 프라이버시 영향 문서화, 필요시 랜덤 블라인딩 추가 검토
- **상태**: ⬜ TODO

#### M-9. 클라이언트 사이드 SSRF 검증 (우회 가능)
- **파일**: `frontend/app/trade/private-claim/page.tsx:134-152`
- **수정**: 서버사이드 프록시 도입, 클라이언트에서 직접 릴레이어 호출 금지
- **상태**: ⬜ TODO

#### M-10. DB 파일 퍼미션 644
- **파일**: `relayer/relayer.db`, `zk-relayer/zk-relayer.db`
- **수정**: 퍼미션 600으로 변경
- **상태**: ⬜ TODO

#### M-11. cross-relayer 매칭 race condition
- **파일**: `zk-relayer/src/core/cross-relayer-matcher.ts`
- **수정**: 수평 확장 시 분산 락(distributed lock) 도입 필요
- **상태**: ⬜ TODO

### 🟢 LOW (개선 권장)

#### L-5. Stealth 링크 시크릿 URL 노출
- **파일**: `frontend/app/lib/stealth.ts:154-160`
- **수정**: URL fragment(`#`) 사용 또는 POST 방식으로 변경
- **상태**: ⬜ TODO

#### L-6. XSS 시 EdDSA 키 탈취 가능
- **파일**: `frontend/app/lib/zk/eddsa.ts:156-173`
- **수정**: CSP 헤더 강화, Web Worker 격리 검토
- **상태**: ⬜ TODO

#### L-7. localStorage 도메인/지갑 격리 미흡
- **파일**: `frontend/app/lib/provider.ts`, `frontend/app/lib/zk/note-storage.ts`
- **수정**: 키 네임스페이스에 지갑 주소 포함
- **상태**: ⬜ TODO

#### L-8. DB 암호화 미적용
- **파일**: `relayer/relayer.db`, `zk-relayer/zk-relayer.db`
- **수정**: SQLCipher 또는 프로덕션 DB 전환 시 암호화 적용
- **상태**: ⬜ TODO

#### L-9. withdraw.circom recipient/relayer 바인딩 불완전
- **파일**: `circuits/withdraw.circom:56-61`
- **수정**: 명시적 equality constraint 추가 검토
- **상태**: ⬜ TODO

## 2026-04-11 세션에서 발견 및 수정된 이슈

### settleWithDex 관련 (25건 — docs/settleWithDex-audit-log.md 참조)

#### ✅ C-4. feeVault 미설정 + dexPlatformFeeBps > 0 → revert
- **커밋**: ab4f847
- **수정**: `FeeVaultRequired` 에러 + `setFeeVault(0)` 시 fee 자동 리셋

#### ✅ C-5. 프론트엔드 DEX calldata에 full sellAmount 인코딩 (fee 차감 전)
- **커밋**: ab4f847
- **수정**: on-chain `dexPlatformFeeBps` 읽어서 post-fee swapAmountIn 계산

#### ✅ C-6. sellToken == buyToken 시 Panic(17) underflow
- **커밋**: 75db603, d25a4f3
- **수정**: unspent sellToken 반환 가드 + `TokenSidesMismatch` revert 추가

#### ✅ H-7. settleWithDex 릴레이어 레지스트리 체크가 일반 사용자 차단
- **커밋**: ab4f847
- **수정**: 시장가는 permissionless — 릴레이어 체크 제거

#### ✅ H-8. settleAuth/settlePrivate sanctions 체크 누락
- **커밋**: feeec6d
- **수정**: `_requireNotSanctioned(msg.sender)` 추가

#### ✅ H-9. WithdrawVerifier delta == gamma (phase-2 미실행)
- **커밋**: 0b578c9
- **수정**: dev phase-2 contribution 추가, 독립 delta 생성

#### ✅ M-12. DexSwapFailed 가 두 실패 구분 불가
- **커밋**: 3b40e73
- **수정**: `DexCallReverted` + `DexOutputInsufficient(actual, required)` 분리

#### ✅ M-13. Uniswap router 주소 오류 (SwapRouter vs SwapRouter02)
- **커밋**: 3b40e73
- **수정**: 0xE592 → 0x68b3 + per-chain map

#### ✅ M-14. minReceive 부동소수점 반올림
- **커밋**: 3b40e73
- **수정**: BigInt 정수 연산으로 floor 보장

#### ✅ M-15. setSanctionsList EOA 체크 없음
- **커밋**: 206dc51
- **수정**: `code.length` 검증 추가

## 작업 완료

### H-1. Fee-on-transfer / Rebasing 토큰 회계 불일치
- **PR**: `optimize/gas-settlement` (토큰 화이트리스트로 해결)
- **내용**: fee-on-transfer/rebasing 토큰은 실제 수신량 != 기록량. 표준 ERC20만 허용하는 화이트리스트 도입.
- **상태**: ✅ DONE

### H-2. Exit 중인 relayer가 updateInfo() 호출 가능
- **내용**: `updateInfo()`에 `exitRequestedAt == 0` 체크 누락. exit 요청 중 fee 변경 가능.
- **수정**: `updateInfo()`에 `if (r.exitRequestedAt > 0) revert AlreadyExiting();` 추가.
- **파일**: `RelayerRegistry.sol:105`
- **상태**: ✅ DONE (PR #20에서 해결)

### M-1. Owner 단일 실패점 — 2단계 이전
- **내용**: `transferOwnership()`이 즉시 소유권 이전. 잘못된 주소 입력 시 복구 불가.
- **수정**: 2단계 패턴 도입 (pendingOwner → acceptOwnership). ScatterSettlement + RelayerRegistry 모두.
- **파일**: `ScatterSettlement.sol`, `RelayerRegistry.sol`
- **상태**: ✅ DONE (PR #19)

### M-3. claimHash 영구 재사용 불가 — 문서화
- **내용**: claimed/refunded된 claimHash는 amount != 0이므로 영구적으로 재사용 불가. depositor가 매번 고유 secret 사용해야 함.
- **수정**: NatSpec 주석 추가.
- **파일**: `ScatterSettlement.sol`
- **상태**: ✅ DONE (PR #20)

### M-4. withdraw()에 identity 검증 없음 — 문서화
- **내용**: 의도적 설계 (fund lockup 방지). 제재 대상 사용자도 인출 가능.
- **수정**: NatSpec 주석으로 설계 의도 명시.
- **파일**: `ScatterSettlement.sol`
- **상태**: ✅ DONE (PR #20)

### M-5. 양측 fee 적용 — 문서화
- **내용**: actualFee가 maker/taker 양쪽 sellAmount 각각에 적용됨. 사용자가 인지해야 함.
- **수정**: NatSpec + PAPER.md에 명시.
- **파일**: `ScatterSettlement.sol`, `docs/PAPER.md`
- **상태**: ✅ DONE (PR #20)

### L-1. releaseDelay = 0 허용 — 최소 지연 도입
- **내용**: releaseDelay에 최소값 없어 즉시 claim 가능. privacy temporal dissociation 무효화.
- **수정**: `MIN_RELEASE_DELAY` 상수 도입 (1 hour).
- **파일**: `ScatterSettlement.sol`
- **상태**: ✅ DONE (PR #20)

### L-2. Unpause delay 없음 — 문서화
- **내용**: setPaused(false) 즉시 적용. owner 키 탈취 시나리오에서만 관련.
- **수정**: NatSpec 주석. 향후 Timelock 거버넌스 권장 명시.
- **파일**: `ScatterSettlement.sol`
- **상태**: ✅ DONE (PR #20)

### L-3. RelayerRegistry bond slashing 없음 — 문서화
- **내용**: 악의적 relayer에 대한 경제적 제재 메커니즘 없음.
- **수정**: NatSpec 주석으로 향후 슬래싱 도입 가능성 명시.
- **파일**: `RelayerRegistry.sol`
- **상태**: ✅ DONE (PR #20)

### L-4. getActiveRelayers() unbounded loop — 문서화
- **내용**: relayerList 무한 성장 시 gas limit 초과. view 함수이므로 on-chain 영향 없음.
- **수정**: NatSpec 경고 주석. pagination 파라미터 추가 검토.
- **파일**: `RelayerRegistry.sol`
- **상태**: ✅ DONE (PR #20)

---

## 전체 로드맵 (보안 + 기능 + UX)

> 작업 시작 시 브랜치명을 기입하여 동시 작업 충돌 방지

### 🔴 미해결 보안 이슈 (메인넷 전 필수)

| # | 이슈 | 심각도 | 상태 | 브랜치 |
|---|------|--------|------|--------|
| C-1 | settleWithDex MEV (deadline) | CRITICAL | ✅ | PR #188 |
| C-2 | claim.circom token/releaseTime 미구속 | CRITICAL | ✅ | PR #176 |
| C-3 | 하드코딩 프라이빗 키 (.env) | CRITICAL | ✅ | PR #175 |
| H-3 | transferFee 풀 드레인 벡터 | HIGH | ✅ | PR #178 |
| H-5 | claimCount 범위 미검증 | HIGH | ✅ | PR #179 |
| H-6 | Admin API 키 노출 + 약한 검증 | HIGH | ✅ | PR #177 |
| M-6 | CORS `["*"]` | MEDIUM | ✅ | PR #180 |
| M-7 | API Rate Limiting | MEDIUM | ✅ | PR #181 |
| M-8 | pubKeyBind 체인 분석 | MEDIUM | ✅ | PR #182 |
| M-9 | 클라이언트 SSRF (claim) | MEDIUM | ✅ | PR #183 |
| M-10 | DB 파일 퍼미션 | MEDIUM | ✅ | PR #184 |
| M-11 | cross-relayer race condition | MEDIUM | ✅ | PR #186 |
| L-5~L-9 | 5건 LOW | LOW | ✅ | PR #187 |

### 🟠 기능 개발

| # | 작업 | 상태 | 브랜치 |
|---|------|------|--------|
| 12 | 모바일 앱 키 보안 (Keychain/Keystore + 생체인증) | ⬜ | — |
| 21 | 테스트넷 배포 (Sepolia / Titan L2) | ⬜ | — |

### 🟡 UX 개선 (사용자 플로우 체크에서 발견)

| # | 작업 | 상태 | 브랜치 |
|---|------|------|--------|
| 14 | 폴더 선택 전역화 (localStorage persist) | ✅ | PR #190 |
| 15 | 모바일 네비게이션 (hamburger 메뉴) | ⬜ | — |
| 16 | 에러 메시지 사용자 친화적 | ✅ | PR #194 |
| 17 | 주문 후 다음 단계 안내 | ⬜ | — |
| 18 | DEX 가격 로딩 폴백 | 🔧 | `feat/ux18-dex-price-fallback` |
| 19 | 다중 지갑 지원 (WalletConnect) | 🔧 | `feat/ux19-multi-wallet` |
| 20 | Batch Claim | ⬜ | — |

### 🔴 수정 필요 (2026-04-11 전체 점검에서 발견)

| # | 작업 | 상태 | 브랜치 |
|---|------|------|--------|
| 22 | Order 키 파생 UX — 자동 키 언락 | ✅ | PR #195 |
| 23 | Limit↔Market 전환 시 상태 초기화 | ✅ | PR #195 |

### 🟢 보강 가능 (UX 점검 결과)

| # | 작업 | 상태 |
|---|------|------|
| 24 | Safari File System API 미지원 대체 경로 | ⬜ |
| 25 | Claims 10개 도달 시 사유 표시 | ⬜ |
| 26 | Stealth/Cross-relayer 개념 툴팁 설명 | ⬜ |
| 27 | Cancel 시 "Commitment rotation" 쉬운 설명 | ⬜ |
| 28 | 가스비 추정 패널 더 눈에 띄게 | ⬜ |

### 🔴 릴레이어 메인넷 준비 (2026-04-11 릴레이어 점검)

> 릴레이어 운영자 관점에서 메인넷 배포 전 필수 보강 사항

#### 🔴 CRITICAL (메인넷 필수)

| # | 이슈 | 내용 | 상태 | 브랜치 |
|---|------|------|------|--------|
| R-1 | 가스 추정 없음 | gas-guard 구현 + 유닛 테스트 12건 (#199) | 🔧 | `fix/R1-gas-estimation`, `test/R1-gas-guard-unit-tests` |
| R-2 | TX 재시도 없음 | 🔧 | `fix/R2-tx-retry` |
| R-3 | 헬스체크 없음 | `/health` 엔드포인트 (RPC + DB 체크) | 🔧 | `fix/R3-R6-relayer-hardening` |
| R-4 | RPC 페일오버 없음 | FallbackProvider + `RPC_URLS_FALLBACK` env var | 🔧 | `fix/R3-R6-relayer-hardening` |
| R-5 | 커밋먼트 재인덱싱 | DB 체크포인트로 마지막 인덱싱 블록 저장, 재시작 시 이어서 스캔 | 🔧 | `fix/R3-R6-relayer-hardening` |
| R-6 | authorize 주문 인메모리 | SQLite `authorize_orders` 테이블 + 재시작 시 pending 주문 복원 | 🔧 | `fix/R3-R6-relayer-hardening` |

#### 🟠 HIGH (강력 권장)

| # | 이슈 | 내용 | 상태 | 브랜치 |
|---|------|------|------|--------|
| R-7 | Admin API 부재 | 런타임 fee 변경, 주문 drain, ETH 잔액 조회, pause/resume 불가 | ⬜ | — |
| R-8 | 메트릭스 없음 | Prometheus 미연동. 가스비/매칭률/proof 시간 미추적 | ⬜ | — |
| R-9 | 운영 문서 없음 | 배포 가이드, 설정 레퍼런스, 트러블슈팅 가이드 없음 | ⬜ | — |
| R-10 | 제재 목록 미연동 | pubKeyBind 필드 있지만 실제 OFAC 블록리스트 연동 없음 | ⬜ | — |

#### 🟡 MEDIUM (개선 권장)

| # | 이슈 | 내용 | 상태 |
|---|------|------|------|
| R-11 | 부분 체결 | 주문 전체 체결만 가능 (partial fill 미지원) | ⬜ |
| R-12 | AMM/DEX 라우팅 | 미매칭 주문을 DEX로 자동 라우팅 | ⬜ |
| R-13 | API 라우트 테스트 | HTTP 상태코드, 에러 처리, rate limiting 테스트 없음 | ⬜ |
| R-14 | 부하 테스트 | 동시 주문/정산 부하 테스트 없음 | ⬜ |

### 🔴 2차 보안 감사 (2026-04-11 전체 스택 5개 영역 병렬 감사)

> 기존 1차 감사 이슈(C-1~L-9) 해결 후 추가 발견. 이미 수정된 항목은 ✅ 표시.

#### 🔴 CRITICAL

| # | 영역 | 이슈 | 상태 |
|---|------|------|------|
| S-C1 | Frontend/Relayer | ownerSecret 레거시 경로 제거 — UI는 이미 authorize 사용 중, 릴레이어 레거시 엔드포인트 비활성화 필요 | 🔧 `fix/SC1-SH6-remove-legacy-secrets` |

#### 🟠 HIGH

| # | 영역 | 이슈 | 상태 |
|---|------|------|------|
| S-H1 | Circuit | settle.circom claim token 검증 누락 | ✅ 이전 세션 수정 (커밋 feeec6d) |
| S-H2 | Circuit | withdraw.circom amount/withdrawAmount range check 없음 | ✅ 이미 수정됨 (`Num2Bits(128)` on amount + amount-withdrawAmount, withdraw.circom:125-133) |
| S-H3 | Frontend | note 직렬화 pubKeyAx/Ay — 이미 수정됨 확인 | ✅ 수정 완료 |
| S-H4 | Frontend | change note pubKey — 이미 수정됨 확인 | ✅ 수정 완료 |
| S-H5 | Frontend | CSP/COOP/COEP 헤더 | ✅ PR #187 (L-6) |
| S-H6 | Relayer | cross-relayer Trade Offer에서 secrets 평문 전송 (레거시 경로) | 🔧 `fix/SC1-SH6-remove-legacy-secrets` |
| S-H7 | Relayer | authorize orders Map 크기 제한 없음 → 메모리 DoS | ⬜ |

#### 🟡 MEDIUM

| # | 영역 | 이슈 | 상태 |
|---|------|------|------|
| S-M1 | Circuit | settle.circom LessThan(252)→LessThan(5) 최적화 | ✅ PR #179 (H-5) |
| S-M2 | Circuit | settle.circom expiry/timestamp range check 없음 | ⬜ |
| S-M3 | Circuit | authorize.circom expiry 회로 내 미검증 (컨트랙트 의존) | ⬜ |
| S-M4 | Circuit | cancel.circom balance range check 없음 | ⬜ |
| S-M5 | Contract | settleAuth zero-amount 방어 없음 | ⬜ |
| S-M6 | Contract | RelayerRegistry ReentrancyGuard 없음 | ⬜ |
| S-M7 | Contract | FeeVault.claim 플랫폼 수수료 프론트런 가능 | ⬜ |
| S-M8 | Relayer | Trade Offer body 유효성 검증 얕음 | ⬜ |
| S-M9 | Relayer | rate limiter IP 기반만 — multi-IP 우회 가능 | ⬜ |
| S-M10 | Relayer | admin API timing-safe 비교 | ✅ PR #177 (H-6) |
| S-M11 | Frontend | relayerUrl 검증 없이 fetch | ✅ PR #183 (M-9) |
| S-M12 | Frontend | Worker에서 secrets 제로화 안 됨 | ⬜ |
| S-M13 | Cross | totalLocked 128-bit (circuit) vs 96-bit (contract) 불일치 | ⬜ |
| S-M14 | Relayer | ScatterDirect를 authorize 경로로 마이그레이션 (현재 레거시 POST에서만 지원) | ⬜ |
| S-M15 | Relayer | authorize-orders에 shared orderbook 연동 (cross-relayer 가시성 없음) | ⬜ |
