# Verified Privacy DEX — Development Document

> "인증된 사람만 쓸 수 있는, 자금 흐름 추적이 불가능한 DEX"
> zk-X509 (게이트키퍼) + 오프체인 오더북 + Scatter Settlement (프라이버시 엔진)

---

## 1. 초안 (Draft)

### 1.1 한 줄 요약

```
"금액이랑 가격만 넣으면 나머지는 다 알아서."
인증된 사용자만 참여하는, 자금 흐름이 추적 불가능한 지정가 오더북 DEX.
```

### 1.2 설계 원칙

```
Privacy-Compliance-Efficiency 트릴레마:
  기존 DEX는 셋 중 최대 둘만 달성:
    Uniswap:      효율 ✓  프라이버시 ✗  컴플라이언스 ✗
    Tornado Cash:  효율 ✓  프라이버시 ✓  컴플라이언스 ✗ → 제재
    Railgun:       효율 ✗  프라이버시 ✓  컴플라이언스 ✗
    본 설계:       효율 ✓  프라이버시 ✓  컴플라이언스 ✓

분리 원칙 (Execution-Settlement Separation):
  거래(Execution)와 정산(Settlement)을 분리하면 트릴레마 해결:
    거래 실행: 투명해도 됨 → 오프체인 (효율)
    정산:      추적 불가해야 함 → Scatter Settlement (프라이버시)
    신원:      인증 필요 → zk-X509 (컴플라이언스)

  "ZK로 다 숨기자"가 아니라 "뭘 숨겨야 하는지 파악하고 최소한만 숨기자"
```

### 1.3 핵심 아이디어

```
거래는 보여도 된다. 돈이 어디로 갔는지만 숨긴다.

Alice가 10 ETH를 에스크로에 넣었다         → 알 수 있음
Alice가 받은 21000 USDC가 어디로 갔는지    → 모름
  → 3시간 후 주소C에 7000 USDC
  → 6시간 후 주소D에 8000 USDC
  → 9시간 후 주소E에 6000 USDC
  → 이 주소들이 Alice 것인지 증명 불가

프라이버시가 깨지지 않는 이유 (7개 차원):
  ① 토큰이 다름:  ETH 넣고 → USDC 나감
  ② 금액이 다름:  10 ETH 넣고 → 7000 + 8000 + 6000 USDC로 나감
  ③ 주소가 다름:  Alice 주소로 넣고 → 아무 주소에서 claim
  ④ 시간이 다름:  지금 넣고 → 3, 6, 9시간 후 claim
  ⑤ 여러 거래 섞임: 컨트랙트에 여러 사람의 자산이 동시에 있음
  ⑥ 받는 주소 사전 노출 없음: claimHash만 저장, claim 시점에야 주소 드러남
  ⑦ 수취 동의 필수: 비밀번호 없이는 claim 불가 (수취자 보호)
```

### 1.4 유저 경험

```
최초 1회:
  지갑 연결 → zk-X509 인증서 등록 → 끝

매 거래:
  1. 에스크로에 자산 입금 (전액)       ← "주기만 함"
  2. 주문 서명 → 릴레이어에 전달       ← 오프체인, 가스비 0
  3. 끝. 나머지는 자동.               ← "받는 건 알아서"

유저가 설정하는 것:
  ├─ 얼마를 (금액)
  ├─ 얼마에 (가격)
  ├─ 받을 주소 (1개~N개, 자유롭게 추가)
  ├─ 주소별 금액 (분할 비율)
  ├─ 주소별 시간차 (언제 받을지)
  └─ 주소별 비밀번호 (수취자마다 다르게 설정)

유저가 선택하는 것 (추가):
  └─ 릴레이어 (1개~N개, 내가 원하는 곳에만 주문 전달)

유저가 신경 안 쓰는 것 (자동):
  ├─ 매칭 (릴레이어가 오프체인에서)
  ├─ 정산 등록 (릴레이어가 settle 호출)
  └─ 가스비 (릴레이어 대납)

수취자가 하는 것:
  └─ 비밀번호로 claim (시간 되면 직접 수령)
```

### 1.5 구성요소 (역할 명확화)

```
┌──────────────────────────────────────────────────────────┐
│                  Verified Privacy DEX                      │
│                                                            │
│  zk-X509           오프체인 오더북       Scatter            │
│  ──────            ──────────────       Settlement         │
│                                         ──────────         │
│  역할:             역할:                역할:              │
│  게이트키퍼         거래 매칭             프라이버시 엔진    │
│                                                            │
│  "인증된 주소만     "오프체인 서명 기반   "자금 흐름         │
│   들어와"           지정가 매칭"          난독화"           │
│                                                            │
│  컴플라이언스       기능                  독창성            │
│                                                            │
│  zk-X509는 "이 주소가 인증된 주소다"만 증명                  │
│  주문자 신원을 숨기는 것이 아님                               │
└──────────────────────────────────────────────────────────┘
```

---

## 2. 분석 (Analysis)

### 2.1 DEX 아키텍처 진화

```
세대    대표            아키텍처                  한계
──────────────────────────────────────────────────────────────
Gen 1   EtherDelta      온체인 오더북             가스비 폭발
Gen 2   Uniswap         온체인 AMM               MEV, 프라이버시 없음
Gen 3   0x, CoW         오프체인 주문 + 온체인 정산  프라이버시 없음
Gen 4   Renegade, Railgun  ZK/MPC 기반 프라이버시   비쌈, 복잡, 컴플라이언스 없음
Gen 5   본 설계 (ScatterDEX)  분리 원칙 + Scatter Settlement  ←
```

### 2.2 기존 시스템과의 차이

