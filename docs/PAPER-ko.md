# zkScatter: 영지식 증명과 규정 준수를 갖춘 프라이버시 DEX 정산

> 기술 백서 — v1.0

---

## 1. 요약

zkScatter는 규정 준수를 유지하면서 자금 흐름을 암호학적으로 추적 불가능하게 만드는 프라이버시 보존형 탈중앙화 거래소(DEX) 정산 시스템이다. 사용자는 토큰을 영지식 commitment 풀에 입금하고, 오프체인 서명된 주문을 통해 거래하며, Groth16 proof를 통해 정산함으로써 입금자와 수령자 간의 온체인 연결을 끊는다. 믹싱 프로토콜이나 MPC 기반 다크풀과 달리, zkScatter의 프라이버시는 **통계적이 아닌 암호학적**이며 — 거래량에 관계없이 유지된다. Dual-CA 신원 아키텍처는 사용자 프라이버시(zk-X509를 통한 마스킹된 신원)와 릴레이어 책임성(공개 법인)을 분리하여, 법 집행기관이 어떠한 암호학적 백도어 없이도 규제된 중개자를 통해 조사할 수 있는 규정 준수 모델을 구현한다. Ethereum L1(현재 gas 가격 기준 $3 미만)과 L2($0.01 미만) 모두에 배포 가능하다.

---

## 2. 문제

탈중앙화 거래소는 세 가지 상충되는 요구사항 사이에서 트릴레마에 직면한다:

```
Privacy:     사용자는 자신의 금융 흐름이 추적 불가능하기를 원한다
Compliance:  규제기관은 참여자가 인증되기를 요구한다
Efficiency:  복잡한 암호학적 proof는 온체인에서 비용이 높다
```

기존 시스템은 이 세 가지 중 최대 두 가지만 해결한다:

| 시스템 | 프라이버시 | 규정 준수 | 효율성 |
|--------|---------|------------|------------|
| Uniswap / 기존 DEX | 없음 | 없음 | 있음 |
| Tornado Cash | 있음 | 없음 | 있음 |
| Railgun | 있음 | 없음 | 보통 |
| Renegade | 있음 | 없음 | 없음 (MPC/FHE) |
| **zkScatter** | **있음** (암호학적) | **있음** (Dual-CA) | **있음** (L1 + L2) |

Tornado Cash는 법 집행기관에 협력할 수 있는 책임 있는 중개자가 없었기 때문에 OFAC의 제재를 받았다. Renegade는 비용이 많이 드는 다자간 계산을 통해 프라이버시를 달성한다. Railgun은 ZK 프라이버시를 제공하지만 규정 준수 메커니즘이 없다. 기존 시스템 중 세 가지를 모두 해결하는 것은 없다.

---

## 3. 솔루션 개요

### 핵심 통찰

기존 프라이버시 DEX 설계는 *거래 자체*를 숨기려 한다 — 주문을 암호화하고, 매칭을 영지식으로 증명하고, 실행을 은폐한다. 이는 매칭 계층에서 비용이 높은 암호학적 기구를 요구한다.

zkScatter는 다른 접근법을 취한다: **거래 투명성이 자금 흐름 투명성을 의미하지는 않는다**. "누군가가 가격 2100에 10 ETH를 팔았다"는 것을 아는 관찰자도, 정산이 거래와 암호학적으로 분리되어 있다면 결과적으로 발생한 USDC가 어디로 갔는지 알 수 없다.

### 3계층 분리

프라이버시는 ZK commitment 풀을 사용하여 정산 계층에 집중된다:

```
+──────────────────────────────────────────────────────────────────+
|  Layer 1 — DEPOSIT                                               |
|  User deposits tokens into a Poseidon commitment pool.           |
|  On-chain: commitment hash, token, amount.                       |
|  Hidden: trade intent, price, counterparty, recipient.           |
+──────────────────────────────────────────────────────────────────+
                              |
                              v
+──────────────────────────────────────────────────────────────────+
|  Layer 2 — TRADE & SETTLE                                        |
|  Off-chain EdDSA order signing; on-chain Groth16 settlement.     |
|  On-chain: nullifiers, claims roots, locked amounts.             |
|  Hidden: maker/taker identities, claim structure, order params.  |
+──────────────────────────────────────────────────────────────────+
                              |
                              v
+──────────────────────────────────────────────────────────────────+
|  Layer 3 — CLAIM                                                 |
|  Recipient proves Merkle inclusion via ZK proof.                 |
|  On-chain: recipient address, amount, nullifier.                 |
|  Hidden: link to original deposit and settlement — no            |
|  statistical analysis can recover it.                            |
+──────────────────────────────────────────────────────────────────+
```

이 분리는 릴레이어들이 사용자 프라이버시를 저하시키지 않으면서 매칭 유동성을 극대화하기 위해 자유롭게 협력할 수 있음을 의미한다 — 프라이버시가 릴레이어로부터 데이터를 숨기는 것이 아니라 ZK proof에서 비롯되기 때문이다.

