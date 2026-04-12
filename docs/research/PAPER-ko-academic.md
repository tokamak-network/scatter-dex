# zkScatter: 영지식 commitment pool과 이중 CA 규정 준수를 통한 프라이버시 보존 DEX 정산

> 초안 논문 — 검증된 프라이버시 DEX 연구

---

## 초록

본 논문은 영지식 commitment pool과 Groth16 proof를 통해 암호학적 거래 연결 불가능성(unlinkability)을 달성하는 프라이버시 보존 탈중앙화 거래소(DEX) 정산 시스템인 **zkScatter**를 제시한다. 사용자는 Poseidon 기반 commitment pool(깊이 20의 incremental Merkle tree, 약 100만 용량)에 토큰을 입금하고, Baby Jubjub 곡선 상의 EdDSA를 사용하여 오프체인에서 주문에 서명하며, commitment pool로부터의 출금, 클레임 Merkle tree(깊이 4) 구성, 잔여 잔액에 대한 잔액 commitment 생성을 동시에 수행하는 단일 Groth16 proof를 통해 거래를 정산한다. 수령인은 ZK proof와 nullifier를 사용하여 클레임 트리 내 Merkle 포함(inclusion)을 증명함으로써 자금을 수령하며, 이를 통해 어떤 정산에서 해당 클레임이 발생했는지를 공개하지 않으면서 이중 지출을 방지한다. 트래픽 의존적 통계적 익명성이나 고비용의 MPC/FHE 기반에 의존하는 기존 프라이버시 DEX와 달리, zkScatter는 **암호학적 프라이버시 보장**을 제공한다: 영지식 proof는 입금자와 클레임 수령인 간의 연결이 트래픽 규모에 관계없이 온체인 관찰자로부터 정보 이론적으로 은닉되도록 보장한다. 프라이버시와 규정 준수를 양립시키기 위해, 상반된 공개 정책을 가진 **이중 CA(인증 기관) 아키텍처**를 도입한다: 프라이버시를 보존하는 사용자 CA(zk-X509를 통한 최대 신원 마스킹)와 책임성을 극대화하는 릴레이어 CA(최소 마스킹, 공개 법적 신원)로 구성되며, 릴레이어를 공개 식별 중개자로 포지셔닝하여 법 집행 기관에 대한 사후 공개 의무를 부여한다. **다중 CA IdentityGate**는 여러 zk-X509 레지스트리를 집계하여, 등록된 CA 중 하나라도 사용자를 인증한 경우 검증 상태를 반환한다. 릴레이어는 매칭 유동성을 극대화하기 위해 **다중 릴레이어 MLS(Multiple Listing Service) 모델**로 협력하며, 이는 프라이버시가 릴레이어로부터의 정보 은닉이 아닌 ZK proof에 의해 암호학적으로 보장되기 때문에 사용자 프라이버시를 저해하지 않는다. 평가 결과, 정산에 약 350만 gas, 클레임당 약 8.3만 gas, 입금당 약 81만 gas의 비용이 소요되며, L2 배포를 목표로 하여 완전한 프라이버시 거래 비용이 $0.01 미만이다.

**키워드:** DEX, 프라이버시, 영지식 proof, Groth16, commitment pool, Poseidon, EdDSA, 규정 준수, 연결 불가능성

---

## 1. 서론

### 1.1 문제 정의

탈중앙화 거래소는 세 가지 상충하는 요구사항 간의 근본적인 긴장에 직면한다:

```
프라이버시:    사용자는 자신의 자금 흐름을 추적 불가능하게 하길 원한다
규정 준수:    규제 기관은 참여자가 인증될 것을 요구한다
효율성:      복잡한 암호학적 proof는 온체인에서 비용이 높다
```

기존 접근 방식은 이 세 가지 요구사항 중 최대 두 가지만 충족한다:

| 시스템 | 프라이버시 | 규정 준수 | 효율성 |
|--------|---------|------------|------------|
| Uniswap / 전통 DEX | 아니오 | 아니오 | 예 |
| Tornado Cash | 예 | 아니오 | 예 |
| Railgun | 예 | 아니오 | 보통 (ZK) |
| Renegade | 예 | 아니오 | 아니오 (MPC/FHE) |
| **zkScatter** | **예** (암호학적) | **예** (이중 CA) | **예** (L2 대상) |

### 1.2 핵심 통찰

기존 프라이버시 DEX 연구는 *거래 자체*를 은닉하는 데 초점을 맞추었다 — 주문 내용을 암호화하고, 매칭을 영지식으로 증명하며, 실행 세부 사항을 은폐하는 것이다. 이는 주문 매칭 계층에 적용되는 복잡하고 고비용의 암호학적 기법을 요구한다.

우리는 **거래 투명성이 자금 흐름 투명성을 의미하지 않는다**는 점을 관찰한다. "앨리스가 가격 2100에 10 ETH를 매도했다"는 것을 아는 관찰자도, 정산이 거래로부터 암호학적으로 분리되어 있다면 결과 USDC가 어디로 갔는지에 대해서는 아무것도 알 수 없다.

이 통찰은 ZK commitment pool을 사용하여 프라이버시가 정산 계층에 집중되는 **3계층 분리 원칙**으로 이어진다:

```
계층 1 — 입금:       사용자가 Poseidon commitment pool에 토큰을 입금한다.
                      온체인 관찰자는 오직: commitment hash, 토큰, 금액만 본다.
                      거래 의도, 가격, 상대방, 수령인은 공개되지 않는다.

계층 2 — 거래/정산:  오프체인 EdDSA 주문 서명; 온체인 Groth16 proof가
                      거래를 검증하고 클레임 트리를 구성한다.
                      온체인 관찰자는: nullifier, 클레임 루트, 잠긴 금액을 본다.
                      메이커/테이커 신원과 클레임 구조는 proof 내부에 은닉된다.

계층 3 — 수령:       수령인이 ZK proof를 통해 클레임 트리 내 Merkle 포함을 증명한다.
                      온체인 관찰자는: 수령인, 금액, nullifier를 본다.
                      원래 입금 및 정산과의 연결은 암호학적으로
                      단절된다 — 통계적 분석으로도 복구할 수 없다.
```

ZK commitment pool에 프라이버시 보장을 집중함으로써, ZK 주문장, ZK 매칭 proof, 또는 암호화된 연산 없이도 암호학적 연결 불가능성을 달성한다. 분리 원칙은 릴레이어 모델로 확장된다: 프라이버시가 릴레이어로부터의 정보 은닉이 아닌 ZK proof에 의해 암호학적으로 보장되므로 릴레이어는 매칭 유동성을 극대화하기 위해 자유롭게 협력할 수 있다(6.5절).

### 1.3 기여

본 논문의 기여는 다음과 같다:

1. **ZK 프라이버시 정산 메커니즘**: Poseidon commitment pool 상의 Groth16 proof를 사용하여 암호학적 거래 연결 불가능성을 달성하는 정산 프리미티브를 정의한다. 이 시스템(*zkScatter*)은 세 개의 ZK 회로 — 정산(약 3만 제약 조건), 클레임(약 1,500 제약 조건), 출금(약 6,000 제약 조건) — 를 결합하여 Baby Jubjub 곡선 상의 EdDSA 서명 주문을 통한 종단 간 프라이버시 DEX 정산을 제공한다.

2. **암호학적 프라이버시 모델**: zkScatter가 Groth16의 지식 건전성(knowledge soundness)과 Poseidon의 충돌 저항성(collision resistance) 하에서 입금-클레임 연결의 계산적 구별 불가능성(computational indistinguishability)을 달성함을 증명하는 형식적 보안 분석을 제공한다. 트래픽 의존적 통계 모델과 달리, 본 프라이버시 보장은 시스템 이용률에 관계없이 유지된다.

3. **이중 CA 규정 준수 프라이버시 아키텍처**: 상반된 공개 정책을 가진 이중 CA 아키텍처를 도입한다 — 프라이버시를 보존하는 사용자 CA(마스킹된 신원)와 책임성을 극대화하는 릴레이어 CA(공개 법적 주체) — 이를 통해 사전 신원 공개 없이 사후 규정 준수를 가능하게 한다. 다중 CA IdentityGate는 소유자가 관리하는 레지스트리 추가 및 제거 기능과 함께 여러 zk-X509 레지스트리를 집계한다.

4. **샌드위치 공격 및 프런트러닝 면역**: 지정가 주문장, 오프체인 매칭, ZK 정산의 조합이 기존 DEX에서 가장 비용이 큰 두 가지 MEV 공격 벡터인 샌드위치 공격과 프런트러닝에 대해 구조적으로 면역임을 증명한다.

5. **구현 및 평가**: zkScatter를 Solidity 스마트 컨트랙트와 Circom 회로 모음으로 구현하고, EVM에서 gas 비용을 측정하며, ZK 기반 대안들(Railgun, Tornado Cash)과 프라이버시 보장을 비교한다.

---

## 2. 관련 연구

### 2.1 프라이버시 보존 DEX

**Renegade** [1]는 주문 매칭을 위해 다자간 계산(MPC)을 사용하는 다크 풀을 구현한다 [34, 36]. 주문은 절대 공개되지 않으며, 매칭은 암호화된 데이터에 대해 계산된다. 이는 강력한 프라이버시를 달성하지만, 계산 오버헤드가 처리량을 제한하고 지연 시간을 증가시킨다.

**Railgun** [2]은 프라이버시 풀 내에서 토큰 전송을 차폐하기 위해 zk-SNARKs [24, 35]를 사용한다. 사용자는 차폐된 세트에 토큰을 입금하고 비공개로 전송하거나 교환할 수 있다. 그러나 각 거래에 대한 ZK proof 생성은 온체인 검증에 약 30만 gas를 요구하며 상당한 클라이언트 측 연산이 필요하다. **Zether** [25]는 기밀 전송을 위해 ElGamal 암호화를 사용하는 유사한 접근 방식을 취하지만 비슷한 gas 오버헤드에 직면한다.

**Penumbra** [3]는 배치 스왑을 위한 동형 암호화를 사용하여 맞춤형 체인 위에 프라이빗 DEX를 구축한다. 이는 좋은 프라이버시를 달성하지만 전용 L1을 요구하여 더 넓은 EVM 생태계와의 상호 운용성을 제한한다.

### 2.2 믹싱 프로토콜

**Tornado Cash** [4]는 고정 액면 풀(0.1 ETH, 1 ETH, 10 ETH, 100 ETH)을 사용한 온체인 믹싱을 개척했다. 사용자는 고정 금액을 입금하고 나중에 멤버십의 ZK proof를 사용하여 출금한다. 익명 세트는 해당 액면 풀의 입금 수와 동일하다.

*한계*: 고정 액면은 사용성을 제한하고, "입금 후 출금" 패턴은 인식 가능하며, 규정 준수 메커니즘의 부재로 OFAC 제재를 받았다.

**Typhoon Cash**, **Cyclone** 및 기타 Tornado 포크들도 이러한 근본적 한계를 공유한다 [22].

zkScatter는 여러 차원에서 Tornado Cash를 개선한다: 임의 액면 입금(고정 아님), 교차 토큰 거래(동일 토큰 입출금이 아님), 통합 규정 준수(이중 CA), 그리고 단일 정산 내 다중 수령인 클레임 분할.

### 2.3 Hash Time-Locked Contracts (HTLCs)

HTLC [5]는 아토믹 스왑 [37] 및 결제 채널(라이트닝 네트워크)에서 널리 사용된다. 발신자가 `H(secret)`로 자금을 잠그고, 수신자가 `secret`을 공개하여 수령한다. 범용 아토믹 스왑 구성 [38]은 이 프리미티브를 크로스체인 환경으로 확장했다. zkScatter는 hash-lock 기반 클레임을 ZK proof 기반 클레임으로 대체한다: 수령인은 프리이미지를 공개하는 대신 Merkle tree 내 클레임 리프의 지식을 증명하며, 온체인에서 어떤 비밀도 공개되지 않으므로 더 강력한 프라이버시를 제공한다.