```
                    Uniswap    0x/CoW     Renegade   Railgun    본 설계
───────────────────────────────────────────────────────────────────────
오더북 방식         AMM        오프체인    다크풀     ✗          오프체인
주문 프라이버시     ✗          ✗          ✓          ✓          △ (오프체인)
정산 프라이버시     ✗          ✗          ✗          ✓          ✓ (scatter)
MEV 방지           ✗          △          ✓          △          ✓
인증/컴플라이언스   ✗          ✗          ✗          ✗          ✓ (zk-X509)
시간차 분산 정산    ✗          ✗          ✗          ✗          ✓
규제 친화적         ✗          ✗          ✗          ✗          ✓
가스비 (1거래)     ~150K      ~100K      ~500K+     ~300K+     ~410K (예상)
ZK 회로 필요       ✗          ✗          ✗ (MPC)    ✓ (다수)   ✗
```

### 2.3 프라이버시 모델 비교

```
기존 프라이버시 DEX (Railgun, Renegade):
  "거래 자체를 숨긴다" → ZK로 전부 감춤 → 복잡, 비쌈

본 설계:
  "거래는 보여도 된다. 돈이 어디로 갔는지만 숨긴다"
  → 오프체인에서 주문/매칭 (온체인에 주문 안 올림)
  → 온체인에는 입금과 분산 출금만 보임
  → 입출금 연결 불가 = 프라이버시

토네이도캐시와의 차이:
  토네이도: "넣고 빼기"가 목적이 뻔함 → 규제 타겟
  본 설계:  "거래"라는 정당한 이유로 자금 유입 → "정산"으로 자금 유출
           + 인증된 사용자만 참여 → 규제 친화적
```

### 2.4 MEV 분석

```
지정가 오더북에서 MEV가 거의 없는 이유:

AMM (Uniswap):
  큰 매수 주문 → 가격이 올라감 → 샌드위치 가능
  = 주문이 가격을 움직임 → MEV 발생

지정가 오더북 (본 설계):
  큰 매수 주문 → 가격 안 움직임 → 샌드위치 불가
  = 주문이 가격을 안 움직임 → MEV 무의미

프론트런?
  "매도보다 먼저 2099에 매도" = 봇이 더 싼 가격에 파는 것 = 봇 손해

다른 DEX에서 차익?
  이 오더북의 지정가 주문이 다른 DEX 가격에 영향 없음
  = 정보 자체에 차익 기회 없음

추가 방어:
  - 주문이 온체인에 안 올라감 (오프체인 서명)
  - 릴레이어만 주문 내용을 봄
  - 릴레이어는 자금 접근 불가 + 유저 서명 없이 체결 불가
```

### 2.5 기술 스택 분석

```
이미 있는 것 (재사용):
  ├─ zk-X509 (/Users/zena/tokamak-projects/zk-X509)
  │   ├─ SP1 zkVM guest program
  │   ├─ IdentityRegistry.sol
  │   ├─ X.509 파싱, 체인 검증, CRL 확인
  │   └─ 선택적 공개 (disclosure_mask)
  │
  └─ EIP-712 서명 기반 오프체인 주문 패턴
      └─ 0x, CoW Protocol, 1inch 등에서 검증된 패턴

만들어야 하는 것:
  ├─ ScatterSettlement.sol (핵심)
  ├─ IdentityGate.sol (zk-X509 래핑)
  ├─ 릴레이어/매칭 서비스
  └─ 프론트엔드 (Web UI)

선행 사례 (오프체인 오더북 + 온체인 정산):
  ├─ 0x Protocol: EIP-712 서명 → Relayer → 온체인 settlement
  ├─ CoW Protocol: 오프체인 intent → Solver 경쟁 → 배치 정산
  ├─ 1inch Fusion: 오프체인 서명 → Resolver → 온체인 정산
  └─ dYdX v3: 오프체인 매칭 → StarkEx 정산
```

### 2.6 기술적 리스크

```
리스크 1: 릴레이어 신뢰
  → 릴레이어가 주문 내용을 봄
  → 완화: 유저 서명 없이 체결 불가 (프론트런 방지)
  → 완화: 릴레이어는 자금 접근 불가 (컨트랙트가 관리)
  → 완화: 복수 릴레이어 선택 가능 (유저가 직접 선택)

리스크 5: 릴레이어 미작동 (다운, 거부, 지연)
  → 자금 안전: withdraw()로 미사용 에스크로 즉시 인출
  → 서비스 복구: 유저가 다른 릴레이어에 같은 주문 전달
    - 주문 서명은 특정 릴레이어에 바인딩되지 않음
    - 유저가 선택한 릴레이어에게만 비공개 전달
    - 주문이 공개되지 않음 (프라이버시 유지)
  → settle 후 미수령: claimExpiry 경과 후 refundUnclaimed()으로 회수

리스크 2: 유동성 부트스트랩
  → 초기에 상대방이 없으면 매칭 안 됨
  → 완화: 마켓 메이커 인센티브, 초기 유동성 제공

리스크 3: 가스비
  → ScatterSettlement 다중 전송 시 가스 소모
  → 완화: L2 배포 (Arbitrum/Base)

리스크 4: EIP-7702 지원
  → 아직 모든 지갑이 지원하지 않을 수 있음
  → 완화: fallback으로 일반 컨트랙트 호출 지원
```

### 2.7 보안 분석

```
위협 1: 입출금 상관관계 분석
  → 방어: 7개 차원 분리 (토큰, 금액, 주소, 시간, 거래 혼합, 주소 사전 비노출, 수취 동의)

위협 2: 릴레이어 악용 (프론트런, 정보 유출)
  → 방어: 유저 서명 필수, 자금 접근 불가
  → 방어: 릴레이어 교체 가능 (경쟁 구조)

위협 3: 비인증 사용자 접근
  → 방어: zk-X509 인증 필수 (컨트랙트 레벨 강제)

위협 4: 에스크로 자금 탈취
  → 방어: 유저 서명 검증 + 타임아웃 환불

위협 5: 수취자가 claim 안 함 (자금 묶임)
  → 방어: refund 타임아웃 (expiry 초과 시 보내는 사람에게 환불)
  → 방어: 보내는 사람이 수취자에게 재연락
```