---

## 4. 시스템 아키텍처

### 4.1 참여자

```
Depositor:   commitment 풀에 자산을 입금하는 인증된 사용자
Recipient:   ZK 클레임을 통해 정산 자금을 수령하도록 지정된 주체
Relayer:     주문을 수집하고, proof를 생성하며, 정산을 제출하는 오프체인 서비스
```

### 4.2 Dual-CA 신원

zkScatter는 상반되는 공개 정책을 가진 두 개의 서로 다른 인증 기관(Certificate Authority)을 사용한다:

```
+─────────────────────────────────────────────────────────────────+
|  User CA (프라이버시 보존형)                                      |
|  - 최대 필드 마스킹을 적용한 zk-X509 인증서                       |
|  - 온체인: ZK proof를 통해 "인증된 사용자"임만 증명                 |
|  - 신원 필드 노출 없음                                            |
|  - 근거: 사용자는 금융 프라이버시를 필요로 함                       |
+─────────────────────────────────────────────────────────────────+

+─────────────────────────────────────────────────────────────────+
|  Relayer CA (책임성 극대화형)                                      |
|  - 최소 필드 마스킹을 적용한 zk-X509 인증서                       |
|  - 온체인: 조직명, 관할권, 라이선스 공개                           |
|  - 법인이 공개적으로 검증 가능                                     |
|  - 근거: 릴레이어는 법적 의무를 가진 서비스 제공자                   |
+─────────────────────────────────────────────────────────────────+
```

이 비대칭성은 의도된 것이다. 사용자는 금융 프라이버시 보호의 *대상*이며, 릴레이어는 전통적 금융 서비스 제공자와 유사한 수탁 의무를 가진 *인가된 중개자*이다.

**Multi-CA IdentityGate**: IdentityGate 컨트랙트는 여러 zk-X509 레지스트리(CA당 하나)를 통합한다. Owner는 레지스트리를 추가하거나 제거할 수 있다. **어느** 등록된 CA가 인증했든 사용자는 검증된 것으로 간주된다. 두 개의 별도 IdentityGate 인스턴스가 배포된다 — 하나는 사용자 입금용(프라이버시 보존형 CA), 다른 하나는 릴레이어 등록용(책임성 CA)이다.

### 4.3 Commitment 풀

Commitment 풀은 Poseidon hash를 사용하는 점진적 Merkle tree(깊이 20, ~100만 용량)이다:

```
Commitment = Poseidon(ownerSecret, token, amount, salt)
Nullifier  = Poseidon(ownerSecret, salt)
```

- **ownerSecret**: 입금자만 알고 있는 개인 키 소재 (온체인에 노출되지 않음)
- **token**: ERC20 토큰 주소
- **amount**: 입금 금액
- **salt**: 고유성을 위한 랜덤 논스

Commitment은 모든 세부사항을 숨긴다. Nullifier는 이중 지출 방지를 가능하게 한다 — commitment을 소비하면 원래 입금으로 역추적할 수 없는 hash만 공개된다.

### 4.4 ZK 회로

zkScatter는 세 개의 Groth16 회로를 사용한다:

**정산 회로 (~30K 제약)**
단일 ZK proof 내에서 완전한 거래를 검증한다:
- maker와 taker의 commitment이 모두 Merkle tree에 존재
- Nullifier가 올바르게 도출됨 (재실행 방지)
- 양 주문에 대한 EdDSA 서명이 유효 (Baby Jubjub 곡선)
- 토큰 호환성 및 가격 호환성
- 수수료 검증 (실제 수수료 <= 사용자 서명 maxFee)
- 잔액 충분성
- claim 리프로부터 claims tree root가 올바르게 계산됨
- 잔여 잔액으로부터 change commitment이 올바르게 도출됨
- 자기 거래 방지 (서로 다른 공개 키)

**클레임 회로 (~1.5K 제약)**
수령자가 자금을 클레임할 수 있는지 검증한다:
- claim 리프가 claims Merkle tree(깊이 4)에 존재
- claim nullifier가 올바르게 도출됨 (이중 클레임 방지)
- 수령자 주소가 공개 입력으로 바인딩됨 (리다이렉트 방지)

**출금 회로 (~6K 제약)**
사용자가 매칭되지 않은 입금을 출금할 수 있게 한다:
- Commitment이 Merkle tree(깊이 20)에 존재
- Nullifier가 올바르게 도출됨
- 토큰 및 금액 바인딩
- 잔여 잔액에 대한 change commitment

### 4.5 멀티 릴레이어 네트워크

릴레이어는 부동산 MLS의 에이전트처럼 운영된다 — 매칭 속도를 극대화하기 위해 주문 흐름에서 협력하면서 서비스 품질로 경쟁한다:

```
Real Estate MLS:                        zkScatter Multi-Relayer:
  Agents share listings                   Relayers share order flow
  Agents compete on service quality       Relayers compete on fees and speed
  Sharing accelerates deal closure        Sharing accelerates order matching
  Agent knows deal details                Relayer knows order details
  But cannot steal the property           But cannot steal user funds
```