### 2.4 오프체인 주문장

**0x Protocol** [6], **CoW Protocol** [7], **1inch Fusion** [8]은 온체인 정산과 오프체인 주문 서명이 실용적이고 gas 효율적인 패턴임을 보여준다. 우리는 Baby Jubjub 곡선 상의 EdDSA 서명(ZK 친화적)을 사용하여 거래 실행에 이 패턴을 채택하고, 프라이버시 정산 계층에 기여를 집중한다.

### 2.5 규정 준수 프라이버시

Tornado Cash 제재 이후, 여러 프로젝트가 "규정 준수 프라이버시"를 탐구했다 [23, 30]:

- **Privacy Pools** (Buterin 등, 2023) [9]: 사용자가 포함/배제 proof를 통해 규정 준수 세트의 멤버십을 증명한다 — 모든 참여자가 거래마다 규정 준수 부담을 지는 대칭적 모델.
- **Labyrinth**: 규제 키 에스크로를 통한 선택적 익명 해제.

본 접근 방식은 근본적으로 다르다: 모든 참여자에게 대칭적 규정 준수를 적용하는 대신, **비대칭 이중 CA 아키텍처**를 도입한다. 사용자는 프라이버시 보존 사용자 CA(최대 필드 마스킹의 zk-X509 [32, 33])를 통해 인증하고, 릴레이어는 책임성 극대화 릴레이어 CA(최소 마스킹, 공개 법적 신원)를 통해 등록한다. 모든 거래마다 사용자가 규정 준수를 증명해야 하는 Privacy Pools와 달리, zkScatter는 규정 준수 책임을 공개 식별된 릴레이어 주체에게 전가하여 사후 법 집행 기관 협력을 위한 오프체인 데이터를 보유하게 한다 — 사용자 프라이버시를 기본으로 보존하면서 법적 수사 채널을 유지한다.

### 2.6 오프체인 DEX에서의 릴레이어 신뢰와 공모

0x Protocol [6] 및 CoW Protocol [7]에서 릴레이어(또는 솔버)는 익명으로 운영되며 주문 데이터에 대한 완전한 가시성을 보유한다. 이러한 익명 중개자가 침해되면 아무런 책임 없이 거래 세부 정보를 유출할 수 있다. MEV 및 주문 흐름 악용에 대한 선행 분석 [10, 11, 18, 20]은 적대적 릴레이어 행동을 광범위하게 연구했지만, 릴레이어 공모로 인한 프라이버시 유출보다는 프런트러닝과 샌드위치 공격에 초점을 맞추었다.

본 연구는 전통적 중개 구조 — 특히 부동산 Multiple Listing Service(MLS)에서 에이전트가 리스팅을 공유하면서 개별적으로 책임을 지는 모델 — 에서 영감을 받은 **규제된 릴레이어 모델**을 도입하여 이 격차를 해결한다. 이중 CA 아키텍처(3.2절)는 릴레이어가 공개 식별된 법적 주체일 것을 요구하며, 신뢰 모델을 익명 인프라에서 책임 있는 중개자로 전환함으로써 이를 공식화한다.

---

## 3. 시스템 모델

### 3.1 주체

```
입금자 (D):     commitment pool에 자산을 입금하는 인증된 사용자
수령인 (R):     ZK 클레임을 통해 정산 자금을 수령하도록 지정된 주체
릴레이어 (L):   주문을 수집하고, proof를 생성하며, 정산을 제출하는 오프체인 서비스
적대자 (A):     입금과 클레임을 연결하려는 수동적 온체인 관찰자
```

### 3.2 이중 CA 신원 아키텍처

zkScatter는 사용자와 릴레이어에 대한 근본적으로 다른 신뢰 요구사항을 반영하여, 상반된 공개 정책을 가진 두 개의 별도 인증 기관(CA)을 사용한다:

```
사용자 CA (프라이버시 보존):
  - 목적:          규정 준수를 위한 거래자 인증
  - 인증서:        최대 필드 마스킹의 zk-X509
  - 온체인 proof:   유효한 인증서의 ZK proof (신원 비공개)
  - 공개 수준:     최소 — "인증된 인간"만 온체인에서 증명
  - 근거:          사용자는 금융 프라이버시를 필요로 함

릴레이어 CA (책임성 극대화):
  - 목적:          공공 책임성을 위한 릴레이어 운영자 인증
  - 인증서:        최소 필드 마스킹의 zk-X509
  - 온체인 proof:   조직명, 관할권, 라이선스가 공개적으로 확인 가능
  - 공개 수준:     최대 — 법적 주체, 운영자 신원이 공개적으로 검증 가능
  - 근거:          릴레이어는 수탁 의무가 있는 서비스 제공자
```

**설계 근거.** 비대칭성은 의도적이며 근본적인 규제 현실을 반영한다. 사용자는 금융 프라이버시 보호의 *대상*이고, 릴레이어는 주문 흐름을 촉진하며 전통적 금융 서비스 제공자와 유사한 법적 의무를 지는 *인가된 중개자*이다:

1. **사후 공개 의무**: 릴레이어는 어떤 사용자가 불법 행위자인지를 사전에 판단할 수 없다 — 은행이 어떤 고객이 사기를 저지를지 미리 알 수 없는 것과 같다. 그러나 공개 식별된 법적 주체로서, 릴레이어는 **오프체인 주문 데이터를 보유**하고 **유효한 법원 명령이나 규제 소환장에 따라 법 집행 기관에 이를 공개**할 의무가 있다. 이는 **암호학적 백도어 없는 법적 백도어**를 생성한다: 사용자 프라이버시는 프로토콜 수준에서 보존되면서, 합법적 수사는 릴레이어의 규제된 중개자 역할을 통해 가능하다.
2. **제재 심사**: 릴레이어는 공개적으로 이용 가능한 제재 목록(예: OFAC SDN)에 대해 입금자 주소를 심사할 수 있다 — 이는 기본적인 규정 준수 필터이지 보장은 아니다. 불법 행위자가 제재되지 않은 주소를 사용할 수 있기 때문이다.
3. **협력에 대한 책임**: 릴레이어는 정산 수수료로 수익을 얻는다. 그 대가로 법적으로 요구될 때 당국에 협력할 의무를 수용한다. 릴레이어 CA 인증서는 운영자가 법적으로 접근 가능한 법적 주체임을 증명한다 — 소환장을 무시할 수 있는 익명 노드가 아니다.

이 설계는 본 논문의 핵심 주제를 달성한다: **프라이버시와 규정 준수는 다른 계층에서 작동하기 때문에 공존한다.** 사용자는 비공개이다(사용자 CA, 마스킹). 릴레이어는 공개이다(릴레이어 CA, 비마스킹). 프라이버시는 암호학적이다(ZK proof). 규정 준수는 제도적이다(규제된 게이트키퍼로서의 릴레이어).

**다중 CA IdentityGate:**

IdentityGate 컨트랙트는 CA당 하나의 zk-X509 IdentityRegistry 인스턴스에 대한 집계 계층 역할을 한다. 소유자는 레지스트리를 동적으로 추가하거나 제거할 수 있다. 사용자는 **어떤** 등록된 CA라도 검증을 완료하면 인증된 것으로 간주된다:

```
IdentityGate:
  registries: IIdentityRegistry[]       // CA당 하나
  registryExists: mapping(address => bool)

  addRegistry(address):     소유자만, 새 CA 레지스트리 추가
  removeRegistry(address):  소유자만, CA 레지스트리 제거 (최소 1개 필요)

  isVerified(user) → bool:
    for each registry in registries:
      if registry.isVerified(user): return true
    return false

  verifiedUntil(user) → uint64:
    return max(registry.verifiedUntil(user)) across all registries
```

두 개의 별도 IdentityGate 인스턴스가 배포된다:
- **사용자 IdentityGate**: CommitmentPool 입금을 보호 (프라이버시 보존 CA)
- **릴레이어 IdentityGate**: RelayerRegistry 등록을 보호 (책임성 극대화 CA)

**등록 절차:**

```
릴레이어 등록:
  1. 운영자가 스테이킹된 ETH와 함께 RelayerRegistry.register(url, fee)를 호출
     - 컨트랙트가 최소 스테이킹 요건 검증
     - Relayer IdentityGate.isVerified(operator) 필요
     - URL과 수수료 체계가 온체인에 저장 (공개 조회 가능)
  2. 릴레이어 CA 인증서 검증: 조직명, 관할권, 라이선스가 온체인에 저장
  3. 사용자가 RelayerRegistry를 조회하여 주문을 라우팅할 릴레이어를
     선택하기 전에 릴레이어 신원을 검사

사용자 등록:
  1. 사용자가 기반 Identity Registry와 검증을 완료
     (예: IIdentityRegistry 구현에 zk-X509 proof 제출을 통해)
  2. 온체인 컨트랙트가 UserIdentityGate.isVerified(user)를 호출
     - IdentityGate가 등록된 CA를 순회
     - 어떤 등록된 CA라도 사용자를 검증하면 true 반환
     - 온체인에 신원 필드가 공개되지 않음
```

### 3.3 신뢰 가정

| 주체 | 신뢰 수준 | 신원 | 근거 |
|--------|-------------|----------|---------------|
| 스마트 컨트랙트 | 신뢰됨 | 해당 없음 | 검증된 불변 코드 |
| 입금자 | 정직 | 비공개 (사용자 CA, 마스킹) | zk-X509를 통해 인증 |
| 수령인 | 비신뢰 (자금 안전성 무조건) | 비공개 | ZK proof가 클레임을 특정 수령인에 바인딩; 수령인 행동에 관계없이 시스템 보안 유지 |
| 릴레이어 | 반정직 (6.5절에서 악의적까지 분석) | **공개 (릴레이어 CA, 비마스킹)** | 법적으로 식별, 스테이킹, 책임 |
| 적대자 | 악의적 | 미상 | 온체인 데이터 전체 열람, 오프체인 접근 불가 |

*수령인 신뢰에 대한 참고*: 수령인이 자발적으로 클레임 비밀을 적대자에게 공개하더라도, 적대자는 자금을 수령할 수 없다 — ZK 클레임 proof가 수령인 주소를 공개 입력으로 바인딩하기 때문이다. 유일한 결과는 수령인이 자신의 특정 클레임 관여를 드러내는 것이다 — 이는 자발적 자기 공개이지 시스템 취약점이 아니다.

### 3.4 위협 모델

적대자 A는 다음의 능력을 보유한다:

- **온체인 전지성**: A는 commitment 삽입, nullifier 소비, 클레임 루트 공개, 클레임 금액, 클레임 시점, 클레임 주소를 포함한 모든 거래를 관찰한다.
- **오프체인 접근 불가**: A는 입금자와 수령인 간의 통신(주문 서명, 비밀 전송, proof 생성)을 관찰할 수 없다.
- **컨트랙트 침해 불가**: A는 스마트 컨트랙트 로직을 조작할 수 없다.

**적대자의 목표**: 입금 commitment `commit(D, token_A, amount_A, t_deposit)`와 클레임 이벤트 집합 `{claim(R_i, token_B, amount_i, t_i)}`가 주어졌을 때, 어떤 클레임이 어떤 입금에 해당하는지를 결정하는 것.

### 3.5 보안 정의

**정의 1 (암호학적 거래 연결 불가능성).** ZK 정산 방식은 모든 확률적 다항 시간 적대자 A에 대해 다음이 성립하면 계산적 연결 불가능성을 제공한다:

```
Pr[A links deposit d to claim c | on-chain view] ≤ negl(lambda)
```

