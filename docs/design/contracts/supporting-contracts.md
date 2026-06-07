# 보조 컨트랙트 상세

## 1. FeeVault.sol

### 목적
릴레이어별/토큰별 수수료를 적립하고, 플랫폼 수수료 차감 후 릴레이어가 인출하게 한다. 플랫폼 수익(DEX 플랫폼 fee + positive slippage) 은 별도로 추적.

### 주요 상태
- `balances[relayer][token]` — 릴레이어별 토큰별 적립액
- `totalTracked[token]` — 전체 릴레이어 합(지급능력 검증용)
- `platformRevenue[token]` — 프로토콜 수익(분리 관리)
- `platformFeeBps` — 플랫폼 수수료 bps (0–5000)
- `pendingFeeBps`, `pendingFeeEffectiveTime` — 수수료 변경 1일 타임락
- `treasury`, `authorizedDepositors`

### 주요 함수
| 함수 | 호출자 | 설명 |
|------|--------|------|
| `deposit(relayer, token, amount)` | authorizedDepositors | 릴레이어 수수료 적립. `tokenBalance ≥ totalTracked + platformRevenue` 검증. |
| `depositPlatformRevenue(token, amount, source)` | authorizedDepositors | 플랫폼 수익 적립(source 는 `fee`/`surplus` 등 태깅). |
| `claim(token)` | 릴레이어 | 잔액 전액 인출 — `platformFeeBps` 만큼 treasury, 나머지 송신자에게 전송. |
| `withdrawPlatformRevenue(token)` | treasury / owner | 누적 플랫폼 수익을 treasury 로. |
| `scheduleFeeChange / applyFeeChange / cancelFeeChange` | owner | 1일 타임락으로 수수료 조정. |

### 불변식
1. **지급능력**: `token.balanceOf(vault) ≥ totalTracked + platformRevenue`
2. **1일 타임락**: 수수료 변경은 릴레이어가 구 요율로 인출할 시간을 확보.

---

## 2. RelayerRegistry.sol

### 목적
릴레이어 온체인 등록/본드/쿨다운 관리. 선택적 zk-X509 아이덴티티 게이트 연동.

### 주요 상태
- `minBond` — 최소 본드(0 이면 옵션)
- `bondToken` — 본드 토큰. `address(0)` = 네이티브(`msg.value`) 모드, 비-제로 = ERC20 모드(init 시 1회 고정)
- `relayers[address] → Relayer{url, name, fee(bps ≤ 500), bond, registeredAt, exitRequestedAt, active}`
- `relayerList[]` — 등록 이력(iteration 용, append-only)
- `treasury`, `identityRegistry`
- `kycApprovalRegistry` — 선택적 admin KYC 승인 게이트(`IssuanceApprovalRegistry`). `address(0)` = 비활성(feature-flag off)

### 주요 함수
| 함수 | 설명 |
|------|------|
| `register(url, name, fee, bondAmount)` | 본드 ≥ `minBond`, `fee ≤ 500bps`, **zk-X509 `isVerified` 통과**. `kycApprovalRegistry` 설정 시 **AND 게이트**로 `isApproved` 도 요구(미설정 시 zk-X509 단독). **결제 모드**: 네이티브(`bondToken==0`)면 본드는 `msg.value`, `bondAmount` 는 0; ERC20 모드면 `bondAmount` 를 `transferFrom`(사전 `approve` 필요), `msg.value` 는 0. 혼용 시 `WrongPaymentMode` revert. |
| `addBond(bondAmount) payable` | 본드 증액(`register` 와 동일 결제 모드 규칙). |
| `updateInfo(url, name, fee)` | 정보 갱신(exit 중이면 금지). |
| `requestExit()` | 자가 exit 대기 시작(7일). 즉시 활성 집합에서 숨김. |
| `executeExit()` | 쿨다운 후 본드 회수(`active=false`). 자가·강제 exit 공통 환급 경로. |
| `adminRemoveRelayer(relayer, reason)` (owner) | **관리자 강제 제거** — 대신 `exitRequestedAt` 설정(멱등)해 즉시 서비스에서 숨기고 쿨다운 시작. `active` 는 유지하여 본드가 묶이지 않음(쿨다운 후 릴레이어가 `executeExit` 로 회수). 이 콜에서 본드를 push 하지 않아 악의 릴레이어가 수신 거부로 자신의 강제 제거를 막는(griefing) 것이 불가. 슬래싱 아님. |
| `setKycApprovalRegistry(addr)` (owner) | KYC AND 게이트 설정/해제(`address(0)`). 신규 `register` 에만 적용. |
| `isActiveRelayer / getFee / getSettlementInfo` | PrivateSettlement 가 호출. `exitRequestedAt > 0` 이면 비활성으로 집계. |