---

## 3. 설계안 (Design)

### 3.1 아키텍처 개요

```
┌─────────────────────────────────────────────────────────────┐
│ 오프체인                                                     │
│                                                              │
│  ┌──────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │ 유저     │────→│ 릴레이어     │────→│ 매칭 엔진    │    │
│  │          │     │              │     │              │    │
│  │ EIP-712  │     │ 주문 수집    │     │ 가격/수량    │    │
│  │ 서명     │     │ 매칭 전달    │     │ 호환 매칭    │    │
│  └──────────┘     └──────────────┘     └──────┬───────┘    │
│                                                │             │
└────────────────────────────────────────────────┼─────────────┘
                                                 │ 매칭 결과
┌────────────────────────────────────────────────┼─────────────┐
│ 온체인 (L2)                                     │             │
│                                                 ▼             │
│  ┌─────────────────┐      ┌─────────────────────────────┐   │
│  │ IdentityGate    │      │ ScatterSettlement            │   │
│  │                 │      │                              │   │
│  │ - zk-X509 검증  │─────→│ - deposit (자산 입금/락)     │   │
│  │ - 인증 여부 확인│      │ - settle (서명 검증 + 매칭)  │   │
│  └─────────────────┘      │ - claimRelease (수취자 claim)│   │
│                           │ - refund (타임아웃 환불)     │   │
│                           └─────────────────────────────┘   │
│                                                              │
│  온체인 컨트랙트: 2개만. OrderBook/MatchingEngine 없음.       │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 멀티 릴레이어 모델

```
부동산에 집을 내놓는 것과 같은 구조:

  자산 = 온체인 에스크로에 잠김 (등기소)
  주문 = 내가 선택한 릴레이어에만 전달 (부동산 중개소)
  매칭 = 어느 릴레이어에서든 성사 가능
  정산 = settle 되면 nonce 소진 → 나머지 릴레이어의 같은 주문 자동 무효

흐름:
  Alice → 릴레이어 A에 주문 전달 (비공개)
  Alice → 릴레이어 B에 같은 주문 전달 (비공개)
  Alice → 릴레이어 C에는 안 보냄 (선택)

  릴레이어 A에서 매칭 → settle() → 성공
  릴레이어 B에서 매칭 시도 → settle() → nonce 이미 소진 → 실패 (정상)

특성:
  - 주문은 공개되지 않음 (내가 선택한 릴레이어만 봄)
  - 여러 릴레이어에 동시 전달 가능 (매칭 확률 ↑)
  - 릴레이어 장애 시 자연스럽게 다른 곳에서 체결
  - settle()은 permissionless지만 주문 데이터가 있어야 호출 가능
  - 릴레이어 간 경쟁 → 수수료/서비스 품질 경쟁

릴레이어 선택 기준 (프론트엔드 제공):
  ├─ 수수료율
  ├─ 유동성 (주문량)
  ├─ 응답 속도
  └─ 프라이버시 정책 (주문 데이터 보관/삭제 방침)

릴레이어 운영:
  - 누구나 운영 가능 (permissionless, 허가 불필요)
  - 컨트랙트는 릴레이어가 누군지 모름 (유효한 서명만 검증)
  - 수수료는 릴레이어가 자유롭게 설정
  - 현실적으로 유동성(주문량) 많은 곳에 유저가 몰림
  - 부동산 중개소와 같은 경쟁 구조

수수료 구조:
  - 유저가 주문 서명 시 maxFee 포함 (허용 수수료 상한)
  - settle() 시 릴레이어가 maxFee 이내에서 수수료 차감
  - 수수료는 settle 호출자(릴레이어)에게 지급
  - 유저 동의(서명) 없이 과도한 수수료 차감 불가
  - 릴레이어 간 수수료 경쟁 → 시장 원리로 적정 수수료 형성
```

### 3.3 컨트랙트 상세

#### IdentityGate.sol

```solidity
// zk-X509 인증 게이트
// 기존 IdentityRegistry.sol을 래핑하여 DEX 접근 제어

기능:
  - isVerified(address) → bool
  - ScatterSettlement이 deposit 시 호출
  - zk-X509 IdentityRegistry와 연동
  - 인증 만료 자동 체크 (verifiedUntil)
```

#### ScatterSettlement.sol (핵심 컨트랙트)

```solidity
// 에스크로 + 시간차 분산 정산
// 이 프로젝트의 모든 온체인 로직이 여기 집중

기능:

  - deposit(token, amount)
    → IdentityGate.isVerified(msg.sender) 확인
    → 에스크로에 자산 입금 (전액)
    → 유저는 "주기만 함"

  - settle(
      makerSig,       // 메이커 EIP-712 서명
      takerSig,       // 테이커 EIP-712 서명
      makerOrder,     // 메이커 주문 데이터
      takerOrder,     // 테이커 주문 데이터
      actualFee       // 실제 적용 수수료 (basis points)
    )
    → 양쪽 EIP-712 서명 검증 (ecrecover)
    → nonce 미사용 확인 → 사용 처리 (중복 settle 방지, 멀티 릴레이어 안전)
    → 가격 호환: makerOrder.buyAmount/sellAmount ≤ takerOrder.sellAmount/buyAmount
    → 수수료: actualFee ≤ makerOrder.maxFee && actualFee ≤ takerOrder.maxFee
    → 에스크로 잔액 확인:
      deposits[maker][sellToken] ≥ makerOrder.sellAmount
      deposits[taker][sellToken] ≥ takerOrder.sellAmount
    → 에스크로 차감:
      deposits[maker][sellToken] -= makerOrder.sellAmount
      deposits[taker][sellToken] -= takerOrder.sellAmount
    → 수수료 지급: msg.sender(릴레이어)에게 수수료 전송
    → 클레임 스케줄 등록:
      makerOrder.claims[] → 각각 ClaimSchedule 생성
        {claimHash, token: takerOrder.sellToken, amount, releaseTime, claimExpiry, claimed: false}
      takerOrder.claims[] → 각각 ClaimSchedule 생성
        {claimHash, token: makerOrder.sellToken, amount, releaseTime, claimExpiry, claimed: false}
      claimExpiry = releaseTime + REFUND_WINDOW (예: 7일)
    → 누구나 호출 가능 (permissionless) 하지만,
      주문 데이터+서명을 가진 릴레이어만 실질적으로 호출 가능
    → 릴레이어가 가스비 대납
    → emit Settled(matchId, scheduleIds[])

  - claimRelease(scheduleId, secret)
    → releaseTime 이후
    → hash(secret, msg.sender) == schedule.claimHash 확인
    → msg.sender에게 자산 전송
    → 수취자가 직접 호출
    → 받는 주소는 claim 전까지 온체인에 없음 (claimHash만 존재)

  - withdraw(token, amount)
    → 에스크로 잔액 중 미사용분 인출
    → settle로 잠긴 금액은 인출 불가
    → 유저가 언제든 자유롭게 호출 가능

  - refundUnclaimed(scheduleId)
    → settle 후 claimExpiry 초과한 미수령 스케줄의 자금 회수
    → 원래 주문자(depositor)에게 반환
    → 수취자가 claim 안 하면 → 주문자가 돌려받음