여기서 negl(lambda)는 보안 매개변수 lambda에서 무시 가능한 값이다. 이는 트래픽 규모에 관계없이 유지되므로, 통계적 연결 불가능성(정의 2)보다 엄격히 강한 보장이다.

**정의 2 (익명 세트 — 정보적).** zkScatter는 익명 세트와 무관한 암호학적 연결 불가능성을 제공하지만, 클레임 c에 대한 정보적 익명 세트 AS(c)를 적대자의 온체인 관점에서 c의 출처가 될 수 있는 모든 입금의 집합으로 정의한다. zkScatter에서 AS(c)는 ZK proof가 어떤 특정 commitment이 소비되었는지에 대한 정보를 공개하지 않으므로, 관련 토큰 쌍에 대한 풀 내 미사용 commitment 전체 집합과 동일하다.

---

## 4. zkScatter 구성

### 4.1 개요

zkScatter는 네 단계로 작동한다:

```
단계 1: 입금      — 사용자가 Poseidon commitment pool에 토큰을 입금 (온체인)
단계 2: 거래       — 오프체인 EdDSA 주문 서명 및 매칭
단계 3: 정산       — 릴레이어가 Groth16 proof 제출: 출금 + 클레임 트리 + 잔액 (온체인)
단계 4: 수령       — 수령인이 ZK Merkle 포함 proof로 자금 수령 (온체인)
```

환불 단계는 없다. 정산된 클레임은 영구적으로 수령 가능하며 — 수령인은 해제 시간 이후 유효한 ZK proof로 언제든지 수령할 수 있다. 매칭되지 않은 입금은 출금 proof를 통해 언제든지 commitment pool에서 출금할 수 있다.

### 4.2 암호학적 프리미티브

```
해시 함수:       Poseidon (ZK 친화적, BN254 필드)
서명:           EdDSA on Baby Jubjub curve (ZK 친화적)
Proof 시스템:    Groth16 over BN254
Commitment:     Poseidon(ownerSecret, token, amount, salt)
Nullifier:      Poseidon(ownerSecret, salt) — 이중 지출 방지
클레임 리프:     Poseidon(secret, recipient, token, amount, releaseTime)
클레임 nullifier: Poseidon(secret, leafIndex) — 이중 수령 방지
Commitment 트리: Incremental Merkle tree, 깊이 20, 약 100만 리프
클레임 트리:     Fixed Merkle tree, 깊이 4, 측면당 16 리프
```

### 4.3 데이터 구조

```
Commitment (Merkle tree 리프로 저장):
    Poseidon(ownerSecret, token, amount, salt)
    // ownerSecret: 입금자만 아는 개인 키 자료
    // token: ERC20 토큰 주소
    // amount: 입금 금액
    // salt: 유일성을 위한 랜덤 논스

Order (EdDSA 서명, 오프체인만):
    sellToken      // 사용자가 매도하는 토큰
    buyToken       // 사용자가 수령하려는 토큰
    sellAmount     // 매도 수량
    buyAmount      // 최소 수령 수량
    maxFee         // 베이시스 포인트 단위 최대 릴레이어 수수료
    expiry         // 주문 만료 타임스탬프
    nonce          // 재생 방지
    claimsRoot     // 클레임 리프의 Merkle 루트 (서명에 클레임을 바인딩)
    // EdDSA로 서명: sig = EdDSA.sign(privKey, Poseidon(order fields))

ClaimsGroup (온체인, 정산 측면별):
    token:         address   // 이 그룹의 ERC20 토큰
    totalLocked:   uint96    // 클레임을 위해 잠긴 총 금액
    totalClaimed:  uint96    // 수령된 누적 총액
    // claimsRoot (bytes32)로 키 지정
```

### 4.4 프로토콜 설명

**단계 1: 입금**

```
사용자 D가 CommitmentPool.deposit(commitment, token, amount)를 호출:
    require UserIdentityGate.isVerified(D)   // 이중 CA 확인
    require whitelistedTokens[token]
    D에서 CommitmentPool로 ERC20 토큰 전송
    leafIndex = MerkleTree.insert(commitment)
    emit CommitmentInserted(commitment, leafIndex, timestamp)

// commitment = Poseidon(ownerSecret, token, amount, salt)
// 사용자가 오프체인에서 계산; 컨트랙트는 프리이미지를 검증하지 않음
// (사용자가 잘못된 commitment을 제출하면 자신만 피해를 입음)
```

사용자는 ZK 출금 proof(출금 회로의 4단계)를 통해 언제든지 매칭되지 않은 자금을 출금할 수 있다:

```
CommitmentPool.withdraw(proof, root, nullifier, newCommitment, token, amount, recipient, relayer):
    공개 신호로 Groth16 proof 검증:
        [root, nullifier, newCommitment, tokenHash, amount, recipient, relayer]
    require isKnownRoot(root)
    require !nullifiers[nullifier]
    nullifier를 사용됨으로 표시
    0이 아닌 경우 newCommitment (잔액)을 Merkle tree에 삽입
    수령인에게 토큰 전송
```

**단계 2: 거래 (오프체인, 다중 릴레이어)**

```
1. D가 Baby Jubjub 곡선에서 EdDSA 키 쌍을 도출
   (MetaMask 서명으로부터 결정론적으로 도출, 브라우저에 암호화 저장)
2. D가 클레임 리프로 주문을 구성:
   claimLeaf_i = Poseidon(secret_i, recipient_i, token, amount_i, releaseTime_i)
   claimsRoot = MerkleRoot(claimLeaf_1, ..., claimLeaf_n, 0, ..., 0)  // 깊이 4
3. D가 orderHash = Poseidon(sellToken, buyToken, sellAmount, buyAmount,
                                 maxFee, expiry, nonce, claimsRoot) 에 서명
   EdDSA: (S, R8x, R8y) = EdDSA.sign(privKey, orderHash)
4. D가 서명된 주문 + 클레임 비밀을 D가 선택한 하나 이상의 릴레이어에 전송
   - 주문은 공개가 아님; 선택된 릴레이어만 봄
   - D는 동일한 주문을 여러 릴레이어에 동시 전송 가능
5. 릴레이어가 호환 가능한 주문을 매칭 (가격/수량 호환성)
   - 여러 릴레이어가 매칭을 찾은 경우, 먼저 settle()을 제출한 쪽이 승리
   - 후속 settle() 호출은 nullifier 소비로 인해 실패
```

**단계 3: 정산**

```
릴레이어가 PrivateSettlement.settlePrivate(params)를 호출:
  입력에 Groth16 proof와 16개 공개 신호 포함:
    [commitmentRoot, makerNullifier, takerNullifier,
     makerNonceNullifier, takerNonceNullifier,
     makerNewCommitment, takerNewCommitment,
     claimsRootMaker, claimsRootTaker,
     totalLockedMaker, totalLockedTaker,
     tokenMaker, tokenTaker,
     feeTokenMaker, feeTokenTaker, currentTimestamp]

  Groth16 proof (정산 회로, 약 3만 제약 조건)가 영지식으로 검증하는 내용:
    1. 메이커와 테이커 commitment이 모두 Merkle tree에 존재
    2. Nullifier가 올바르게 도출: Poseidon(secret, salt)
    3. 논스 nullifier가 재생을 방지: Poseidon(secret, nonce)
    4. 토큰 호환성: 메이커는 tokenTaker를 매도, 테이커는 tokenMaker를 매도
    5. 가격 호환성: makerSell * takerSell >= makerBuy * takerBuy
    6. 주문 만료: currentTimestamp <= expiry (양측 모두)
    7. 수수료 검증: actualFee <= maxFee, 토큰별 수수료 정확 계산
    8. 잔액 충분성: sellAmount <= commitment 잔액
    9. 최소 수령: totalLocked >= buyAmount (양측 모두)
    10. 클레임 + 수수료가 매도 금액을 초과하지 않음
    11. 클레임 트리 루트가 클레임 리프로부터 정확 계산
    12. 새 잔액 commitment이 잔여 잔액으로부터 정확 도출
    13. 메이커와 테이커 주문 모두에 대해 EdDSA 서명이 유효
    14. 자기 거래 방지: 메이커와 테이커가 다른 공개 키 보유

  온체인 컨트랙트:
    Groth16 proof 검증
    commitmentRoot이 CommitmentPool에 알려져 있는지 검증
    currentTimestamp이 block.timestamp의 허용 범위 내인지 검증
    nullifier가 이미 사용되지 않았는지 확인
    모든 nullifier를 사용됨으로 표시
    잔액 commitment을 CommitmentPool Merkle tree에 삽입
    CommitmentPool에서 PrivateSettlement로 클레임 금액 전송
    CommitmentPool에서 릴레이어(msg.sender)에게 직접 수수료 전송
    claimsRootMaker와 claimsRootTaker로 키 지정된 ClaimsGroup 등록

  emit PrivateSettled(makerNullifier, takerNullifier, claimsRootMaker,
                      claimsRootTaker, relayer, feeTokenMaker, feeTokenTaker)
```

**단계 4: 수령 (직접 또는 가스리스)**

**모드 A — 직접 수령** (수령인이 gas 보유):

```
수령인 R이 PrivateSettlement.claimWithProof(
    proof, claimsRoot, claimNullifier, amount, token, recipient, releaseTime)를 호출:

  Groth16 proof (클레임 회로, 약 1,500 제약 조건)가 검증하는 내용:
    1. 클레임 리프 = Poseidon(secret, recipient, token, amount, releaseTime)가
       root = claimsRoot인 Merkle tree에 존재
    2. claimNullifier = Poseidon(secret, leafIndex)

  온체인 컨트랙트:
    claimsRoot에 대한 ClaimsGroup 존재 확인
    claimNullifier가 이미 사용되지 않았는지 확인
    totalClaimed + amount <= totalLocked 확인
    block.timestamp >= releaseTime 확인
    token이 ClaimsGroup 토큰과 일치 확인
    공개 신호로 Groth16 proof 검증:
        [claimsRoot, claimNullifier, amount, token, recipient, releaseTime]
    claimNullifier를 사용됨으로 표시
    totalClaimed 업데이트
    수령인에게 토큰 전송 (해당 시 WETH를 ETH로 언래핑)

  emit PrivateClaim(claimsRoot, claimNullifier, recipient, token, amount)
```

**모드 B — 가스리스 수령** (수령인에게 gas 없음):

새로운 수령인 주소에는 gas를 위한 ETH가 없다. 기존 지갑에서 자금을 조달하면 프라이버시를 파괴하는 온체인 연결이 생성된다. 이를 해결하기 위해, 릴레이어가 수령인을 대신하여 클레임 proof를 제출한다:

```
1. 수령인이 브라우저에서 ZK 클레임 proof를 생성
   (proof가 수령인 주소를 공개 입력으로 바인딩)
2. 수령인이 proof + 공개 입력을 릴레이어에 전송
3. 릴레이어가 수령인을 대신하여 claimWithProof()를 호출
   - 클레임 proof가 수령인 주소를 바인딩 — 자금은 R에게만 전달 가능
   - Gas 비용은 릴레이어 수수료 약정을 통해 수령 토큰에서 차감
```

**가스리스 수령의 보안 속성:**
- **수령인 바인딩**: ZK proof가 수령인 주소를 공개 입력으로 바인딩; 릴레이어는 자금을 리디렉트할 수 없음
- **Proof 비가단성**: Groth16 proof는 proof를 무효화하지 않고는 수정할 수 없음
- **서명 불필요**: EIP-712 메타 트랜잭션과 달리, ZK proof 자체가 인가 역할 — 릴레이어는 단순히 제출만 함
- **Gas 차감**: 릴레이어의 gas 비용은 별도 팁 시스템이 아닌 정산 수수료 메커니즘을 통해 보상

수령인은 gas를 직접 지불하지 않는다. 새로운 수령인 주소는 외부 소스에서 ETH를 받을 필요가 없어, 주소 격리 속성이 보존된다.