이 협력은 설계에 의한 것이다. 릴레이어의 경제적 인센티브는 가능한 많은 주문을 정산하는 것(정산당 수수료 수입)이지, 데이터를 유출하는 것이 아니다. 데이터 유출은 릴레이어의 사업을 파괴한다 — 사용자가 단순히 경쟁 릴레이어에게 주문을 보내면 된다.

---

## 5. 작동 방식

### 1단계: 신원 검증

사용자는 등록된 인증 기관을 통해 zk-X509로 신원을 검증한다. 온체인 컨트랙트는 `UserIdentityGate.isVerified(user)`를 호출하며, 등록된 CA 중 하나라도 사용자를 검증했으면 true를 반환한다. 온체인에 신원 필드가 공개되지 않는다.

릴레이어는 스테이킹된 ETH와 함께 `RelayerRegistry.register(url, fee)`를 통해 등록한다. Relayer IdentityGate가 CA 인증서를 검증하고, 조직명, 관할권, 라이선스가 온체인에 저장된다.

### 2단계: 입금

```
User calls CommitmentPool.deposit(commitment, token, amount):
  1. IdentityGate verifies the user is authenticated
  2. ERC20 tokens transfer from user to the pool
  3. Commitment is inserted into the Merkle tree
  4. CommitmentInserted event emitted (commitment hash, leaf index, timestamp)
```

Commitment은 오프체인에서 계산된 `Poseidon(ownerSecret, token, amount, salt)`이다. 컨트랙트는 프리이미지를 검증하지 않는다 — 사용자가 잘못된 commitment을 제출하면 자신만 손해를 입는다.

### 3단계: 주문 서명 (오프체인)

```
1. User derives an EdDSA key pair on the Baby Jubjub curve
   (deterministically from MetaMask signature, stored encrypted in browser)

2. User constructs order with claim leaves:
   claimLeaf = Poseidon(secret, recipient, token, amount, releaseTime)
   claimsRoot = MerkleRoot(claimLeaf_1, ..., claimLeaf_n, 0, ..., 0)

3. User signs the order hash with EdDSA

4. User sends signed order + claim secrets to chosen Relayer(s)
   - Order is not public; only selected Relayers see it
   - User may send to multiple Relayers simultaneously
```

### 4단계: 정산

릴레이어가 호환되는 주문을 매칭하고 Groth16 proof를 생성한다:

```
Relayer calls PrivateSettlement.settlePrivate(proof, publicSignals):

  The proof verifies (in zero-knowledge):
    - Both commitments exist in the pool
    - Both EdDSA signatures are valid
    - Prices are compatible, fees are within limits
    - Claims trees are correctly constructed
    - Change commitments are correctly derived

  The contract:
    - Verifies the Groth16 proof
    - Marks nullifiers as spent (prevents replay)
    - Inserts change commitments into the pool
    - Transfers claim amounts to PrivateSettlement
    - Transfers fees directly to the relayer
    - Registers ClaimsGroups (keyed by claims root)
```

여러 릴레이어가 동일한 주문에 대한 매칭을 찾은 경우, 먼저 제출하는 쪽이 승리한다 — nullifier가 이미 소비되었으므로 이후 시도는 실패한다.

### 5단계: 클레임

**직접 클레임** (수령자가 gas를 보유한 경우):

```
Recipient calls claimWithProof(proof, claimsRoot, nullifier, amount, token, recipient, releaseTime):

  The proof verifies:
    - Claim leaf exists in the claims tree
    - Nullifier correctly derived (prevents double-claim)

  The contract:
    - Verifies proof and checks nullifier
    - Confirms totalClaimed + amount <= totalLocked
    - Confirms block.timestamp >= releaseTime
    - Transfers tokens to recipient
```

**가스리스 클레임** (수령자가 gas를 보유하지 않은 경우):

새로운 수령자 주소에는 gas를 위한 ETH가 없다. 기존 지갑에서 자금을 보내면 프라이버시를 파괴하는 온체인 연결이 생성된다. 대신:

1. 수령자가 브라우저에서 ZK claim proof를 생성한다 (proof가 수령자 주소를 공개 입력으로 바인딩)
2. 수령자가 proof를 릴레이어에게 전송한다
3. 릴레이어가 수령자를 대신하여 `claimWithProof()`를 제출한다
4. Gas 비용은 정산 수수료 메커니즘을 통해 보상된다

릴레이어는 자금을 리다이렉트할 수 없다 — proof가 수령자 주소를 암호학적으로 바인딩한다. 새 주소는 외부 소스로부터 ETH를 받을 필요가 없으므로 주소 격리가 유지된다.

### 출금 (매칭되지 않은 입금)

사용자는 ZK 출금 proof를 통해 언제든지 매칭되지 않은 자금을 출금할 수 있다. Proof는 commitment 소유권을 검증하고 nullifier를 도출한다. 선택적 change commitment이 부분 출금을 처리한다.