자금 회수 시나리오 정리:

  상황 1: 입금 후 거래 안 함 (릴레이어 안 함, 매칭 안 됨)
    → withdraw(token, amount) 호출
    → 에스크로에서 즉시 인출
    → 아무 조건 없음, 내 돈이니까

  상황 2: settle 됐는데 수취자가 claim 안 함
    → claimExpiry (예: settle 후 7일) 경과
    → refundUnclaimed(scheduleId) 호출
    → 해당 스케줄 금액이 원래 주문자 에스크로로 복귀
    → 복귀 후 withdraw로 인출 가능

  상황 3: settle 됐고 수취자가 일부만 claim 함
    → claim된 건 완료, 안 된 건 claimExpiry 후 refundUnclaimed
    → 부분 회수 가능

  핵심 원칙:
    - 내 돈은 항상 내가 회수할 수 있다
    - settle 전: withdraw로 즉시
    - settle 후: claimExpiry 대기 후 refundUnclaimed
    - 릴레이어/수취자가 뭘 하든 자금은 안전

상수:
  - REFUND_WINDOW = 7 days            // claim 만료까지 여유 시간
  - MAX_CLAIMS_PER_ORDER = 10         // 주문당 최대 수취자 수
  - FEE_DENOMINATOR = 10000           // basis points (30 = 0.3%)

저장 구조:
  - deposits: mapping(address => mapping(address => uint256))
              // depositor => token => amount (미사용 에스크로 잔액)

  - schedules: mapping(uint256 => ClaimSchedule)
              // scheduleId => {claimHash, token, amount, releaseTime, claimExpiry, claimed, depositor}
              // claimHash = keccak256(abi.encodePacked(secret, recipientAddress))
              // recipient 주소도, secret도 온체인에 없음!

  - nonces: mapping(address => uint256)
              // 서명 재사용 방지 (settle 시 소진)

  - scheduleCount: uint256
              // 스케줄 ID 자동 증가

  struct ClaimSchedule {
      bytes32 claimHash;
      address token;
      uint256 amount;
      uint256 releaseTime;     // 이 시간 이후 claim 가능
      uint256 claimExpiry;     // 이 시간 이후 refund 가능
      bool claimed;
      address depositor;       // refund 시 돌려줄 주소
  }

수취 방식:
  - claimHash = hash(secret, recipientAddress) 만 온체인에 저장
  - 비밀번호도, 받는 주소도 온체인에 노출되지 않음
  - claim 시: 컨트랙트가 hash(secret, msg.sender) == claimHash 검증
  - 보내는 사람이 오프체인으로 비밀번호 전달 (카톡, 이메일 등)
  - 비밀번호는 수취자마다 다르게 설정 (주문자가 주문 시 각 수취자별로 직접 입력)
  - 비밀번호 역할 = 수취 동의 + 수취자 신원 보호
```

### 3.3 오프체인 주문 구조 (EIP-712)

```
EIP-712 서명 주문 (온체인에 올라가지 않음):

Order {
  address maker;         // 주문자 주소
  address sellToken;     // 매도 토큰
  address buyToken;      // 매수 토큰
  uint256 sellAmount;    // 매도 수량
  uint256 buyAmount;     // 매수 수량 (= 가격 결정)
  uint256 maxFee;        // 허용 최대 수수료 (basis points, 예: 30 = 0.3%)
  uint256 expiry;        // 주문 만료 시간
  uint256 nonce;         // 재사용 방지
  Claim[] claims;        // 수령 정보 (claimHash, 금액, 시간차)
}

Claim {
  bytes32 claimHash;     // hash(secret, recipientAddress)
                         // 비밀번호도 주소도 온체인에 없음
  uint256 amount;        // 받을 금액
  uint256 releaseDelay;  // 매칭 후 N초 뒤 클레임 가능
}

유저가 이 구조체에 서명 → 릴레이어에 전달 → 온체인에는 안 올라감
릴레이어가 매칭 후 settle() 호출 시 이 데이터 + 서명을 제출

비밀번호 전달:
  보내는 사람이 각 수취자에게 오프체인으로 secret 전달
  (카톡, 이메일, 대면 등 — 온체인 기록 없음)
  수취자는 secret으로 지정된 지갑에서 claimRelease() 호출
```

### 3.4 데이터 흐름

```
1. 인증 (최초 1회)
   유저 → zk-X509 proof 생성 → IdentityGate 등록 (온체인 tx)

2. 입금
   유저 → ScatterSettlement.deposit(ETH, 10) (온체인 tx)
   → 에스크로에 10 ETH 잠김
   → 온체인에 보이는 것: "Alice가 에스크로에 10 ETH 넣었다"

