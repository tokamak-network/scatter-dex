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
- `relayers[address] → Relayer{url, fee(bps ≤ 500), bond, registeredAt, exitRequestedAt, active}`
- `relayerList[]` — 등록 이력(iteration 용, append-only)
- `treasury`, `identityRegistry`

### 주요 함수
| 함수 | 설명 |
|------|------|
| `register(url, fee)` | `msg.value ≥ minBond`, `fee ≤ 500bps`, IdentityGate 통과 필요. |
| `addBond() payable` | 본드 증액. |
| `updateInfo(url, fee)` | 정보 갱신(exit 중이면 금지). |
| `requestExit()` | exit 대기 시작(7일). |
| `executeExit()` | 쿨다운 후 본드 회수. |
| `isActiveRelayer / getFee / getSettlementInfo` | PrivateSettlement 가 호출. |

### 특성
- **본드 슬래싱 미지원**(L-3): 실패 시 릴레이어 가스만 손실.
- **7일 쿨다운**: `requestExit` → 7일 후 `executeExit`.
- **O(n) 활성 조회**(L-4): 대량 사용시 이벤트 인덱싱 권장.

---

## 3. IdentityGate.sol

여러 CA(zk-X509 registry) 중 **하나라도** 인증한 사용자를 통과시키는 OR 게이트. 최대 10개 registry.

- `addRegistry / removeRegistry` (owner) — 1개 이상 유지.
- `isVerified(user)` — `try/catch` 로 reverting registry 는 skip.
- `verifiedUntil(user)` — 모든 CA 중 **최대** 만료 시각.
- `paused()` — 어느 하나라도 paused 면 true(보수적 표시).

---

## 4. SanctionsList.sol

OFAC 스타일 단순 블록리스트. Chainalysis 오라클과 교체 가능한 인터페이스.

- `addSanction / removeSanction` — 단일.
- `addSanctionsBatch / removeSanctionsBatch` — 최대 200개, 중복·제로 주소 silent skip.

---

## 5. BatchExecutor.sol

**EIP-7702** 위임용 최소 ERC-7579 호환 배치 실행기.

- `msg.sender == address(this)` 만 허용(EOA 가 본 컨트랙트 바이트코드를 위임 실행하는 구조).
- 모드: `batch/default (mode[0]=0x01, mode[1]=0x00)` 만 지원.
- 용도: WETH deposit + approve + settle 을 한 번의 MetaMask 팝업으로 처리.

---

## 6. IncrementalMerkleTree.sol

Tornado 스타일 Poseidon append-only tree + 루트 링 버퍼.

- `levels` (1–20, immutable), `ROOT_HISTORY_SIZE` (immutable, 기본 30)
- `_insert(leaf)`: 경로 재계산 → 새 루트. 반환 leaf index.
- `isKnownRoot(root)`: 최근 N개 루트에 존재하는지.
- `_zeros(i)` — 미채워진 서브트리 기본 해시(`Poseidon(zeros[i-1], zeros[i-1])`).

---

## 7. SettleVerifyLib.sol

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

## 8. Verifier 계열 (auto-generated)

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

## 9. 업그레이드 가능성

- **Immutable**: CommitmentPool 의 verifier, tree, weth.
- **Ownable + 타임락**: `authorizedSettlement` 변경(24h), `platformFeeBps` 변경(1일).
- **Ownable 즉시 교체**: `authorizeVerifier`, `cancelVerifier`, `batchAuthorizeVerifier`, 화이트리스트, sanctions list.
- **소유권 이전**: 모두 `Ownable2Step` 로 실수로 인한 락아웃 방지.