---

## 6. 프라이버시 보장

### 숨겨지는 것

zkScatter는 **암호학적 비연결성**을 제공한다 — 온체인 관찰자는 어떤 입금이 어떤 클레임에 자금을 제공했는지 판별할 수 없다. 이는 일곱 가지 차원에서 적용된다:

| 차원 | 입금 측 | 클레임 측 | 숨기는 방법 |
|-----------|-------------|------------|-----------------|
| 토큰 | 토큰 A (예: ETH) | 토큰 B (예: USDC) | ZK proof 내부에서 교차 토큰 변환 |
| 금액 | X 단위 | y1 + y2 + ... + yn 단위 | 분할 금액이 proof에서 숨겨짐 |
| 주소 | 입금자 주소 | 새로운 수령자 주소 | ZK proof가 입금자를 숨기고 수령자는 새 주소 사용 |
| 시간 | t_deposit | 다수의 클레임 시점 | proof 내부에서 해제 시간 설정 |
| 혼합 | commitment 풀에서 혼합 | 불투명 root에서 클레임 | 모든 commitment이 단일 트리에 존재 |
| 사전 은폐 | commitment hash만 공개 | 클레임 전까지 claims root만 공개 | 클레임 전에는 아무것도 공개되지 않음 |
| 인가 | -- | ZK proof 필요 | proof 보유자만 클레임 가능 |

### 통계적 프라이버시보다 강력한 이유

Tornado Cash 같은 믹싱 프로토콜은 **통계적** 프라이버시를 제공한다: 공격자의 이점은 익명 집합 크기에 반비례한다 (풀에 있는 입금 수 N에 대해 1/N). 트래픽이 적으면 프라이버시가 크게 저하된다.

zkScatter의 프라이버시는 **암호학적**이다: Groth16 proof의 영지식 속성은 온체인 관찰자가 트래픽 규모에 관계없이 입금-클레임 매핑에 대해 *아무것도* 알 수 없음을 보장한다. 풀에 단일 입금만 있어도 ZK proof는 어떤 commitment이 소비되었는지에 대한 정보를 공개하지 않는다.

핵심 메커니즘:

1. **ZK Commitment 풀**: 입금은 Poseidon commitment이다. 정산은 nullifier를 통해 이를 소비한다 — 정산 트랜잭션에 입금자 주소가 나타나지 않는다.

2. **Claims Tree 간접 참조**: 정산은 claims root(claim 리프의 Merkle root)를 생성한다. 각 claim 리프는 새로운 랜덤 secret을 사용하여 랜덤 데이터와 계산적으로 구별할 수 없다.

3. **가스리스 ZK 클레임**: 새로운 수령자 주소는 외부 ETH가 필요하지 않아, 새 주소를 기존 지갑에 다시 연결하는 gas 펀딩 링크를 제거한다.

---

## 7. MEV 면역

zkScatter는 기존 DEX에서 가장 비용이 높은 두 가지 MEV 벡터인 샌드위치 공격과 프론트러닝에 구조적으로 면역이다.

```
Attack Type         AMM (Uniswap)    On-chain OB    zkScatter
──────────────────────────────────────────────────────────────
Sandwich            Vulnerable        Vulnerable     Impossible
Front-running       Vulnerable        Vulnerable     Impossible
Back-running        Vulnerable        Possible       Impossible
JIT Liquidity       Vulnerable        N/A            N/A
Oracle Manipulation Vulnerable        N/A            N/A
```

**샌드위치 공격이 실패하는 이유**: 지정가 주문장에서 가격 P의 매수 주문은 다른 주문에 관계없이 정확히 P에 체결된다. 악용할 수 있는 가격 영향 곡선이 없다. 공격자가 P-1에 매도 주문을 놓으면 더 나쁜 가격에 팔게 되어 손해를 본다.

**프론트러닝이 실패하는 이유**: 주문은 비공개 채널을 통해 릴레이어에게 전송되는 오프체인 EdDSA 서명으로 존재한다. 유일한 온체인 트랜잭션은 `deposit()` (거래 의도를 공개하지 않음)과 `settlePrivate()` (이미 매칭된 거래를 원자적으로 실행)이다. 정산이 멤풀에 나타날 때 거래는 이미 완료되어 있으므로 — 공격자는 ZK proof에서 주문 파라미터를 추출할 수 없고 완료된 정산을 프론트런할 수 없다.

**ZK proof가 추가 방패인 이유**: 공격자가 `settlePrivate()`를 관찰하더라도, proof는 주문 파라미터에 대한 정보를 공개하지 않으며(영지식 속성), 클레임 수령자는 claims root 뒤에 숨겨져 있다. 검증은 악용할 중간 상태가 없는 단일 원자적 연산이다.

---

## 8. 규정 준수 모델

### 프라이버시와 규정 준수의 공존

프라이버시와 규정 준수는 **다른 계층에서** 작동한다:

- **사용자는 비공개**: User CA, 마스킹된 신원, ZK proof
- **릴레이어는 공개**: Relayer CA, 마스킹되지 않은 법인, 온체인 신원
- **프라이버시는 암호학적**: 프로토콜 수준에서 ZK proof로 시행
- **규정 준수는 제도적**: 릴레이어가 규제된 게이트키퍼로서 시행

### 규제된 중개자로서의 릴레이어

릴레이어는 명시적인 규정 준수 의무를 가진 공개 식별 법인이다:

**데이터 보관 및 공개**: 릴레이어는 오프체인 주문 로그를 유지하고 유효한 법원 명령에 따라 서명된 주문 데이터를 제공한다. 어떤 사용자가 불법인지 사전에 판단할 수 없다 — 의무는 사후 공개이지 사전 심사가 아니다.

**제재 심사**: 릴레이어는 기본적인 규정 준수 조치로서 입금자 주소를 공개 제재 목록(예: OFAC SDN)과 대조하여 심사한다.

**거래 무결성**: 릴레이어는 유효한 proof를 성실하게 생성하고(proof 검증에 의해 시행), 사용자 승인 한도 내에서 수수료를 부과하며(ZK 회로에 의해 시행), 서비스 가용성을 유지한다(스테이킹과 슬래싱에 의해 시행).

### 법 집행의 작동 방식

불법 자금이 zkScatter를 통해 유통된 것이 발견되는 경우:

1. 법 집행기관이 해당 트랜잭션을 처리한 릴레이어를 식별한다 (릴레이어 신원은 온체인에 공개)
2. 유효한 법원 명령 또는 규제 소환장이 릴레이어에게 오프체인 주문 데이터 공개를 강제한다
3. 릴레이어가 서명된 주문 세부사항, 클레임 수령자 및 관련 데이터를 제공한다

이것은 **암호학적 백도어 없는 법적 백도어**이다. 사용자 프라이버시는 프로토콜 수준에서 보존되고, 합법적 조사는 릴레이어의 규제된 중개자 역할을 통해 진행된다.

### Tornado Cash 문제를 회피하는 이유

Tornado Cash는 법 집행기관에 협력할 수 있는 책임 있는 중개자가 없었기 때문에 프로토콜 전체가 제재를 받았다. zkScatter는 설계에 의해 이를 회피한다: 비위 책임은 프로토콜 자체가 아니라 특정 릴레이어 법인에게 귀속된다.

| 시스템 | 릴레이어 신원 | 규제적 역할 | 비위의 결과 |
|--------|-----------------|-----------------|--------------------------|
| 0x Protocol | 익명 | 없음 | 없음 |
| CoW Protocol | 익명 | 없음 | 없음 |
| Tornado Cash | 해당 없음 | 해당 없음 | OFAC 제재 (프로토콜 전체) |
| **zkScatter** | **공개 법인** | **인가된 중개자** | **개인 책임** |

---

## 9. 보안 속성

### 이중 지출 방지

각 commitment은 최대 한 번만 사용될 수 있다. Nullifier `Poseidon(ownerSecret, salt)`는 결정적이다 — 동일한 commitment은 항상 동일한 nullifier를 생성한다. 컨트랙트는 이전에 확인된 모든 nullifier를 거부한다.

### Commitment 은닉

Commitment `Poseidon(ownerSecret, token, amount, salt)`는 Poseidon의 충돌 저항성 하에서 계산적으로 은닉된다. Commitment hash만 주어졌을 때, 공격자는 온체인에 나타나지 않는 ownerSecret에 대한 지식 없이는 프리이미지를 판별할 수 없다.

### Commitment 바인딩

Poseidon의 충돌 저항성 하에서, 두 개의 서로 다른 (ownerSecret, token, amount, salt) 튜플이 동일한 commitment을 생성할 수 없다. 입금자는 특정 토큰과 금액에 암호학적으로 바인딩된다.

### 클레임 보존

정산 회로는 `totalLocked = sum(claimAmounts)` 및 `totalLocked + fee <= sellAmount`를 강제한다. 온체인 컨트랙트는 `totalClaimed <= totalLocked`를 강제한다. 이 둘을 합치면 합법적으로 정산된 것보다 더 많은 토큰을 클레임할 수 없음이 보장된다.

### Change Commitment 정확성

정산 회로는 change commitment이 잔여 잔액으로부터 올바르게 도출되도록 강제한다. 잔여 잔액이 0이면 change commitment도 0이어야 한다 (가상 UTXO 방지).

### 프론트러닝 저항

Claim proof는 수령자 주소를 공개 입력으로 바인딩한다. 공격자가 proof를 가로채더라도 자금을 리다이렉트할 수 없다 — 컨트랙트는 proof에 포함된 주소로만 토큰을 전송한다.

### 악의적 릴레이어 하에서의 자금 안전성

완전히 악의적인 릴레이어조차 자금 안전성을 훼손할 수 없다:

| 행위 | 가능 여부 | 이유 |
|--------|-----------|--------|
| 자금 탈취 | 불가 | Claim proof가 수령자를 공개 입력으로 바인딩 |
| 자금 리다이렉트 | 불가 | Claims root가 정산 proof에서 커밋됨 |
| 입금자의 실제 신원 식별 | 불가 | EdDSA 키가 세션별로 도출되며 Ethereum 주소와 연결되지 않음 |
| 주문 프론트런 | 불가 | 정산에 ZK proof 내에서 양 당사자의 EdDSA 서명이 필요 |
| 과도한 수수료 부과 | 불가 | 수수료 상한이 ZK 회로 내에서 강제됨 |
| 클레임 구조 변경 | 불가 | Claims root가 양 당사자에 의해 서명됨 |

### 릴레이어 프라이버시 영향

릴레이어는 proof 생성을 위해 필연적으로 주문 내용(토큰, 금액, 가격, claim secret, 수령자 주소)을 알게 된다. 그러나:

- 릴레이어는 사용자의 EdDSA 공개 키를 알지만, 이는 사용자의 Ethereum 주소가 **아니다**. EdDSA 키는 MetaMask 서명으로부터 세션별로 도출된다.
- 온체인에서 정산은 다음만 보여준다: 소비된 nullifier, 생성된 claims root, 전송된 토큰. 입금자 주소는 나타나지 않는다.
- 멀티 릴레이어 트래픽 분할은 단일 릴레이어가 관찰할 수 있는 범위를 제한한다. R개의 릴레이어와 m개의 공모 릴레이어가 있을 때, 공격자는 네트워크 트래픽의 최대 m/R만 관찰한다.

---

## 10. 비교

### 아키텍처 비교

| 특성 | Uniswap | 0x/CoW | Renegade | Railgun | **zkScatter** |
|---------|---------|--------|----------|---------|---------------|
| 주문장 유형 | AMM | 오프체인 | 다크풀 | 해당 없음 | 오프체인 |
| 주문 프라이버시 | 없음 | 없음 | 완전 (MPC) | 해당 없음 | 오프체인 (EdDSA) |
| 정산 프라이버시 | 없음 | 없음 | 완전 (MPC) | 완전 (ZK) | **완전 (Groth16)** |
| 릴레이어 모델 | 해당 없음 | 익명 | 익명 | 해당 없음 | **공개 (Dual-CA)** |
| 신원 확인 | 없음 | 없음 | 없음 | 없음 | **Dual-CA** |
| MEV 저항 | 없음 | 부분적 | 완전 | 부분적 | **면역** |
| 거래당 gas | ~150K | ~100K | ~500K+ | ~300K+ | ~3,565K* |
| ZK 회로 수 | 0 | 0 | 0 (MPC) | 다수 | 3 |
| 프라이버시 보장 | 없음 | 없음 | 계산적 | 계산적 | **계산적** |

*Gas 비교 참고: Uniswap/0x 수치는 프라이버시 없는 단일 스왑이다. 동등한 엔드투엔드 프라이빗 거래는 여러 연산을 필요로 하며, 총합으로 ~1.7M (Railgun)과 ~2.2M (Tornado Cash)이 소요된다. zkScatter의 ~3,565K는 4건의 클레임을 포함한 완전한 프라이빗 거래를 포함한다. L2에서는 $0.01 미만의 비용이 든다.*

### 프라이버시 비교

| 지표 | Tornado Cash | Railgun | **zkScatter** |
|--------|-------------|---------|---------------|
| 프라이버시 유형 | 계산적 (ZK) | 계산적 (ZK) | **계산적 (ZK)** |
| 트래픽 의존성 | 있음 (익명 집합) | 부분적 (풀 크기) | **없음 (암호학적)** |
| 토큰 다양성 | 풀당 단일 토큰 | 멀티 토큰 | **교차 토큰 거래** |
| 금액 유연성 | 고정 단위 | 임의 금액 | **임의 금액, 다중 수령자** |
| 규정 준수 | 없음 | 선택적 (viewing key) | **내장 (Dual-CA)** |
| 입금자 노출 | 있음 (입금 주소) | 있음 (차폐 주소) | **없음 (commitment만)** |

### DEX 아키텍처 진화

| 세대 | 예시 | 아키텍처 |
|-----------|---------|-------------|
| 1세대 | EtherDelta | 온체인 주문장 |
| 2세대 | Uniswap | 온체인 AMM |
| 3세대 | 0x, CoW | 오프체인 주문, 온체인 정산 |
| 4세대 | Renegade, Railgun | 프라이버시 우선 (ZK/MPC) |
| **5세대** | **zkScatter** | **ZK commitment 풀 + Dual-CA 규정 준수** |

---

## 11. Gas 비용 및 성능

### Gas 측정

Foundry를 통해 로컬 EVM에서 측정 (Solidity 0.8.28, 옵티마이저 200회). 참조 시나리오: maker가 10 ETH를 21,000 USDC로 매도, maker가 3건의 클레임으로 분할, taker가 1건의 클레임, 수수료 없음.