3. 주문 (오프체인)
   유저 → EIP-712 서명:
     {sell: 10 ETH, buy: 21000 USDC, price: 2100,
      claims: [
        {claimHash: hash(secret1, 0xC), amount: 7000, delay: 3h},
        {claimHash: hash(secret2, 0xD), amount: 8000, delay: 6h},
        {claimHash: hash(secret3, 0xE), amount: 6000, delay: 9h}
      ]}
   → 릴레이어에 전달 (가스비 0, 온체인 기록 없음)
   → 주소도 비밀번호도 온체인에 올라가지 않음 (claimHash만)

4. 매칭 (오프체인)
   릴레이어:
     ├─ Alice: 10 ETH 매도 @ 2100
     ├─ Bob:   10 ETH 매수 @ 2100
     └─ 가격/수량 호환 → 매칭!

5. 정산 (온체인)
   릴레이어 → ScatterSettlement.settle(aliceSig, bobSig, ...)
     ├─ 서명 검증 ✓
     ├─ 가격/수량 호환 확인 ✓
     ├─ Alice 에스크로에서 10 ETH 차감
     ├─ Bob 에스크로에서 21000 USDC 차감
     ├─ 클레임 스케줄 등록 (받는 주소 없음, secretHash만):
     │    t+3h 이후 claim 가능: 7000 USDC (secretHash_1)
     │    t+6h 이후 claim 가능: 8000 USDC (secretHash_2)
     │    t+9h 이후 claim 가능: 6000 USDC (secretHash_3)
     │    t+4h 이후 claim 가능: 10 ETH   (secretHash_4)
     └─ 릴레이어에 매칭 수수료

6. 비밀번호 전달 (오프체인, settle tx 확인 후)
   settle tx 컨펌 → 프론트엔드가 Alice에게 알림:
   "거래 체결 완료. 수취자에게 비밀번호를 전달하세요."
   Alice → 수취자에게 비밀번호 전달 (카톡, 이메일 등)
   ※ 거래가 확정된 후에야 알려줌 (미체결 상태에서 알려주지 않음)

7. 수취자 클레임 (온체인, 수취자가 직접)
   수취자C → claimRelease(scheduleId, secret)
   → 시간 조건 ✓ + hash(secret, msg.sender) == claimHash ✓ → 자산 전송
   → 이 시점에야 수취자 주소가 온체인에 드러남

8. 완료
   수취자에게 알림: "수령 완료."
```

### 3.5 온체인에 보이는 것 vs 안 보이는 것

```
온체인에 보이는 것:
  ├─ Alice가 에스크로에 10 ETH 입금했다
  ├─ Bob이 에스크로에 21000 USDC 입금했다
  ├─ 에스크로에서 정산이 실행되었다 (secretHash만 등록)
  ├─ 3시간 후 "누군가"가 7000 USDC를 claim했다
  ├─ 6시간 후 "누군가"가 8000 USDC를 claim했다
  ├─ 9시간 후 "누군가"가 6000 USDC를 claim했다
  └─ 4시간 후 "누군가"가 10 ETH를 claim했다

온체인에 안 보이는 것:
  ├─ 주문 내용 (가격, 수량, 매도/매수)
  ├─ 누구와 누구의 거래인지 (Alice↔Bob 연결)
  ├─ claim한 사람이 누구의 수취자인지
  ├─ 입금과 출금의 연결 관계
  └─ 받는 주소 (claim 전까지 온체인에 없음!)

연결이 끊어지는 이유:
  ① 토큰이 다름:  ETH 넣고 → USDC 나감
  ② 금액이 다름:  10 ETH 넣고 → 7000+8000+6000 USDC로 나감
  ③ 주소가 다름:  Alice 주소 넣고 → 아무 주소에서 claim
  ④ 시간이 다름:  지금 넣고 → 3, 6, 9시간 후 claim
  ⑤ 여러 거래 섞임: 컨트랙트에 다수 유저의 자산이 동시에 있음
  ⑥ 받는 주소 사전 노출 없음: claimHash만 저장, claim 시점에야 주소 드러남
  ⑦ 수취 동의 필수: 비밀번호 없이는 claim 불가 (수취자 보호)
```

### 3.6 프론트엔드 UX

```
화면 1: 인증 (최초 1회)
  ┌────────────────────────────────────┐
  │ 인증서 등록                        │
  │                                    │
  │ [인증서 파일 선택]                  │
  │ [비밀번호 입력]                     │
  │ [등록하기] ← 클릭하면 proof 생성    │
  │                                    │
  │ ✓ 인증 완료                        │
  └────────────────────────────────────┘

화면 2: 입금
  ┌────────────────────────────────────┐
  │ 에스크로 입금                       │
  │                                    │
  │ 토큰 [ETH ▼]  금액 [10        ]   │
  │ [입금하기]                          │
  │                                    │
  │ 내 에스크로 잔액:                   │
  │   ETH:  10.0                       │
  │   USDC: 0.0                        │
  └────────────────────────────────────┘

화면 3: 거래 (매번)
  ┌────────────────────────────────────────┐
  │ 주문                                   │
  │                                        │
  │ 매도 [10    ] [ETH  ▼]                │
  │ 가격 [2100  ] USDC per ETH             │
  │                                        │
  │ 받을 곳:                               │
  │ ┌────────────────────────────────────┐ │
  │ │ 주소: [0xC1a2...  ] 금액: [7000 ] │ │
  │ │ 시간: [3시간 후 ▼]                  │ │
  │ │ 비밀번호: [********          ]     │ │
  │ ├────────────────────────────────────┤ │
  │ │ 주소: [0xD3b4...  ] 금액: [8000 ] │ │
  │ │ 시간: [6시간 후 ▼]                  │ │
  │ │ 비밀번호: [********          ]     │ │
  │ ├────────────────────────────────────┤ │
  │ │ 주소: [0xE5c6...  ] 금액: [6000 ] │ │
  │ │ 시간: [9시간 후 ▼]                  │ │
  │ │ 비밀번호: [********          ]     │ │
  │ └────────────────────────────────────┘ │
  │ [+ 주소 추가]                          │
  │                                        │
  │ [서명 & 주문 제출]  ← 가스비 없음       │
  └────────────────────────────────────────┘