### 라이프사이클
```
register ─▶ ACTIVE ─┬─ requestExit ──────────────┐
                    └─ adminRemoveRelayer(강제) ──┴─▶ EXITING(즉시 서비스 숨김) ─[7일]─▶ executeExit ─▶ 본드 회수
```
- **본드 회수 불변식**: 활성 집합에서 내리는 모든 경로(자가/강제)가 본드 전액을 회수 가능 상태로 유지. stranded 상태 부재.
- 강제 제거된 릴레이어는 `updateInfo`/`register`/`requestExit` 가 모두 revert 되어 되돌릴 수 없음.

### 특성
- **본드 슬래싱 미지원**(L-3): 실패 시 릴레이어 가스만 손실. (강제 제거도 전액 환급 — 슬래싱은 별도 메커니즘)
- **7일 쿨다운**: 자가·강제 exit 공통.
- **O(n) 활성 조회**(L-4): 대량 사용시 이벤트 인덱싱 권장.

---

## 3. IdentityGate.sol

여러 CA(zk-X509 registry) 중 **하나라도** 인증한 사용자를 통과시키는 OR 게이트. 최대 10개 registry. `IIdentityRegistry` 를 구현하므로 단일 registry 자리에 드롭인 가능(예: CommitmentPool `identityGate`, RelayerRegistry `identityRegistry`).

- `addRegistry / removeRegistry` (owner) — 1개 이상 유지.
- `isVerified(user)` — 등록된 CA 를 OR 집계. `try/catch` 로 reverting registry 는 skip. **개별 CA 가 paused 면 그 CA 는 `isVerified=false` 를 반환하므로 자동으로 빠지고, 다른 CA 로는 여전히 통과 가능.**
- `verifiedUntil(user)` — 모든 CA 중 **최대** 만료 시각.
- `paused()` — 어느 하나라도 paused 면 true(보수적 **표시**).

> **`paused()` vs `isVerified()` 의미 구분 (다운스트림 게이팅 주의)**
> - 실제 접근 차단은 **`isVerified()` 로** 하라. 이것이 paused CA 를 OR 집계에서 자동 제외하면서 살아있는 CA 로는 통과시키는 정확한 신호다.
> - `paused()` 는 "CA 중 하나라도 멈췄다"는 **운영 표시(informational)** 일 뿐, 게이트 전체를 막지 않는다. 한 CA 의 일시정지가 다른 CA 사용자의 검증을 막지 않기 때문(개별 CA pause → 해당 CA 만 isVerified=false). UI 경고 배지 등에 쓰고, 접근 결정에는 `isVerified()` 를 쓴다.

---

## 4. IssuanceApprovalRegistry.sol

관리자가 **"이 지갑은 Relayer-CA 인증서를 받을 자격이 있다(=KYC 통과)"** 는 오프체인 심사 결과를 온체인에 기록하는 레지스트리. RelayerRegistry 의 KYC AND 게이트(`kycApprovalRegistry`)와 operators 앱의 인증서 발급 CTA 게이팅에 사용된다. non-proxy + `Ownable2Step`.

> **의미 전환 (cert 발급 → KYC 신원)**: 구 설계의 "인증서 발급 승인"에서, 기록되는 `commonName(CN)/organization(O)/country(C)` 는 이제 **KYC 로 검증된 신원 값**(운영자 조직 이메일/기관명/ISO-3166 alpha-2 국가코드)을 의미한다. 인증서 키material 은 여기 저장되지 않으며(메타데이터만), 실제 보안 경계는 zk-X509 IdentityRegistry 의 온체인 어테스테이션이다 — 본 레지스트리는 그 상류의 "신원 승인" 신호.

- `approve(operator, commonName, organization, country, validityDays, expiresAt)` (owner) — 승인 기록(또는 철회분 재승인 시 덮어쓰기). `country` 는 2자, `validityDays` 1–3650.
- `revoke(operator, reason)` (owner) — 승인 철회(이력 보존: `revoked=true`). **신규 `register` 만 차단**하고, 이미 active 인 릴레이어는 영향 없음(집행은 `RelayerRegistry.adminRemoveRelayer`).
- `approvals(operator)` — 전체 레코드(철회 상태·이력 포함). `isApproved(wallet)` — 현재 승인+비철회+비만료 여부(주 게이트).
- **`expiresAt` 는 unix 초**, `0` = **무만료**(승인 직후 짧은 발급 윈도우에 정당). `expiresAt != 0` 이면 미래여야 함.

---

## 5. SanctionsList.sol

OFAC 스타일 단순 블록리스트. Chainalysis 오라클과 교체 가능한 인터페이스.

