# Security Issues Tracker

보안 감사에서 발견된 이슈 목록. 모든 이슈 해결 완료.

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