화면 4: 주문 현황
  ┌────────────────────────────────────┐
  │ 내 주문                            │
  │                                    │
  │ #1 매도 10 ETH @ 2100  ⏳ 매칭 대기│
  │ #2 매수 5 ETH @ 2050   ✓ 정산 중  │
  │    └─ 수령 1/3 완료 (4시간 후 다음) │
  └────────────────────────────────────┘
```

---

## 4. 개발 계획 (Development Plan)

### 4.1 기술 스택

```
블록체인:      Ethereum L2 (Arbitrum 또는 Base)
컨트랙트:      Solidity (Foundry)
서명:          EIP-712 Typed Data Signing
zk-X509:       기존 구현 재사용 (SP1 zkVM)
프론트엔드:    Next.js + wagmi + viem
릴레이어:      TypeScript (Node.js + Express + ethers.js v6)
테스트넷:      Arbitrum Sepolia 또는 Base Sepolia
```

### 4.2 개발 단계

#### Phase 1: ScatterSettlement 코어 ✅ 완료

```
상태: PR #1 머지됨

구현 완료:
  ├─ ScatterSettlement.sol (deposit, withdraw, settle, claimRelease, refundUnclaimed)
  ├─ cancelOrder() — 주문 선제 취소
  ├─ EIP-712 서명 구조 (Order + ClaimInfo)
  ├─ 구조체 패킹 최적화 (ClaimSchedule 6슬롯→3슬롯, settle 가스 40% 절감)
  ├─ Custom errors (가스 절감)
  ├─ Safe cast (uint96/uint48 overflow 검증)
  ├─ Self-trade 방지
  └─ 테스트 31개 (단위 + e2e + 보안)

가스비 실측:
  deposit: ~93K | settle(3+1 claims): ~408K | claim: ~70K | refund: ~56K
```

#### Phase 2: zk-X509 연동 ✅ 완료

```
상태: PR #2 머지됨

구현 완료:
  ├─ IdentityGate.sol (isVerified, verifiedUntil 래핑)
  ├─ IIdentityRegistry 확장 (verifiedUntil, paused)
  ├─ 배포 스크립트 (DeploySettlement.s.sol)
  └─ 테스트 14개 (인증 만료 라이프사이클 e2e 포함)
```

#### Phase 3: EIP-7702 스킬 ✅ 완료

```
상태: PR #3 제출됨

구현 완료:
  ├─ VaultSkills.sol (EIP-7702 위임 대상)
  │   ├─ approveAndDeposit — approve + deposit 1tx
  │   ├─ approveAndDepositMultiple — 다중 토큰 배치
  │   ├─ withdrawMultiple — 다중 토큰 일괄 인출
  │   └─ approve 잔여 허용량 자동 제거 (보안)
  ├─ SkillRegistry 생략 (불필요)
  └─ 테스트 8개 (vm.etch로 EIP-7702 위임 시뮬레이션)
```

#### Phase 4: 릴레이어 레지스트리 + 플랫폼 수수료 ✅ 완료

```
상태: 커밋 완료, PR 미제출

구현 완료:
  ├─ RelayerRegistry.sol
  │   ├─ register(url, fee) + 보증금 예치 (최소 0.1 ETH)
  │   ├─ requestExit() + executeExit() (7일 대기 후 보증금 반환)
  │   ├─ updateInfo(url, fee) — 릴레이어 정보 변경
  │   ├─ addBond() — 보증금 추가
  │   ├─ isActiveRelayer() — 활성 릴레이어 확인
  │   ├─ getActiveRelayers() — 활성 릴레이어 목록
  │   └─ treasury 관리 (owner)
  ├─ ScatterSettlement 수정
  │   ├─ 등록된 릴레이어만 settle() 호출 가능
  │   └─ 수수료 분리: 릴레이어 몫 + 프로토콜 몫 (treasury)
  └─ 배포 스크립트 업데이트 (RelayerRegistry + protocolFeeBps)

미완료:
  └─ RelayerRegistry 테스트 + 프로토콜 수수료 테스트
```

#### Phase 5: 릴레이어 서버 (TypeScript) ✅ 완료 (admin API, Dockerfile 미구현)

```
목표: 오프체인 매칭 엔진 + settle() 호출 서버

작업:
  ├─ 주문 수집 API (POST /api/orders — 서명된 주문 수신)
  ├─ 주문 상태 조회 API (GET /api/orders/:address)
  ├─ 주문 취소 API (DELETE /api/orders/:address/:nonce)
  ├─ 오더북 조회 API (GET /api/orderbook/:pair)
  ├─ 릴레이어 정보 API (GET /api/info — 이름, 수수료, 주문수)
  ├─ 오더북 자료구조 (토큰 페어별 매도/매수 정렬)
  ├─ 매칭 엔진 (가격/수량 호환 탐색)
  ├─ EIP-712 서명 검증
  ├─ settle() 트랜잭션 제출 (가스비 대납)
  ├─ 관리자 API
  │   ├─ GET /api/admin/status — 서버 상태 (업타임, 메모리, 체인 연결)
  │   ├─ GET /api/admin/stats — 통계 (주문 건수, 체결 건수, 누적 수수료)
  │   ├─ GET /api/admin/balance — 릴레이어 지갑 잔액
  │   └─ GET /api/admin/settlements — settle 이력 (tx hash, 성공/실패)
  ├─ Docker 배포 지원 (Dockerfile)
  └─ 테스트

기술 스택: Express + ethers.js v6 + vitest