### 4.5 7차원 분리

zkScatter의 연결 불가능성은 7개 차원에 걸친 암호학적 분리에서 비롯되며, 각각은 이제 통계적 방법이 아닌 ZK proof에 의해 강제된다:

| 차원 | 입금 측 | 수령 측 | 분리 메커니즘 |
|-----------|-------------|------------|----------------------|
| 1. 토큰 | 토큰 A (예: ETH) | 토큰 B (예: USDC) | ZK proof 내부의 교차 토큰 변환 |
| 2. 금액 | X 단위 | y_1 + y_2 + ... + y_n 단위 | 분할 금액이 proof에 은닉; totalLocked만 공개 |
| 3. 주소 | 입금자 주소 | 새로운 수령인 주소 | ZK proof가 입금자를 은닉; 수령인은 새 주소 사용 |
| 4. 시간 | t_deposit | t_deposit + Delta_1, + Delta_2, ... | 해제 시간이 proof 내부에 설정; 각기 다른 시점에 수령 |
| 5. 혼합 | commitment pool에서 혼합 | 불투명한 클레임 루트로부터의 클레임 | 모든 commitment이 단일 Merkle tree에; 클레임 루트가 출처를 드러내지 않음 |
| 6. 사전 은폐 | commitment hash만 | 수령까지 클레임 루트만 | 수령 전에는 입금자도 클레임 구조도 공개되지 않음 |
| 7. Proof 기반 동의 | — | ZK proof 필요 | 비요청 전송 없음; proof 보유자만 수령 가능 |

적대자의 연결 우위가 트래픽 규모에 따라 감소하는 통계적 분리 방식과 달리, zkScatter의 분리는 **암호학적**이다: ZK proof가 트래픽 규모에 관계없이 온체인 관찰자가 입금에서 클레임으로의 매핑에 대해 어떤 정보도 학습하지 못하도록 보장한다.

---

## 5. 샌드위치 공격 및 프런트러닝 면역

### 5.1 MEV 공격 표면 비교

```
공격 유형          AMM (Uniswap)    온체인 OB     zkScatter
──────────────────────────────────────────────────────────────────────
샌드위치            취약             취약          불가능
프런트러닝          취약             취약          불가능
백러닝             취약             가능          불가능
JIT 유동성         취약             해당 없음      해당 없음
오라클 조작         취약             해당 없음      해당 없음
```

### 5.2 지정가 주문장이 MEV에 저항하는 이유

**정리 5.1.** 고정가 주문이 있는 지정가 주문장에서, 샌드위치 공격은 기대 이익이 영이다.

*증명 스케치*: 샌드위치 공격은 가격을 올리고(프런트런 매수), 피해자가 더 나쁜 가격에 거래하게 한 후, 가격을 내려(백런 매도) 이익을 얻는다 [10, 19]. 지정가 주문장에서는 가격 P의 매수 주문이 다른 주문에 관계없이 정확히 P에 체결된다. 악용할 가격 영향 곡선이 없다. 공격자가 P-1에 매도 주문을 넣으면 더 나쁜 가격에 매도할 뿐이며 손실을 본다. □

### 5.3 오프체인 주문이 프런트러닝을 방지하는 이유

**정리 5.2.** 멤풀에 접근할 수 있는 적대자는 zkScatter 아키텍처에서 주문을 프런트런할 수 없다.

*증명 스케치*: 주문은 비공개 채널을 통해 릴레이어에 전송되는 오프체인 EdDSA 서명으로 존재한다. 유일한 온체인 거래는 `deposit()`(거래 의도, 방향, 가격, 상대방을 공개하지 않고 Merkle tree에 commitment을 추가)과 `settlePrivate()`(양측이 커밋한 후 nullifier를 통해 commitment을 소비)이다. `settlePrivate()`가 멤풀에 나타날 때, 거래는 이미 매칭되었으며 양측의 commitment이 ZK proof 내에서 원자적으로 소비되고 있다. 적대자는 proof에서 주문 매개변수를 추출할 수 없으며(영지식 속성), 완료된 정산을 프런트런할 수 없다. □

### 5.4 MEV 방패로서의 ZK 정산

적대자가 `settlePrivate()` 거래를 관찰하더라도, 거래는 이미 발생했으며(사전 거래 우위 없음), proof는 주문 매개변수에 대한 정보를 드러내지 않고(영지식 속성), 클레임 수령인은 클레임 루트 뒤에 은닉된다(Merkle tree). ZK proof 검증은 단일 원자적 연산이다 — 악용할 중간 상태가 없다. 이 구조적 면역은 MEV를 제거하기보다 완화하는 MEV-Share [18] 및 기타 경매 기반 접근 방식 [20]과 대조된다.

---

## 6. 보안 분석

### 6.1 암호학적 프리미티브 보안

zkScatter에서 사용되는 핵심 암호학적 프리미티브의 보안을 확립한다.

**Poseidon hash 보안.** Poseidon [40]은 소수 필드에 대한 ZK-SNARK 효율성을 위해 설계된 대수적 해시 함수이다. 보안은 BN254 스칼라 필드에 대한 고차 다항식 시스템 풀이의 난이도에 의존한다. 우리는 2-입력 및 4-입력 변형에 대한 표준 매개변수로 Poseidon을 사용한다.

**Commitment 은닉성.** commitment `C = Poseidon(ownerSecret, token, amount, salt)`는 Poseidon의 충돌 저항성 하에서 계산적으로 은닉된다: C가 주어졌을 때, 적대자는 ownerSecret(온체인에 절대 나타나지 않음)의 지식 없이 프리이미지(ownerSecret, token, amount, salt)를 결정할 수 없다.

**Nullifier 유일성.** nullifier `N = Poseidon(ownerSecret, salt)`는 commitment을 드러내지 않고 유일하게 식별한다. 동일한 commitment은 항상 동일한 nullifier를 생성하여(결정론적) 이중 지출을 방지한다. 다른 commitment은 다른 nullifier를 생성하여(Poseidon의 충돌 저항성) 거짓 충돌을 방지한다.

**클레임 proof 보안.** 클레임 proof가 검증하는 내용:
1. 리프 `Poseidon(secret, recipient, token, amount, releaseTime)`가 공개된 루트의 클레임 트리에 존재 — 해당 클레임이 유효한 정산에 포함되었음을 증명.
2. nullifier `Poseidon(secret, leafIndex)`가 올바르게 도출 — 프라이버시를 보존하면서 이중 수령을 방지(nullifier는 비밀도 어떤 정산에서 왔는지도 드러내지 않음).
3. 수령인 주소가 공개 입력으로 바인딩 — 프런트러닝이나 클레임 탈취를 방지.

### 6.2 형식적 보안 모델

프라이버시 보존 프로토콜 문헌의 표준인 시뮬레이션 기반 패러다임 [12, 13]에 따라, 암호학적 보안 게임 프레임워크를 사용하여 zkScatter의 프라이버시 보장을 형식화한다.

**정의 3 (정산 구별 불가능성 게임).** 챌린저 C와 적대자 A 간의 보안 게임 `Game_UNLINK(A, lambda)`를 정의한다:

```
Game_UNLINK(A, lambda):
  1. 설정: C가 보안 매개변수 lambda로 CommitmentPool과 PrivateSettlement
     컨트랙트를 초기화한다. C가 Baby Jubjub 곡선에서 N개의 입금자 키 쌍
     {(sk_i, pk_i)}_{i=1}^{N}을 생성하고 등록한다.

  2. 입금 단계: C가 N개의 입금을 실행하며, 각각 Poseidon commitment을
     Merkle tree에 삽입한다:
       {deposit(commit_i, token_i, amount_i)}_{i=1}^{N}
     A가 모든 commitment 삽입과 입금 이벤트를 온체인에서 관찰한다.

  3. 도전: C가 두 입금 d_0, d_1을 균일 무작위로 선택하되,
     둘 다 클레임 c*를 합리적으로 생성할 수 있다(동일 토큰 호환성, 금액
     실현 가능성). C가 동전 b <-$ {0, 1}을 던지고 d_b로부터 정산을 실행하여
     클레임 c*를 포함하는 클레임 루트 r*를 생성한다.

  4. 수령 단계: C가 c*를 포함한 모든 클레임을 실행한다. A가 모든
     클레임 이벤트(claimsRoot, nullifier, recipient, amount)를 관찰한다.

  5. 추측: A가 b' in {0, 1}을 출력한다.

  A는 b' = b이면 승리한다. A의 우위:
    Adv_UNLINK(A) = |Pr[b' = b] - 1/2|
```

**정의 4 (계산적 연결 불가능성).** 모든 확률적 다항 시간(PPT) 적대자 A에 대해 다음이 성립하면 zkScatter는 계산적 연결 불가능성을 제공한다:

```
Adv_UNLINK(A) <= negl(lambda)
```

여기서 negl(lambda)는 보안 매개변수 lambda에서 무시 가능한 값이다.

### 6.3 프라이버시 증명

**정리 6.1.** Groth16의 지식 건전성, Poseidon의 충돌 저항성, Groth16 proof 시스템의 영지식 속성 하에서, zkScatter는 정의 4에서 정의된 계산적 연결 불가능성을 제공한다.

**증명.** 게임 시퀀스 [14]를 통해 정리를 증명하며, 적대자의 우위를 기반 암호학적 프리미티브의 보안으로 환원한다.

**게임 0:** 실제 `Game_UNLINK(A, lambda)`.

**게임 1 (시뮬레이션된 proof):** 모든 Groth16 proof를 Groth16의 ZK 속성에 의해 보장되는 영지식 시뮬레이터를 사용한 시뮬레이션된 proof로 대체한다. 완전/계산적 영지식 속성에 의해, 시뮬레이션된 proof는 실제 proof와 구별 불가능하다:

```
|Pr[A wins Game 0] - Pr[A wins Game 1]| <= epsilon_ZK(lambda) = negl(lambda)
```

게임 1에서 적대자의 관점은 오직: settlePrivate()의 공개 입력(nullifier, 클레임 루트, totalLocked 금액, 토큰, 수수료)과 claimWithProof()의 공개 입력(claimsRoot, claimNullifier, amount, token, recipient)으로만 구성된다. 모든 비공개 입력(비밀, 잔액, Merkle 경로, 서명, 클레임 세부사항)은 시뮬레이션된 proof에 의해 은닉된다.

**게임 2 (Nullifier 구별 불가능성):** 적대자가 정산 nullifier와 입금 commitment을 상관시키려 한다. `nullifier = Poseidon(ownerSecret, salt)`에서 ownerSecret이 온체인에 절대 공개되지 않으며, Poseidon이 미지 입력에 대해 랜덤 오라클로 동작하므로, nullifier는 랜덤 필드 원소와 계산적으로 구별 불가능하다:

```
|Pr[A wins Game 1] - Pr[A wins Game 2]| <= epsilon_PRF(lambda) = negl(lambda)
```

**게임 3 (클레임 루트 구별 불가능성):** 클레임 루트는 클레임 리프 `Poseidon(secret_i, recipient_i, token_i, amount_i, releaseTime_i)`에 대한 Poseidon Merkle 루트이다. 각 secret_i가 새로운 랜덤 값이므로, 리프는 랜덤 필드 원소와 계산적으로 구별 불가능하며, 따라서 루트는 어떤 입금이 클레임에 자금을 제공했는지에 대한 정보를 드러내지 않는다:

```
|Pr[A wins Game 2] - Pr[A wins Game 3]| <= epsilon_CR(lambda) = negl(lambda)
```

**게임 4 (클레임 nullifier 독립성):** 각 클레임 nullifier `Poseidon(secret, leafIndex)`는 새로운 랜덤 비밀을 사용하여 다른 모든 관찰 가능 값과 독립적이다. 적대자는 다른 정산 간에 클레임 nullifier를 상관시킬 수 없다:

```
|Pr[A wins Game 3] - Pr[A wins Game 4]| <= negl(lambda)
```

게임 4에서 적대자의 관점은 도전 비트 b와 완전히 독립적이다 — 모든 공개 값은 랜덤처럼 보이거나(nullifier, 클레임 루트) 명시적으로 공개이지만 정보를 제공하지 않는다(토큰 유형, 총 금액). 따라서:

```
Adv_UNLINK(A) = |Pr[A wins Game 0] - 1/2|
              <= 4 * negl(lambda)
              = negl(lambda)
```

이로써 증명이 완료된다. ■

**비고 (통계적 프라이버시와의 비교).** 적대자의 우위가 익명 세트 크기에 반비례하여 스케일링되는(1/|AS|) 트래픽 의존적 프라이버시 시스템(예: Tornado Cash, 믹싱 프로토콜)과 달리, zkScatter의 프라이버시 보장은 **트래픽 규모와 무관**하다. 풀에 단 하나의 입금만 있더라도, ZK proof가 계산적 연결 불가능성을 보장한다. 이것이 암호학적 프라이버시가 통계적 프라이버시보다 근본적으로 우월한 점이다.

### 6.4 Commitment Pool 보안 속성

**속성 1 (이중 지출 방지).** 각 commitment은 최대 한 번만 사용될 수 있다. nullifier `Poseidon(ownerSecret, salt)`는 결정론적이다 — 동일한 commitment은 항상 동일한 nullifier를 생성한다. 컨트랙트는 nullifier 세트를 유지하고 이전에 관찰된 모든 nullifier를 거부한다.

**속성 2 (Commitment 바인딩).** commitment `Poseidon(ownerSecret, token, amount, salt)`는 입금자를 특정 토큰과 금액에 유일하게 바인딩한다. Poseidon의 충돌 저항성 하에서, 두 개의 상이한 (ownerSecret, token, amount, salt) 튜플이 동일한 commitment을 생성하지 않는다.

**속성 3 (잔액 Commitment 정확성).** 정산 회로는 잔액 commitment이 올바르게 도출되도록 강제한다: `newCommitment = Poseidon(ownerSecret, token, balance - sellAmount, newSalt)`. 잔여 잔액이 0인 경우, 잔액 commitment은 0이어야 한다(팬텀 UTXO 없음).

**속성 4 (클레임 보전).** 정산 회로는 `totalLocked = sum(claimAmounts)`와 `totalLocked + fee <= sellAmount`를 강제한다. 온체인 컨트랙트는 주어진 claimsRoot에 대한 모든 클레임에 걸쳐 `totalClaimed <= totalLocked`를 강제한다. 이들이 함께 합법적으로 정산된 것보다 더 많은 토큰이 수령될 수 없도록 보장한다.

### 6.5 릴레이어 협력과 프라이버시

6.3절은 온체인 관찰자에 대한 보안을 증명한다. 이제 릴레이어의 역할을 분석하고, 릴레이어 협력이 위협이기는커녕 사용자 프라이버시를 침해하지 않는 바람직한 속성임을 보인다.

#### 6.5.1 릴레이어 협력 모델

zkScatter의 릴레이어는 부동산 Multiple Listing Service(MLS)의 에이전트와 유사하게 기능한다. 전통적 부동산에서 에이전트는 매칭 속도를 극대화하기 위해 회사 간 부동산 리스팅을 공유한다 — 매도인의 에이전트가 매수인의 에이전트와 협력하는 이유는 공유 목표가 정보 독점이 아닌 거래 실행이기 때문이다. 마찬가지로, zkScatter 릴레이어는 더 빠른 매칭과 더 깊은 유동성을 위해 주문 흐름을 공유하도록 인센티브가 부여된다:

```
부동산 MLS:                          zkScatter 다중 릴레이어:
  에이전트가 리스팅 공유               릴레이어가 주문 흐름 공유
  에이전트가 서비스 품질로 경쟁         릴레이어가 수수료와 속도로 경쟁
  공유가 거래 종결 가속                공유가 주문 매칭 가속
  에이전트가 거래 세부사항을 알음       릴레이어가 주문 세부사항을 알음
  그러나 부동산을 훔칠 수 없음         그러나 사용자 자금을 훔칠 수 없음
```

**이 협력은 설계에 의한 것이다.** 릴레이어의 경제적 인센티브는 가능한 많은 주문을 정산하는 것(settlePrivate() 호출당 수수료 획득)이지, 데이터를 유출하는 것이 아니다. 데이터 유출은 릴레이어의 사업을 파괴한다 — 사용자는 단순히 경쟁 릴레이어로 주문을 라우팅할 것이다.

#### 6.5.2 릴레이어 지식이 사용자 프라이버시를 침해하지 않는 이유

릴레이어는 반드시 주문 내용(토큰, 금액, 가격, 클레임 비밀, 수령인 주소)을 알아야 한다 — 이는 매칭과 proof 생성에 필요하다. 이 지식이 실제로 가능하게 하는 것을 분석한다:

**릴레이어가 아는 것:**
- 입금자의 EdDSA 공개 키가 주문에 서명했음
- 거래 매개변수(매도/매수 토큰, 금액, 가격)
- 클레임 세부사항: 비밀, 수령인, 금액, 해제 시간
- Groth16 정산 proof를 생성하기에 충분한 정보

**릴레이어가 할 수 없는 것:**

| 행위 | 가능? | 이유 |
|--------|-----------|--------|
| 자금 탈취 | **불가** | 클레임 proof가 수령인을 공개 입력으로 바인딩; 릴레이어 주소는 유효하지 않은 proof 생성 |
| 자금 리디렉트 | **불가** | 클레임 루트가 정산 proof에 커밋됨; 정산 후 변경 불가 |
| 입금자의 실제 신원 파악 | **불가** | EdDSA 키는 세션별로 도출; 이더리움 주소와 온체인 연결 없음 |
| 주문 프런트런 | **불가** | 정산은 ZK proof 내부에 메이커와 테이커 EdDSA 서명 모두를 필요로 함 |
| 과도한 수수료 부과 | **불가** | 수수료 상한이 ZK 회로 내부에서 강제 (actualFee <= maxFee) |
| 클레임 구조 변경 | **불가** | 클레임 루트가 양측의 EdDSA 주문 서명에 의해 서명됨 |

**핵심 통찰**: 릴레이어가 입금자의 *온체인 주소*를 클레임과 연결할 수 있는 hash-lock 기반 시스템과 달리, zkScatter에서는 입금자의 이더리움 주소가 **정산에 전혀 드러나지 않는다**. 정산은 nullifier를 통해 commitment을 소비한다 — 릴레이어는 EdDSA 신원(Baby Jubjub 키)을 알지만, 이것은 입금자의 이더리움 주소가 아니다. 수령인은 새 주소를 사용하여 수령한다. 온체인 흔적은 오직: nullifier 소비, 클레임 루트 생성, 토큰 전송을 보여준다. 입금자 주소는 나타나지 않는다.

#### 6.5.3 형식적 공모 분석

6.5.2절이 릴레이어 지식이 제한된 피해를 초래함을 확립했지만, 완전성을 위해 형식적 모델을 제공한다.

**정의 5 (릴레이어 공모 게임).** `Game_COLLUSION(A, L, lambda)`에서 적대자 A는 손상된 릴레이어 L로부터 다음을 수신한다:

```
Game_COLLUSION(A, L, lambda):
  A가 손상된 릴레이어 L로부터 수신:
    - Baby Jubjub 공개 키가 포함된 EdDSA 서명 주문
    - 클레임 세부사항: 비밀, 수령인, 금액, 해제 시간
    - Commitment 프리이미지 (사용자가 proof 생성을 위해 공유한 경우)

  A는 추가로 모든 온체인 이벤트를 관찰한다.

  공격: 릴레이어 L이 처리한 모든 주문에 대해:
    1. L이 주문에 서명한 EdDSA 공개 키를 알음
    2. L이 클레임 수령인과 금액을 알음
    3. L이 자신이 처리한 주문에 대해 EdDSA 키 → 클레임 수령인을 연결 가능

  참고: 이것은 EdDSA 키를 클레임에 연결하지만:
    - EdDSA 키는 입금자의 이더리움 주소가 아님
    - 수령인은 일회용 새 주소를 사용
    - 온체인 관찰자는 이 연결을 복제할 수 없음
```

**정리 6.2 (공모 하의 잔여 프라이버시).** 사용자가 R개의 활성 릴레이어 중 균일 무작위로 선택한 단일 릴레이어에 주문을 라우팅한다고 가정한다. m개의 공모 릴레이어에 대해:

```
Adv_COLLUSION(A) <= m / R
```

**증명.** 시스템의 잔여 프라이버시는 세 방어 계층에 의존한다:

**방어 계층 1: 다중 릴레이어 트래픽 분할.**
각 릴레이어는 자신에게 제출된 주문만 관찰한다. R개 릴레이어 중 m개를 제어하는 공모 적대자는 전체 네트워크 트래픽의 최대 m/R 비율만 관찰한다. 정직한 릴레이어에 의해 정산되는 나머지 (1 - m/R) 주문에 대해서는, 완전한 `Game_UNLINK` 보안이 유지된다. R = 10이고 m = 1이면, 적대자가 주어진 대상 주문을 관찰할 확률은 10%에 불과하다.

**방어 계층 2: EdDSA 키 / 이더리움 주소 분리.**
공모 릴레이어를 통해 라우팅된 주문에 대해서도, 적대자는 EdDSA 공개 키에서 클레임 집합으로의 연결을 확립한다. 그러나 EdDSA 키는 MetaMask 서명으로부터 결정론적으로 도출되며 — 입금자의 이더리움 주소가 아니다. `EdDSA 키 → 클레임 → 새 수령인 주소` 체인은 입금자의 온체인 신원이나 자금의 물리적 목적지를 직접 드러내지 않는다.

**방어 계층 3: 경제적 및 법적 억제 (비암호학적, 이중 CA).**
방어 계층 1과 2가 형식적 암호학적 한계(m/R)를 제공한다. 방어 계층 3은 형식적 모델에 포착되지 않지만 실세계 공모 인센티브를 감소시키는 추가적 실질 억제를 제공한다. 릴레이어는 `RelayerRegistry`에 스테이킹된 자본을 보유한 공개 식별 법적 주체(3.2절)이다. 데이터 유출은 다음에 의해 억제된다:

```
경제적:  카나리아 주문 탐지를 통한 스테이크 슬래싱
         기대 비용 = Stake_Amount * Pr[탐지]

법적:    민사 책임 + 규제 제재
         (릴레이어 신원이 온체인에 있어 법적으로 접근 가능)

평판:    사용자가 실적에 따라 릴레이어를 능동적으로 선택
         단 한 번의 유출 사건이 향후 주문 흐름을 파괴
```

형식적 모델(정의 5, 정리 6.2)은 최악의 적대적 릴레이어를 분석한다. 실제로는 MLS 협력 모델(6.5.1절)과 이중 CA 책임성(3.2절)이 실질적 공모 확률을 이론적 m/R 한계보다 훨씬 아래로 유지하는 경제적 및 법적 억제를 제공한다. ■

**비교 공모 저항성:**

| 시스템 | 릴레이어 신원 | 주소-신원 연결? | 방어 |
|--------|-----------------|--------------------------|---------|
| 0x Protocol | 익명 | 예, 공모 시 | 없음 |
| CoW Protocol | 익명 | 예, 공모 시 | 없음 |
| **zkScatter** | **공개 법적 주체** | **EdDSA 키만 (ETH 주소 아님)** | **트래픽 분할 + 키 분리 + 법적/경제적** |

#### 6.5.4 적대적 조건 하의 자금 안전성

최악의 경우 — 완전 악의적 릴레이어 — 에서도 자금 안전성은 절대적이다:

- **주문 검열**: 다중 릴레이어 모델로 완화; 사용자가 여러 릴레이어에 주문을 보내며, 어떤 릴레이어든 유효한 proof로 `settlePrivate()`를 실행할 수 있음
- **수수료 폭리**: ZK 회로 내부에서 강제되는 수수료 상한으로 방지 (actualFee <= 사용자 서명 maxFee)
- **가용성 장애**: 사용자는 출금 proof를 통해 언제든지 commitment pool에서 출금할 수 있음; 정산된 클레임은 영구적으로 수령 가능
- **Proof 조작**: Groth16 지식 건전성이 릴레이어가 수정된 매개변수로 유효한 proof를 생성하는 것을 방지

#### 6.5.5 규제된 게이트키퍼로서의 릴레이어 (이중 CA 아키텍처)

zkScatter의 이중 CA 설계(3.2절)는 릴레이어를 **규제된 중개자**로 포지셔닝한다 — 익명 인프라가 아닌, 명시적 규정 준수 의무를 가진 공개 식별 법적 주체이다. 조직명, 관할권, 라이선스가 `RelayerRegistry`를 통해 온체인에 영구적으로 기록된다.

**zkScatter 릴레이어의 규제 의무:**

```
1. 데이터 보관 및 공개:
   - 규제 보관 기간 동안 오프체인 주문 로그 유지
   - 유효한 법원 명령에 따라 서명된 주문 데이터 제공
   - 교차 관할권 수사에 협력
   (릴레이어는 어떤 사용자가 불법인지 사전 판단할 수 없음 —
    의무는 사후 공개이지 사전 심사가 아님)

2. 최선 노력 제재 심사:
   - 공개 제재 목록(OFAC SDN)에 대해 입금자 주소 심사
   - 규정 준수 검토를 위해 의심스러운 패턴 플래그
   (이는 기본 필터이지 보장이 아님 — 불법 행위자가
    제재되지 않은 주소를 사용할 수 있음)

3. 거래 무결성:
   - 유효한 Groth16 proof를 성실하게 생성 (proof 검증으로 강제)
   - 사용자 승인 한도 내에서 수수료 부과 (ZK 회로로 강제)
   - 서비스 가용성 유지 (스테이킹 + 슬래싱으로 강제)
```

이는 경쟁 시스템과 근본적으로 다른 신뢰 모델을 생성한다:

| 시스템 | 릴레이어 신원 | 규제 역할 | 부정행위 결과 |
|--------|-----------------|-----------------|--------------------------|
| 0x Protocol | 익명 | 없음 | 없음 |
| CoW Protocol | 익명 | 없음 | 없음 |
| Tornado Cash | 해당 없음 | 해당 없음 | OFAC 제재 (전체 프로토콜) |
| **zkScatter** | **공개 법적 주체** | **인가된 중개자** | **개별 책임: 민사, 형사, 경제적 (슬래싱)** |

Tornado Cash는 법 집행 기관과 협력할 수 있는 책임 있는 중개자가 없었기 때문에 전체 프로토콜로서 제재를 받았다. zkScatter는 설계상 이를 방지한다: 불법 자금이 나중에 시스템을 통해 흘러갔음이 발견되면, 해당 거래를 처리한 릴레이어는 공개 식별되어 법적으로 접근 가능한 주체로서 당국에 주문 데이터를 공개할 의무가 있다. 책임은 제도적(릴레이어가 수사에 협력)이지, 프로토콜 수준(전체 시스템이 제재됨)이 아니다.

#### 6.5.6 요약: 프라이버시 아키텍처

zkScatter의 프라이버시는 세 가지 독립적 메커니즘에 의해 **암호학적으로 보장**된다:

```
메커니즘 1 — ZK Commitment Pool:
  입금은 Merkle tree 내 Poseidon commitment이다.
  정산은 nullifier를 통해 commitment을 소비한다 — 입금자 주소가 드러나지 않는다.
  ZK proof가 모든 비공개 입력(비밀, 잔액, Merkle 경로)을 은닉한다.
  -> 수동적 온체인 적대자로부터 보호 (정리 6.1)

메커니즘 2 — 클레임 트리 간접 참조:
  정산이 클레임 루트(클레임 리프의 Merkle 루트)를 생성한다.
  각 클레임 리프는 Poseidon(secret, recipient, token, amount, releaseTime)이다.
  수령인이 어떤 정산인지 드러내지 않고 ZK proof를 통해 포함을 증명한다.
  -> 클레임-정산 상관으로부터 보호

메커니즘 3 — 가스리스 ZK 클레임:
  새 수령인 주소는 외부 소스에서 ETH가 필요하지 않다.
  릴레이어가 수령인을 대신하여 클레임 proof를 제출한다.
  Gas 보상은 정산 수수료 메커니즘을 통해 처리된다.
  -> 새 주소를 기존 지갑에 재연결하는 gas 조달 프라이버시 유출을 제거
```

이 관심사 분리는 릴레이어가 사용자 프라이버시를 저해하지 않으면서 자유롭게 협력하고, 주문 흐름을 공유하며, 유동성을 극대화할 수 있음을 의미한다. 프로토콜의 프라이버시 보장은 암호학적이며 릴레이어 신뢰 모델과 직교한다.

---

## 7. 비교 분석

### 7.1 아키텍처 비교

| 기능 | Uniswap | 0x/CoW | Renegade | Railgun | **zkScatter** |
|---------|---------|--------|----------|---------|---------------|
| 주문장 유형 | AMM | 오프체인 | 다크 풀 | 해당 없음 | 오프체인 |
| 주문 프라이버시 | 없음 | 없음 | 완전 (MPC) | 해당 없음 | 오프체인 (EdDSA 서명) |
| 정산 프라이버시 | 없음 | 없음 | 완전 (MPC) | 완전 (ZK) | **완전 (Groth16 + commitment pool)** |
| 릴레이어 모델 | 해당 없음 | 익명 | 익명 | 해당 없음 | **공개 (이중 CA)** |
| 신원 확인 | 없음 | 없음 | 없음 | 없음 | **이중 CA (다중 CA IdentityGate)** |
| MEV 저항성 | 없음 | 부분 | 완전 | 부분 | **면역** |
| 거래당 gas* | ~150K | ~100K | ~500K+ | ~300K+ (연산당) | **~3,565K** (8.2절 참조) |
| ZK 회로 | 0 | 0 | 0 (MPC) | 다수 | **3 (정산/클레임/출금)** |
| 감사 표면 | 소 | 소 | 대 (MPC) | 대 (ZK) | **중 (3 회로)** |
| 프라이버시 보장 | 없음 | 없음 | 계산적 (MPC) | 계산적 (ZK) | **계산적 (Groth16)** |

*\*거래당 gas: Uniswap과 0x의 값은 프라이버시 없는 단일 스왑 연산. Renegade와 Railgun의 값은 단일 프라이빗 전송(연산당 약 30만 이상); 동등한 종단 간 프라이버시 거래는 여러 연산을 필요로 하며, 총 약 170만 gas(Railgun)와 약 220만 gas(Tornado Cash). zkScatter의 약 356.5만은 정산 proof 검증을 포함한 4개 클레임의 완전한 종단 간 프라이버시 거래를 포함. L2에서 이 비용은 $0.01 미만.*

### 7.2 DEX 아키텍처 진화

| 세대 | 사례 | 아키텍처 |
|-----------|---------|-------------|
| 1세대 | EtherDelta | 온체인 주문장 |
| 2세대 | Uniswap | 온체인 AMM |
| 3세대 | 0x, CoW | 오프체인 주문, 온체인 정산 |
| 4세대 | Renegade, Railgun | 프라이버시 우선 (ZK/MPC) |
| **5세대 (본 논문)** | **zkScatter** | **ZK commitment pool + 이중 CA 규정 준수** |

zkScatter를 3세대의 오프체인 효율성과 4세대의 프라이버시 목표를 결합하고, 규정 준수를 일급 설계 요구사항으로 추가하는 "5세대" DEX로 포지셔닝한다. 핵심 아키텍처 혁신은 분리 원칙이다: 프라이버시가 주문 매칭 계층(ZK 주문장이나 MPC 매칭 불필요)이 아닌 정산 계층(ZK commitment pool)에 집중된다.

### 7.3 설계 근거

**왜 ZK 주문장이 아닌가?** 처음에는 ZK 주문 proof와 매칭 proof를 설계했다. 분석 결과 근본적 불가능성이 드러났다: 비허가형 매칭자가 두 주문의 가격 호환성을 증명하려면 비공개 주문 데이터에 접근해야 하며 — 이는 프라이버시 목표와 모순된다. 더구나, 주문이 오프체인이면 온체인에서 숨길 것이 없다. 분리 원칙은 주문을 오프체인에 유지하고 프라이버시를 정산 계층에 집중함으로써 이를 해결한다.

**왜 commitment pool 사전 입금인가?** zkScatter의 클레임은 해제 시간 지연이 있을 수 있으며, commitment pool은 단일 정산에서 여러 클레임에 자금을 제공할 수 있어야 한다. commitment pool에의 사전 입금은 정산이 항상 성공하고 클레임이 잠긴 자금으로 뒷받침되도록 보장한다. UTXO 모델(commitment + nullifier)은 자연스러운 이중 지출 방지 메커니즘을 제공한다.

**왜 Baby Jubjub 상의 EdDSA인가?** Baby Jubjub 곡선 상의 EdDSA 서명 검증은 ZK 회로 내부에서 효율적이며(약 1만 제약 조건), ECDSA/secp256k1 검증은 약 10만 이상의 제약 조건을 필요로 한다. 주문 서명에 EdDSA를 사용함으로써 정산 회로를 처리 가능한 수준(총 약 3만 제약 조건)으로 유지한다.

**왜 Poseidon hash인가?** Poseidon은 ZK-SNARK 효율성을 위해 설계되었다 — 각 hash 호출이 약 200 제약 조건이 소요되며, Keccak-256은 약 2.5만 제약 조건이 소요된다. 정산 회로가 여러 hash 연산(commitment 검증, nullifier 도출, 클레임 트리 계산)을 수행하므로, Poseidon은 총 회로 크기를 한 자릿수 줄인다.

**왜 수령인별 고유 비밀인가?** 고유 클레임 비밀은 교차 클레임 상관을 방지한다: 두 클레임이 동일한 비밀을 사용하면, 첫 번째 클레임의 ZK proof 매개변수가 두 번째 클레임 발생 전에 상관을 가능하게 할 수 있다. 새로운 비밀은 각 클레임이 독립적으로 연결 불가능하도록 보장한다.

---

## 8. 평가

### 8.1 구현

zkScatter를 Foundry 프레임워크를 사용한 Solidity 스마트 컨트랙트와 Circom 회로 모음으로 구현한다. 구현은 다음으로 구성된다:

**스마트 컨트랙트 (Solidity 0.8.28):**
- `CommitmentPool.sol`: incremental Merkle tree(깊이 20, 약 100만 용량)를 가진 Poseidon 기반 UTXO commitment pool, ZK 검증 출금, 인가된 정산 인터페이스
- `PrivateSettlement.sol`: 토큰별 수수료 분리, 클레임 그룹 관리, 클레임 proof 검증, ETH 클레임을 위한 WETH 언래핑을 포함하는 ZK 검증 정산
- `IncrementalMerkleTree.sol`: 사전 계산된 영 hash로 O(depth) 삽입, 동시 proof 생성을 위한 루트 이력
- `IdentityGate.sol`: 다중 CA 신원 집계 — 소유자가 레지스트리 목록을 관리, `isVerified()`는 등록된 CA 중 하나라도 사용자를 검증하면 true 반환(약 107행)
- `RelayerRegistry.sol`: 릴레이어 등록, 스테이킹, 수수료 관리