| 연산 | 사용 Gas | 비고 |
|-----------|----------|-------|
| 입금 (첫 번째/콜드) | ~810K | Poseidon Merkle 삽입 (깊이 20) |
| 입금 (이후/웜) | ~657K | 두 번째 삽입 (부분적 웜 스토리지) |
| 정산 (3+1 클레임) | ~1,633K | Groth16 검증 + 2 commitment 삽입 + 전송 |
| 클레임 (수령자당) | ~83K | Groth16 검증 + nullifier 확인 + 전송 |
| **합계 (1 거래, 4 클레임)** | **~3,565K** | **2 입금 + 1 정산 + 4 클레임** |

참고: Gas 측정은 MockVerifier를 사용한다. 실제 온체인 Groth16 검증은 proof당 ~200K gas가 추가된다 (총 ~4.4M).

### 정산 비용 분석

`settlePrivate()` 함수의 ~1,633K gas가 지배적 비용이다:

```
Component                                  Est. Gas    % of settle
──────────────────────────────────────────────────────────────────
Groth16 proof verification (16 signals)     ~200,000    12%
Commitment insertions (2x Poseidon x 20)    ~800,000    49%
Token transfers (4x ERC20)                  ~200,000    12%
Nullifier storage (4x cold SSTORE)          ~100,000     6%
ClaimsGroup storage (2x cold, 2 slots)       ~80,000     5%
Validation logic + calldata                 ~253,000    16%
```

### 배포 비용

역사적으로 낮은 Ethereum L1 gas 가격(2025년 4월 관측 기준 최저 ~0.36 Gwei [21]) 덕분에 zkScatter는 Ethereum 메인넷에 실용적으로 배포 가능하다:

| 네트워크 | Gas 가격 | 거래당 비용 (USD) |
|---------|-----------|---------------------|
| Ethereum L1 | ~0.36 Gwei | ~$2.35 |
| Ethereum L1 | ~1.0 Gwei | ~$6.50 |
| Base L2 | ~0.001 Gwei | ~$0.006 |
| Optimism | ~0.01 Gwei | ~$0.064 |
| Arbitrum | ~0.01 Gwei | ~$0.064 |

현재 L1 gas 가격에서 전체 프라이빗 거래(입금 + 정산 + 클레임)의 비용은 $3 미만으로 — 고가치 프라이버시 민감 거래에 적합하다. L2 배포는 일상적 사용을 위해 비용을 $0.10 미만으로 낮춘다.

### 회로 복잡도

| 회로 | 제약 수 | 증명 시간 (추정) | 검증 Gas |
|---------|------------|-------------------|-----------------|
| settle | ~30K | ~2초 (브라우저) | ~200K |
| claim | ~1.5K | ~0.5초 (브라우저) | ~200K |
| withdraw | ~6K | ~1초 (브라우저) | ~200K |

Groth16 검증 비용은 회로 크기에 관계없이 일정하다 (~200K gas), 이는 일정 크기의 proof와 고정된 검증 알고리즘 덕분이다.

---

## 12. 설계 근거

**ZK 주문장을 사용하지 않는 이유?** 허가 없는 매처가 두 주문의 가격 호환성을 증명하려면, 매처가 비공개 주문 데이터에 접근해야 한다 — 이는 프라이버시 목표와 모순된다. 주문이 오프체인이면 온체인에서 숨길 것이 없다. 분리 원칙은 주문을 오프체인에 유지하고 프라이버시를 정산 계층에 집중시킴으로써 이를 해결한다.

**사전 입금 방식의 commitment 풀을 사용하는 이유?** 클레임에는 해제 시간 지연이 있을 수 있으며, 풀은 단일 정산에서 여러 클레임에 자금을 제공해야 한다. 사전 입금은 정산이 항상 성공하도록 보장한다. UTXO 모델(commitment + nullifier)은 자연스러운 이중 지출 방지를 제공한다.

**Baby Jubjub에서 EdDSA를 사용하는 이유?** Baby Jubjub의 EdDSA 검증은 ZK 회로 내에서 ~10K 제약이 소요되는 반면, ECDSA/secp256k1은 ~100K+ 제약이 필요하다. 이를 통해 정산 회로를 총 ~30K 제약으로 관리 가능하게 유지한다.

**Poseidon을 사용하는 이유?** Poseidon은 hash 호출당 ~200 제약이 소요되는 반면, Keccak-256은 ~25K이다. 정산 회로가 여러 차례의 hash를 수행하므로, Poseidon은 회로 크기를 한 자릿수 줄인다.

**수령자별 고유 secret을 사용하는 이유?** 고유한 claim secret은 클레임 간 상관관계를 방지한다. 두 클레임이 동일한 secret을 사용하면, 첫 번째 클레임의 파라미터가 두 번째 클레임 발생 전에 상관관계 분석을 가능하게 할 수 있다.