결과물: 독립 실행 가능한 릴레이어 서버 + 관리자 API
```

#### Phase 6: 프론트엔드 (플랫폼 UI) ⬜ 진행 예정

```
목표: ScatterDEX 플랫폼 웹 UI

작업:
  ├─ Next.js 프로젝트 셋업 (wagmi + viem)
  ├─ 지갑 연결
  ├─ zk-X509 인증 화면
  │   └─ 지원 인증서(CA) 정보 표시 (IdentityRegistry에서 조회)
  ├─ 에스크로 입금/출금 화면
  ├─ 릴레이어 목록 화면
  │   ├─ RelayerRegistry 온체인 조회 (URL, 수수료, 보증금)
  │   └─ 릴레이어 선택
  ├─ 거래 화면
  │   ├─ 주문 입력 (토큰, 금액, 가격, 받을 주소/분할/시간차)
  │   ├─ EIP-712 서명 → 선택한 릴레이어 API로 제출
  │   └─ 주문 취소
  ├─ 내 주문 현황
  │   ├─ 릴레이어별 주문 목록
  │   ├─ 체결 상태 (매칭 대기 / 체결 완료 / 취소)
  │   └─ claim 상태 (수령 가능 / 수령 완료 / 만료)
  ├─ 수취자 claim 화면
  └─ 릴레이어 관리자 대시보드
      ├─ 서버 상태 (업타임, 연결된 체인, RPC 상태)
      ├─ 주문 현황 (대기 / 체결 / 취소 건수)
      ├─ 수익 (누적 수수료 수령량, 토큰별)
      ├─ 지갑 잔액 (가스비용 ETH 잔고, 부족 시 알림)
      └─ settle 이력 (tx hash, 성공/실패, 가스 소모)

결과물: 동작하는 플랫폼 Web UI + 릴레이어 관리 대시보드
```

#### Phase 7: 테스트넷 배포 + E2E ⬜ 진행 예정

```
목표: 테스트넷에서 전체 시스템 동작 검증

작업:
  ├─ 컨트랙트 L2 테스트넷 배포
  ├─ 릴레이어 서버 구동 + RelayerRegistry에 등록
  ├─ E2E: 인증 → 입금 → 주문 → 매칭 → settle → claim
  └─ 가스비 측정 + 논문 Evaluation 데이터

결과물: 테스트넷 라이브 시스템
```

### 4.3 일정 요약

```
Phase 1: ScatterSettlement 코어            ✅ 완료
Phase 2: zk-X509 연동                      ✅ 완료
Phase 3: EIP-7702 스킬                     ✅ 완료
Phase 4: 릴레이어 레지스트리 + 플랫폼 수수료  ✅ 완료 (테스트 추가 필요)
Phase 5: 릴레이어 서버 (TypeScript)          ✅ 완료 (admin API, Dockerfile 미구현)
Phase 6: 프론트엔드 (플랫폼 UI)             ⬜ 진행 예정
Phase 7: 테스트넷 배포 + E2E               ⬜ 진행 예정
```

### 4.4 디렉토리 구조

```
scatter-dex/
├─ contracts/                 # Solidity (Foundry)
│   ├─ src/
│   │   ├─ ScatterSettlement.sol    # 코어 정산 컨트랙트
│   │   ├─ IdentityGate.sol         # zk-X509 인증 게이트
│   │   ├─ RelayerRegistry.sol      # 릴레이어 등록/보증금/수수료
│   │   ├─ VaultSkills.sol          # EIP-7702 배치 위임
│   │   └─ interfaces/
│   │       └─ IIdentityRegistry.sol
│   ├─ test/
│   │   ├─ ScatterSettlement.t.sol
│   │   ├─ IdentityGate.t.sol
│   │   └─ VaultSkills.t.sol
│   └─ script/
│       └─ DeploySettlement.s.sol
│
├─ relayer/                   # 릴레이어 서버 (TypeScript)
│   ├─ src/
│   │   ├─ index.ts           # Express 서버
│   │   ├─ config.ts          # 환경변수
│   │   ├─ routes/            # API 엔드포인트
│   │   ├─ core/
│   │   │   ├─ orderbook.ts   # 오더북 자료구조
│   │   │   ├─ matcher.ts     # 매칭 엔진
│   │   │   ├─ submitter.ts   # settle tx 제출
│   │   │   └─ signer.ts      # EIP-712 서명 검증
│   │   └─ types/
│   │       └─ order.ts       # 타입 정의
│   └─ package.json
│
├─ frontend/                  # Next.js 플랫폼 UI
│   ├─ src/
│   │   ├─ app/
│   │   ├─ components/
│   │   ├─ hooks/
│   │   └─ lib/
│   │       └─ signing/       # EIP-712 서명
│   └─ package.json
│
├─ DEV.md
└─ PAPER.md
```

---

## 5. 핵심 결정 사항 (Decisions)

### 확정

```
✓ zk-X509 인증 필수 (게이트키퍼, 컴플라이언스)
✓ 오프체인 오더북 (EIP-712 서명 기반, 온체인에 주문 안 올림)
✓ 지정가 주문 (리밋 오더)
✓ ScatterSettlement (시간차 분산 정산, 프라이버시의 핵심)
✓ 주문 시 에스크로 선입금 (자금 안전성 보장)
✓ 릴레이어 매칭 + 가스비 대납
✓ 수취자 claim 방식 (hash(secret, address) 기반)
✓ ZK Orderbook/Match Proof 불필요 (설계 단순화)
```

### 확정 사유: ZK 오더북 제거

```
기존 설계: ZK Order Proof + ZK Match Proof
  → Match Proof 논리 모순: 매칭봇이 private 정보 없이 증명 불가
  → ZK Order Proof도 불필요: 주문을 온체인에 안 올리면 숨길 필요 없음