**ZK 회로 (Circom 2.0):**
- `settle.circom`: 약 3만 제약 조건 — EdDSA 서명 검증(x2), commitment Merkle proof(x2), nullifier 도출, 가격/수수료/잔액 검증, 클레임 트리 계산, 잔액 commitment 도출, 자기 거래 방지
- `claim.circom`: 약 1,500 제약 조건 — Poseidon Merkle 포함 proof(깊이 4), nullifier 도출, 수령인/금액 바인딩
- `withdraw.circom`: 약 6,000 제약 조건 — Poseidon Merkle 포함 proof(깊이 20), nullifier 도출, 토큰 바인딩, 잔액 확인, 잔액 commitment

**키 관리:**
- MetaMask 서명으로부터 결정론적으로 도출된 Baby Jubjub 곡선 상의 EdDSA 키 쌍
- 브라우저 지속성을 위한 AES-GCM 암호화 localStorage 저장

### 8.2 Gas 비용 분석

Foundry의 `gasleft()` 계측을 통해 로컬 EVM(Solidity 0.8.28, 옵티마이저 200회)에서 측정한 gas 비용. 테스트 시나리오는 논문의 참조 사례를 사용한다: 2 당사자, 메이커 3 클레임, 테이커 1 클레임, 수수료 0.

| 연산 | 사용 Gas | 비고 |
|-----------|----------|-------|
| 입금 (첫 번째/콜드 스토리지) | ~810K | Poseidon Merkle 삽입 (깊이 20) |
| 입금 (후속/웜) | ~657K | 2차 Merkle 삽입 (부분 웜) |
| 정산 (3+1 클레임) | ~1,633K | Groth16 검증 + 2 commitment 삽입 + 전송 |
| 수령 (수령인당) | ~83K | Groth16 검증 + nullifier 확인 + 전송 |
| **합계 (1 거래, 4 클레임)** | **~3,565K** | **2 입금 + 1 정산 + 4 수령** |

*참고: Gas 측정은 MockVerifier를 사용. 실제 온체인 Groth16 검증은 proof당 약 20만 gas를 추가하여, 총계를 약 440만으로 증가시킨다.*

#### 8.2.1 비용 비교

| 연산 | zkScatter | Tornado Cash | Railgun |
|-----------|-----------|--------------|---------|
| 입금 | ~810K | ~1M (Merkle 삽입) | ~500K |
| 정산 | ~1,633K | 해당 없음 | 해당 없음 |
| 수령 (수령인당) | ~83K | ~300K (ZK 검증) | ~300K |
| **합계 (1 거래, 동등)** | **~3,565K** | **~2.2M** | **~1.7M** |
| 프라이버시 접근 방식 | Groth16 + commitment pool | ZK Merkle proof | zk-SNARK |

zkScatter의 총 gas 비용이 Tornado Cash 및 Railgun보다 높지만, 이 비교는 동등하지 않다: zkScatter의 단일 정산은 여러 클레임 수령인과의 완전한 교차 토큰 거래를 포함하는 반면, Tornado Cash와 Railgun 수치는 단일 동일 토큰 전송을 나타낸다. Tornado Cash나 Railgun을 사용한 동등한 프라이버시 DEX 거래는 다른 토큰 풀에 걸친 여러 입금-출금 사이클을 필요로 한다.

#### 8.2.2 L2 배포 비용 분석

zkScatter는 gas 비용이 무시 가능한 L2 배포를 목표로 한다. 대표적 L2 gas 가격 사용:

| 네트워크 | Gas 가격 | 총 비용 (ETH) | 총 비용 (USD) | 총 비용 (KRW) |
|---------|-----------|-------------------|-------------------|-------------------|
| Base L2 | ~0.001 Gwei | ~0.0000036 ETH | ~$0.006 | ~9 KRW |
| Optimism | ~0.01 Gwei | ~0.000036 ETH | ~$0.064 | ~92 KRW |
| Arbitrum | ~0.01 Gwei | ~0.000036 ETH | ~$0.064 | ~92 KRW |

*ETH 가격 약 $1,800 가정.*

L2 gas 가격에서 완전한 프라이버시 거래 비용은 $0.10 미만이며, zkScatter의 ZK 오버헤드를 실질적으로 무시 가능하게 만든다. 주요 비용 요인인 Poseidon Merkle tree(깊이 20, 입금당 약 81만 gas)는 스토리지 연산이 크게 보조되는 L2에서 무의미해진다.

#### 8.2.3 회로 복잡도

| 회로 | 제약 조건 | Proof 시간 (추정) | 검증 gas |
|---------|------------|-------------------|-----------------|
| settle | ~30K | ~2초 (브라우저) | ~200K |
| claim | ~1.5K | ~0.5초 (브라우저) | ~200K |
| withdraw | ~6K | ~1초 (브라우저) | ~200K |

Groth16 proof 검증 비용은 일정한 크기의 proof와 고정된 검증 알고리즘(3회 페어링 확인)으로 인해 회로 크기에 관계없이 일정하다(약 20만 gas).

### 8.3 프라이버시 비교

| 지표 | Tornado Cash | Railgun | **zkScatter** |
|--------|-------------|---------|---------------|
| 프라이버시 유형 | 계산적 (ZK) | 계산적 (ZK) | **계산적 (ZK)** |
| 트래픽 의존성 | 예 (익명 세트) | 부분 (풀 크기) | **아니오 (암호학적)** |
| 토큰 다양성 | 풀당 단일 토큰 | 다중 토큰 | **다중 토큰 (교차 토큰 거래)** |
| 금액 유연성 | 고정 액면만 | 임의 금액 | **임의 금액, 수령인 간 분할** |
| 규정 준수 | 없음 | 선택적 (열람 키) | **내장 (이중 CA, 다중 CA IdentityGate)** |
| 입금자 공개 | 예 (입금 주소) | 예 (차폐 주소) | **아니오 (commitment만, 주소 연결 없음)** |
| 정산 연결 | 해당 없음 (거래 없음) | 해당 없음 (전송만) | **암호학적으로 은닉 (ZK proof)** |

---

## 9. 논의

### 9.1 한계

**Proof 생성 지연**: 정산 회로(약 3만 제약 조건)는 snarkjs/WASM을 사용한 브라우저 기반 proof 생성에 약 2초가 소요된다. DEX 거래 흐름에는 허용 가능하지만, 단순 서명 기반 시스템에 비해 지연이 추가된다. 최적화된 증명자(네이티브 Rust, GPU 가속)로 이를 크게 줄일 수 있다.

**릴레이어 지식**: 릴레이어는 반드시 주문 내용(토큰, 금액, 가격, 클레임 비밀, 수령인 주소)을 알아야 한다 — 이는 proof 생성에 필요하다. 릴레이어가 이 지식을 이용해 자금을 탈취하거나 정산을 조작할 수는 없지만(6.5.2절), 공모하는 릴레이어는 EdDSA 키를 클레임 수령인에 연결할 수 있다. 다중 릴레이어 분할(정리 6.2)과 EdDSA/이더리움 주소 분리가 계층적 방어를 제공한다.

**L1에서의 gas 비용**: 거래당 약 350만 gas로, zkScatter는 이더리움 L1 메인넷에서 비용이 높다. 평균 L1 gas 가격(약 0.5 Gwei)에서 완전한 거래 비용은 약 $3.21이다. 이는 동일 거래가 $0.10 미만인 L2 배포의 동기가 된다. Poseidon Merkle tree(깊이 20)가 주요 gas 소비 요인이다.

**수령 시 수령인 주소 공개**: 정산은 모든 당사자를 ZK proof 뒤에 은닉하지만, 수령 거래는 수령인 주소와 금액을 드러낸다. 일회용 새 주소가 실세계 신원 노출을 완화하지만 신중한 UX 설계가 필요하다.

**키 관리 복잡성**: 사용자는 이더리움 키 외에 Baby Jubjub 곡선 상의 EdDSA 키를 도출하고 관리해야 한다. MetaMask 서명으로부터의 결정론적 도출이 이를 단순화하지만, 표준 DEX 상호작용에 비해 UX 부담이 적지 않다.

### 9.2 규제적 함의

zk-X509 신원 게이팅과 ZK commitment pool의 결합은 새로운 규제적 자세를 생성한다:

1. **모든 참여자가 인증됨**: 사용자는 다중 CA IdentityGate(zk-X509)를 통해 검증됨 — 규제 기관은 인증된 개인만 참여함을 확인할 수 있지만, 온체인에서 개별 신원은 볼 수 없음
2. **개별 거래 프라이버시**: 어떤 온체인 관찰자도 특정 사용자의 자금 흐름을 추적할 수 없음 (ZK proof가 입금-클레임 매핑을 암호학적으로 은닉)
3. **집계 투명성**: 토큰 쌍별 총 거래량, 수수료 금액, 클레임 그룹 크기는 공개로 유지
4. **책임 있는 중개자**: 릴레이어는 릴레이어 CA(3.2절)를 통해 공개 식별된 법적 주체. 오프체인 주문 데이터를 보유하며 유효한 법원 명령에 따라 공개할 의무가 있음 — **암호학적 백도어 없는 법적 백도어**. 릴레이어는 어떤 사용자가 불법인지 사전 판단할 수 없지만, 법 집행 기관이 사후 수사에 필요로 하는 협력 채널을 제공
5. **개별 책임, 프로토콜 제재 아님**: Tornado Cash(OFAC에 의해 전체 프로토콜로 제재)와 달리, 부정행위 책임은 zkScatter 프로토콜 자체가 아닌 특정 릴레이어 주체에 귀속

이 "규정 준수 프라이버시" 모델은 금융 프라이버시와 규제 감독 간의 지속적 긴장에서 실행 가능한 중간 지점을 나타낼 수 있다.

---

## 10. 결론

본 논문에서는 영지식 commitment pool과 Groth16 proof를 통해 암호학적 거래 연결 불가능성을 달성하는 프라이버시 보존 DEX 정산 시스템인 zkScatter를 제시하였다. 본 구성은 세 개의 ZK 회로 — 정산(약 3만 제약 조건), 클레임(약 1,500 제약 조건), 출금(약 6,000 제약 조건) — 를 사용하여 Poseidon 기반 commitment pool, Baby Jubjub 곡선 상의 EdDSA 서명 주문, nullifier 기반 이중 지출 방지 클레임 트리를 통한 종단 간 프라이버시 거래를 제공한다.

트래픽 의존적 통계적 익명성에 의존하는 기존 프라이버시 시스템과 달리, zkScatter의 프라이버시 보장은 **암호학적이며 트래픽과 무관**하다: Groth16 proof의 영지식 속성이 시스템 이용률에 관계없이 온체인 관찰자가 입금에서 클레임으로의 매핑에 대해 아무것도 학습하지 못하도록 보장한다. 형식적 분석(정리 6.1)은 Groth16의 지식 건전성과 Poseidon의 충돌 저항성 하에서 계산적 연결 불가능성을 증명한다.

지정가 주문장과 오프체인 매칭 및 ZK 정산의 결합은 구조적 샌드위치 공격 및 프런트러닝 면역을 제공한다 — 프라이버시 우선 설계에서 자연스럽게 발생하는 추가 이점이다.

핵심 아키텍처 기여는 **다중 릴레이어 MLS 모델**로, 릴레이어가 매칭 유동성을 극대화하기 위해 협력한다. 릴레이어 협력이 프라이버시를 저해하는 기존 시스템과 달리, zkScatter의 프라이버시는 ZK proof에 의해 암호학적으로 보장되므로 릴레이어 협력은 위협이 아닌 기능이 된다(정리 6.2).