---

## 13. 한계 및 향후 과제

### 알려진 한계

- **Proof 생성 지연**: 정산 회로(~30K 제약)는 브라우저 기반 proof 생성에 ~2초가 필요하다. 최적화된 네이티브 또는 GPU 프루버로 이를 단축할 수 있다.
- **L1에서의 gas 비용**: 거래당 ~3.5M gas로, zkScatter는 현재 gas 가격(~0.36 Gwei)에서 Ethereum 메인넷에서 ~$2.35의 비용이 든다. 이는 고가치 거래에 적합하며, L2 배포는 일상적 사용을 위해 비용을 더 절감한다.
- **릴레이어 지식**: 릴레이어는 proof 생성을 위해 필연적으로 주문 내용을 알게 된다. 이를 악용하여 자금을 탈취할 수는 없지만, 공모하는 릴레이어는 EdDSA 키를 클레임 수령자와 연결할 수 있다. 멀티 릴레이어 분할과 EdDSA/Ethereum 주소 분리가 방어를 제공한다.
- **클레임 시 수령자 주소 노출**: 클레임 트랜잭션은 수령자 주소와 금액을 공개한다. 일회용 새 주소가 실제 신원 노출을 완화한다.
- **키 관리**: 사용자는 Ethereum 키 외에 EdDSA 키를 관리해야 한다. MetaMask 서명으로부터의 결정적 도출이 이를 단순화하지만 UX 복잡성을 추가한다.

### 향후 과제

- Circom 회로 및 Solidity 컨트랙트의 형식 검증
- 멀티 릴레이어 경쟁 및 수수료 동적 분석의 게임 이론 모델
- 기존 DEX 애그리게이터와의 통합
- 브릿지 프로토콜을 통한 크로스체인 zkScatter
- 온체인 검증을 단일 proof로 줄이기 위한 재귀적 proof 합성
- 프로덕션 Groth16 파라미터를 위한 신뢰 설정 세레모니
- 커스텀 게이트를 통한 정산 회로 제약 수 최적화

---

## 14. 참고문헌

### 프라이버시 보존형 DEX 및 DeFi

[1] Renegade. "A Dark Pool DEX Using MPC." https://renegade.fi, 2023.

[2] Railgun. "Privacy System for DeFi." https://railgun.org, 2022.

[3] Penumbra. "A Private DEX on Cosmos." https://penumbra.zone, 2023.

[4] Pertsev, A., Semenov, R., Storm, R. "Tornado Cash Privacy Solution." 2019.

[5] Poon, J., Dryja, T. "The Bitcoin Lightning Network." 2016.

[6] Warren, W., Bandeali, A. "0x: An Open Protocol for Decentralized Exchange on the Ethereum Blockchain." 2017.

[7] CoW Protocol. "Batch Auctions with Coincidence of Wants." https://cow.fi, 2022.

[8] 1inch Network. "Fusion Mode: Intent-Based Swaps with Resolvers." https://1inch.io, 2023.

[9] Buterin, V., Illum, J., Nadler, M., Schar, F., Soleimani, A. "Blockchain Privacy and Regulatory Compliance: Towards a Practical Equilibrium." 2023.

### MEV 및 프론트러닝

[10] Daian, P. et al. "Flash Boys 2.0: Frontrunning in Decentralized Exchanges." IEEE S&P, 2020.

[11] Eskandari, S. et al. "SoK: Transparent Dishonesty — Front-Running Attacks on Blockchain." FC Workshop, 2020.

### 암호학적 기초

[12] Goldreich, O. "Foundations of Cryptography: Volume 2." Cambridge University Press, 2004.

[13] Canetti, R. "Universally Composable Security." FOCS, 2001.

[14] Shoup, V. "Sequences of Games." Cryptology ePrint Archive, 2004.

### 프라이버시 프로토콜

[15] Bunz, B. et al. "Zether: Towards Privacy in a Smart Contract World." FC, 2020.

[16] Seres, I. et al. "Mixeth: Efficient, Trustless Coin Mixing Service for Ethereum." 2021.

### 규정 준수 및 신원

[17] Zcash Foundation. "Selective Disclosure and Viewing Keys in Shielded Protocols." 2022.

[18] Sonnino, A. et al. "Coconut: Threshold Issuance Selective Disclosure Credentials." NDSS, 2019.

### Hash 함수

[19] Grassi, L. et al. "Poseidon: A New Hash Function for Zero-Knowledge Proof Systems." USENIX Security, 2021.

### MEV 완화

[20] Flashbots. "MEV-Share: Programmable Order Flow." 2023.

[21] Etherscan. "Transaction 0x4461cc699fb0b82e — Gas Price 0.357707362 Gwei." https://etherscan.io/tx/0x4461cc699fb0b82e14e0572e44dbd9390c440659dd693d249e268484b2ba9a0b, April 2025.

[22] Babel, K. et al. "Clockwork Finance: Automated Analysis of Economic Security." IEEE S&P, 2023.