수정된 설계:
  → 주문은 오프체인 (EIP-712 서명)
  → 매칭은 오프체인 (릴레이어)
  → 온체인에는 정산만 (ScatterSettlement)
  → ZK는 zk-X509 인증에만 사용 (이미 구현됨)

프라이버시의 핵심:
  → ZK가 아니라 ScatterSettlement의 7개 차원 분리 + claimHash
```

### 추가 확정 (논의 결과)

```
✓ 멀티 릴레이어 모델 (부동산 중개소 구조)
✓ maxFee 기반 수수료 (유저 서명에 상한 포함, 릴레이어 경쟁)
✓ withdraw() 즉시 인출 (매칭 전 자금 회수)
✓ refundUnclaimed() 타임아웃 환불 (claimExpiry 후 미수령분 회수)
✓ nonce 기반 중복 settle 방지 (멀티 릴레이어 안전)
✓ cancelOrder() 주문 선제 취소 (nonce 선소진)
✓ EIP-7702 VaultSkills (approve+deposit 1tx 배치)
```

### 플랫폼 모델 확정

```
✓ RelayerRegistry 온체인 등록 (보증금 예치 필수, 최소 0.1 ETH)
✓ 등록된 릴레이어만 settle() 호출 가능
✓ 프로토콜 수수료 분리 (릴레이어 몫 + 플랫폼 treasury 몫)
✓ 릴레이어 탈퇴 시 7일 대기 후 보증금 반환
✓ 슬래싱 없음 (온체인 증명 어려움, 보증금 + 평판으로 대체)
✓ 프론트엔드에서 릴레이어 목록 표시 (수수료, 보증금 등)
✓ 유저가 릴레이어 선택 후 주문 제출
✓ 내 주문 목록 + 체결 상태 조회
✓ zk-X509 서비스(CA) 정보 프론트엔드 표시
```

### 미결정 (개발하면서 결정)

```
? L2 선택: Arbitrum vs Base
  → Phase 5 배포 시 결정
  → EIP-7702 지원 여부 확인 필요

? REFUND_WINDOW 기본값 (예: 7일)
  → Phase 1에서 상수로 설정, 이후 조정

? 프라이버시 기본값 (주소 수, 시간차 범위)
  → Phase 4 UX 설계 시 결정

? EIP-7702 스킬 범위
  → Phase 3에서 구체화

? 저트래픽 대응 (유저 2명뿐일 때)
  → 최소 지연 시간 강제, 배치 정산, 더미 트랜잭션 등 검토
```

---

## 6. 성공 기준

```
MVP 완성 기준:
  ✓ zk-X509 인증된 유저가
  ✓ 에스크로에 자산을 입금하고
  ✓ 오프체인에서 서명 기반 주문을 제출하면
  ✓ 릴레이어가 매칭하여
  ✓ 시간차 분산 정산으로 여러 주소에 수령
  ✓ 테스트넷에서 동작
  ✓ Web UI로 조작 가능

데모 시나리오:
  1. Alice (인증) → 에스크로에 10 ETH 입금
  2. Bob (인증) → 에스크로에 21000 USDC 입금
  3. Alice → "10 ETH 매도 @ 2100" 서명 → 릴레이어
  4. Bob → "10 ETH 매수 @ 2100" 서명 → 릴레이어
  5. 릴레이어 → settle() 호출 → 매칭 + 스케줄 등록
  6. Alice가 수취자들에게 비밀번호 전달 (카톡, 이메일 등)
  7. Bob이 수취자에게 비밀번호 전달
  8. 3시간 후 → 수취자가 secret으로 7000 USDC claim
  9. 6시간 후 → 수취자가 secret으로 8000 USDC claim
  10. 9시간 후 → 수취자가 secret으로 6000 USDC claim
  11. 4시간 후 → 수취자가 secret으로 10 ETH claim

온체인 관찰자 시점:
  "여러 사람이 에스크로에 돈을 넣었고,
   시간이 지나면서 누군가들이 비밀번호로 돈을 꺼내갔다.
   누가 누구와 거래했는지, 꺼내간 사람이 누구의 수취자인지 모르겠다."
```

---

## 7. 독창성 요약

```
이 프로젝트가 기존과 다른 점:

① 컴플라이언스 + 프라이버시 양립
   → 인증된 사용자만 쓰니까 불법 아님
   → 자금 흐름은 추적 불가
   → 감독기관이 수용 가능한 프라이버시

② "거래는 투명, 정산은 불투명" 모델
   → 시장 데이터 제공 가능 (유동성, 거래량)
   → 개인 자금 흐름만 숨김
   → 기존 프라이버시 DEX의 "전부 숨김" 접근과 차별화

③ ZK 없이 프라이버시 달성
   → 복잡한 ZK 회로 불필요
   → ScatterSettlement + Hash Lock이라는 단순한 메커니즘
   → 구현 난이도 낮음, 감사 용이

④ 수취자 claim 방식 (Hash Lock)
   → 받는 주소가 온체인에 사전 등록되지 않음
   → 비밀번호 아는 수취자가 지정된 지갑에서 claim
   → 보내는 사람 ↔ 받는 사람 연결 완전 차단

⑤ 토네이도캐시와 차별화
   → 토네이도: "넣고 빼기"가 목적이 뻔함
   → 본 설계: "거래"라는 정당한 이유 + "수취"라는 정당한 출금

⑥ 구조적 MEV 면역
   → 지정가 오더북: 가격이 안 움직임 → 샌드위치 불가
   → 오프체인 주문: 멤풀에 안 보임 → 프론트런 불가
   → 시간 지연 정산: 체결 후 분산 출금 → 포스트 트레이드 공격 불가

⑦ 실사용 시나리오
   → 급여(토큰) 수령 → 다른 토큰으로 교환 → 거래처에 시간차 지급
   → 토큰 교환 + 분산 지급 + 스케줄링이 한 번 서명으로 해결
   → 단순 프라이버시를 넘어 급여/정산 자동화 도구로 활용 가능
```