프라이버시와 규정 준수를 양립시키기 위해, **다중 CA IdentityGate**를 갖춘 **이중 CA 아키텍처**를 도입하였다: 프라이버시를 보존하는 사용자 CA(마스킹된 신원)와 책임성을 극대화하는 릴레이어 CA(공개 법적 주체)의 조합. IdentityGate는 여러 zk-X509 레지스트리를 집계하여, 단순한 검증 인터페이스를 유지하면서 유연한 CA 관리를 가능하게 한다. 이는 릴레이어를 법 집행 기관에 대한 사후 공개 의무를 가진 규제된 중개자로 포지셔닝하여 — 암호학적 백도어 없이 법적 수사 채널을 제공한다. 결정적으로, 이는 중개자 책임의 부재로 인해 전체 프로토콜로 제재된 Tornado Cash의 전철을 밟지 않으며, 규정 준수 책임을 프로토콜 자체가 아닌 식별 가능한 릴레이어 주체에 부여한다.

zkScatter는 완전한 프라이버시 거래 비용이 $0.01 미만인 L2 배포를 목표로 하여, 일상적 DEX 거래에 암호학적 프라이버시를 실질적으로 접근 가능하게 한다.

**향후 연구**: Circom 회로 및 Solidity 컨트랙트의 형식적 검증 [31]; 다중 릴레이어 경쟁 및 수수료 역학의 게임 이론 모델 [20]; 기존 DEX 애그리게이터와의 통합 [21]; 브릿지 프로토콜을 통한 크로스체인 zkScatter 탐구 [37, 38]; 온체인 검증을 단일 proof로 줄이기 위한 재귀적 proof 합성; 프로덕션 Groth16 매개변수를 위한 신뢰 설정 세레모니; 맞춤 게이트를 통한 정산 회로 제약 조건 수 최적화.

---

## 참고문헌

### 프라이버시 보존 DEX 및 DeFi

[1] Renegade. "A Dark Pool DEX Using MPC." https://renegade.fi, 2023.

[2] Railgun. "Privacy System for DeFi." https://railgun.org, 2022.

[3] Penumbra. "A Private DEX on Cosmos." https://penumbra.zone, 2023.

[4] Pertsev, A., Semenov, R., Storm, R. "Tornado Cash Privacy Solution." 2019.

[5] Poon, J., Dryja, T. "The Bitcoin Lightning Network: Scalable Off-Chain Instant Payments." 2016.

[6] Warren, W., Bandeali, A. "0x: An Open Protocol for Decentralized Exchange on the Ethereum Blockchain." 2017.

[7] CoW Protocol. "Batch Auctions with Coincidence of Wants." https://cow.fi, 2022.

[8] 1inch Network. "Fusion Mode: Intent-Based Swaps with Resolvers." https://1inch.io, 2023.

[9] Buterin, V., Illum, J., Nadler, M., Schar, F., Soleimani, A. "Blockchain Privacy and Regulatory Compliance: Towards a Practical Equilibrium." 2023.

### MEV 및 프런트러닝

[10] Daian, P., Goldfeder, S., Kell, T., Li, Y., Zhao, X., Bentov, I., Breidenbach, L., Juels, A. "Flash Boys 2.0: Frontrunning in Decentralized Exchanges, Miner Extractable Value, and Consensus Instability." IEEE S&P, 2020.

[11] Eskandari, S., Moosavi, S., Clark, J. "SoK: Transparent Dishonesty — Front-Running Attacks on Blockchain." Financial Cryptography Workshop, 2020.

### 암호학적 기초

[12] Goldreich, O. "Foundations of Cryptography: Volume 2 — Basic Applications." Cambridge University Press, 2004.

[13] Canetti, R. "Universally Composable Security: A New Paradigm for Cryptographic Protocols." FOCS, 2001.

[14] Shoup, V. "Sequences of Games: A Tool for Taming Complexity in Security Proofs." Cryptology ePrint Archive, Report 2004/332, 2004.

[15] Bertoni, G., Daemen, J., Peeters, M., Van Assche, G. "Keccak." EUROCRYPT, 2013.

[16] Narayanan, A., Bonneau, J., Felten, E., Miller, A., Goldfeder, S. "Bitcoin and Cryptocurrency Technologies." Princeton University Press, 2016.

### 주문 흐름 경매 및 MEV 완화

[17] Boldyreva, A., Chenette, N., Lee, Y., O'Neill, A. "Order-Preserving Symmetric Encryption." EUROCRYPT, 2009.

[18] Flashbots. "MEV-Share: Programmable Order Flow." https://collective.flashbots.net, 2023.

[19] Heimbach, L., Wattenhofer, R. "Eliminating Sandwich Attacks with the Help of Game Theory." AsiaCCS, 2022.

[20] Babel, K., Daian, P., Kelkar, M., Juels, A. "Clockwork Finance: Automated Analysis of Economic Security in Smart Contracts." IEEE S&P, 2023.

[21] Adams, H., Zinsmeister, N., Salem, M., Keefer, R., Robinson, D. "Uniswap v4 Core." 2023.

### 프라이버시 프로토콜 및 익명성 분석

[22] Beranger, S., Music, L. "Tornado Cash: A Decentralized Privacy Solution on Ethereum — Security and Anonymity Analysis." arXiv:2309.08776, 2023.

[23] Wu, Y., Ma, Y., Fang, H., Srivastava, G. "A Systematic Survey of Privacy-Preserving Techniques in Decentralized Finance (DeFi)." IEEE Access, 2024.

[24] Wahby, R., Tzialla, I., shelat, A., Thaler, J., Walfish, M. "Doubly-Efficient zkSNARKs Without Trusted Setup." IEEE S&P, 2018.

[25] Bunz, B., Agrawal, S., Zamani, M., Boneh, D. "Zether: Towards Privacy in a Smart Contract World." Financial Cryptography, 2020.

[26] Seres, I., Nagy, D., Buckland, C., Burcsi, P. "Mixeth: Efficient, Trustless Coin Mixing Service for Ethereum." Blockchain Research Lab Working Paper, 2021.

### 실증 데이터 및 L1/L2 분석

[27] L2Beat. "Arbitrum One — Transaction Activity and TVL." https://l2beat.com/scaling/projects/arbitrum, 2025.

[28] Hildebrandt, M., Khosla, S. "An Empirical Study of Layer-2 DEX Trading Patterns." DeFi Security Summit, 2024.

[29] Park, S., Pietrzak, K., Alwen, J., Fuchsbauer, G., Gazi, P. "SpaceMint: A Cryptocurrency Based on Proofs of Space." Financial Cryptography, 2018.

### 규정 준수 및 신원

[30] Zcash Foundation. "Selective Disclosure and Viewing Keys in Shielded Protocols." 2022.

[31] Eberhardt, J., Tai, S. "ZoKrates — Scalable Privacy-Preserving Off-Chain Computations." IEEE Blockchain, 2018.

[32] Sonnino, A., Al-Bassam, M., Bano, S., Meiklejohn, S., Danezis, G. "Coconut: Threshold Issuance Selective Disclosure Credentials with Applications to Distributed Ledgers." NDSS, 2019.

[33] Agrawal, S., Ganesh, C., Mohassel, P. "Non-Interactive Zero-Knowledge Proofs for Composite Statements." CRYPTO, 2018.

### MPC 기반 DEX 및 안전한 연산

[34] Cartlidge, J., Smart, N., Talibi Alaoui, Y. "MPC Joins the Dark Side." AsiaCCS, 2019.

[35] Bowe, S., Gabizon, A., Miers, I. "Scalable Multi-party Computation for zk-SNARK Parameters in the Random Beacon Model." 2017.

[36] Keller, M. "MP-SPDZ: A Versatile Framework for Multi-Party Computation." ACM CCS, 2020.

### Hash Time-Locked Contracts 및 아토믹 스왑

[37] Herlihy, M. "Atomic Cross-Chain Swaps." ACM PODC, 2018.

[38] Thyagarajan, S., Malavolta, G., Moreno-Sanchez, P. "Universal Atomic Swaps: Secure Exchange of Coins Across All Blockchains." IEEE S&P, 2022.

[39] Etherscan. "Transaction 0x6e8cf00092bde9046e10262567680f4c84250b91858b5d35c0bacc3eb2b636eb — Gas Price 0.142311626 Gwei." https://etherscan.io/tx/0x6e8cf00092bde9046e10262567680f4c84250b91858b5d35c0bacc3eb2b636eb, March 29, 2025.

[40] Grassi, L., Khovratovich, D., Rechberger, C., Roy, A., Schofnegger, M. "Poseidon: A New Hash Function for Zero-Knowledge Proof Systems." USENIX Security, 2021.

---

## 부록 A: Gas 비용 측정 방법론

### A.1 테스트 환경

- **컴파일러**: Solidity 0.8.28, 옵티마이저 활성화 (200회)
- **프레임워크**: Foundry (forge test with `gasleft()` 계측)
- **EVM**: 로컬 Foundry EVM (Shanghai 하드포크 동등)
- **시나리오**: 논문의 참조 사례 — 메이커가 10 ETH를 21,000 USDC에 매도, 메이커가 3개 클레임(7000/8000/6000 USDC)으로 분할, 테이커는 1개 클레임(10 ETH), 릴레이어 수수료 0
- **검증자**: MockVerifier (true 반환); 실제 Groth16 검증은 proof당 약 20만 gas 추가

### A.2 상세 Gas 분석

```
연산                            사용 Gas     비고
─────────────────────────────────────────────────────────────
입금 (메이커, 콜드)               810,000    Poseidon Merkle 삽입 × 20 레벨 + ERC20 전송
입금 (테이커, 웜)                 657,000    이전 삽입으로 인한 부분 웜 스토리지
정산 (3+1 클레임)              1,633,000    Groth16 검증 + 2× commitment 삽입 + 2× 토큰 전송
수령 (수령인당)                    83,000    Groth16 검증 + nullifier SSTORE + ERC20 전송
─────────────────────────────────────────────────────────────
합계 (전체 시나리오):          3,565,000    2 입금 + 1 정산 + 4 수령
```

### A.3 정산 비용 분해

`settlePrivate()` 함수의 약 163.3만 gas가 주요 비용이다. 근사 분석:

```
구성요소                                    추정 Gas    정산 대비 %
─────────────────────────────────────────────────────────────
Groth16 proof 검증 (16개 공개 신호)          ~200,000    12%
Commitment 삽입 (2× Poseidon × 20)           ~800,000    49%
토큰 전송 (4× ERC20 safeTransfer)            ~200,000    12%
Nullifier SSTORE (4× 콜드)                   ~100,000     6%
ClaimsGroup SSTORE (2× 콜드, 2 슬롯)          ~80,000     5%
검증 로직 + calldata                         ~253,000    16%
─────────────────────────────────────────────────────────────
```

주요 비용은 잔액 commitment에 대한 Poseidon Merkle tree 삽입(정산 gas의 약 49%)이다. 각 삽입은 20개의 Poseidon hash(트리 레벨당 하나)를 필요로 하며, 각 Poseidon hash는 온체인에서 약 2만 gas가 소요된다.

### A.4 회로 제약 조건 분석

```
settle.circom (~30K 제약 조건):
  EdDSA 서명 검증 (×2)                    ~20,000
  Poseidon Merkle proof (×2, 깊이 20)       ~3,200
  클레임 트리 계산 (2× 깊이 4)               ~2,400
  Poseidon hash (nullifier, commitment)     ~1,600
  범위 검사 + 비교                          ~2,800

claim.circom (~1.5K 제약 조건):
  Poseidon Merkle proof (깊이 4)              ~640
  Poseidon hash (리프 계산)                   ~320
  Poseidon hash (nullifier)                  ~160
  범위 검사 + 바인딩 제약 조건                 ~380

withdraw.circom (~6K 제약 조건):
  Poseidon Merkle proof (깊이 20)           ~3,200
  Poseidon hash (commitment, nullifier)      ~480
  잔액 commitment 계산                       ~320
  범위 검사 + 비교                          ~2,000
```