- `addSanction / removeSanction` — 단일.
- `addSanctionsBatch / removeSanctionsBatch` — 최대 200개, 중복·제로 주소 silent skip.

---

## 6. BatchExecutor.sol

**EIP-7702** 위임용 최소 ERC-7579 호환 배치 실행기.

- `msg.sender == address(this)` 만 허용(EOA 가 본 컨트랙트 바이트코드를 위임 실행하는 구조).
- 모드: `batch/default (mode[0]=0x01, mode[1]=0x00)` 만 지원.
- 용도: WETH deposit + approve + settle 을 한 번의 MetaMask 팝업으로 처리.

---

## 7. IncrementalMerkleTree.sol

Tornado 스타일 Poseidon append-only tree + 루트 링 버퍼.

- `levels` (1–20, immutable), `ROOT_HISTORY_SIZE` (immutable, 기본 30)
- `_insert(leaf)`: 경로 재계산 → 새 루트. 반환 leaf index.
- `isKnownRoot(root)`: 최근 N개 루트에 존재하는지.
- `_zeros(i)` — 미채워진 서브트리 기본 해시(`Poseidon(zeros[i-1], zeros[i-1])`).

---

## 8. SettleVerifyLib.sol

PrivateSettlement 의 EIP-170 (24KB 바이트코드) 초과를 피하기 위해 **외부 라이브러리로 분리**한 pure/view helpers.

주요 함수:
- `packSettleSignals(SettleParams)` → `uint[18]` (settle.circom 입력)
- `packAuthSignals(AuthorizeProof)` → `uint[15]` (authorize.circom 입력)
- `validateCrossSide(…)` — settleAuth 교차 불변식 집합(C1/C2/C4, fee 상한, expiry, 화이트리스트).
- `validateDexProof(…)` — settleWithDex 선검증(deadline, self-relayer, 토큰 호환).
- `validateScatterAuth(…)` — scatterDirectAuth 용.
- `validateTimestampWindow(currentTs, tol)` — `currentTs ≤ block.timestamp ≤ currentTs + tol`.
- `requireDistinctClaimsRoots(a, b, lockedA, lockedB)` — 동일 root 중복 방지(한쪽이 0 이면 예외 허용).
- `maybeInsertCommitment / registerClaimsGroup` — inlined helper(DELEGATECALL 오버헤드 방지).

---

## 9. Verifier 계열 (auto-generated)

| 인터페이스 | 공개 신호 수 | 사용처 |
|-----------|------|--------|
| `IDepositVerifier` | 3 = [commitment, token, amount] | CommitmentPool.deposit |
| `IVerifier` (withdraw) | 7 | CommitmentPool.withdraw |
| `ISettleVerifier` | 18 | PrivateSettlement.settlePrivate |
| `IAuthorizeVerifier` | 15 | settleAuth, settleWithDex, scatterDirectAuth |
| `IBatchAuthorizeVerifier` | 15+15 | settleAuth (선택) — 2개 증명을 5-페어링으로 압축 |
| `IClaimVerifier` | 6 = [claimsRoot, nullifier, amount, token, recipient, releaseTime] | claimWithProof |
| `ICancelVerifier` | 5 = [root, oldNullifier, oldNonceNullifier, newCommitment, submitter] | cancelPrivate |

모든 verifier 는 snarkJS 로 proving key 로부터 자동 생성된 Groth16 검증 컨트랙트이며 구조는 동일:
1. 각 공개 신호의 필드 멤버십 검사
2. `IC = IC0 + Σ pubSignals[i] · IC_i` 계산
3. 페어링 체크 `e(A,B) = e(α,β) · e(IC,γ) · e(C,δ)`

### BatchAuthorizeVerifier 최적화
두 authorize 증명을 Fiat-Shamir 랜덤 선형 결합으로 합쳐 **4+4=8 페어링 → 5 페어링**으로 축소, `settleAuth` 당 ~70–100K gas 절감(~24%).

---

## 10. 업그레이드 가능성

- **Immutable**: `IncrementalMerkleTree` 의 `levels` / `ROOT_HISTORY_SIZE`. (CommitmentPool 의 verifier 와 PrivateSettlement 의 `weth` 는 프록시 이전엔 immutable 이었으나 현재는 `initialize` 에서 1회 설정 후 불변인 상태 변수 — 재할당 없음.)
- **Ownable + 타임락**: `authorizedSettlement` 변경(24h), `platformFeeBps` 변경(1일).
- **Ownable 즉시 교체**: `authorizeVerifier`, `cancelVerifier`, `batchAuthorizeVerifier`, 화이트리스트, sanctions list.
- **소유권 이전**: 모두 `Ownable2Step` 로 실수로 인한 락아웃 방지.
