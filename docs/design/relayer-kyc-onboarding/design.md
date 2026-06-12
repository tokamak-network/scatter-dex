# Relayer KYC Onboarding — 설계 문서

> 상태: **구현 완료·운영 중** · 범위: operators · shared-orderbook · admin · contracts
>
> 핵심 원칙: **scatter-dex 는 CA 가 아니라 RA(등록기관)다.** 자체 인증서를 발급하지 않는다.
> 운영자가 **외부 공인 CA**(예: yessign/KICA)에서 발급받은 진짜 X.509 인증서를
> **zk-X509 delegated proving** 으로 검증하고, **2-게이트(zk-X509 검증 AND 어드민 KYC 승인)** 로 온보딩한다.
>
> (초기에 검토했던 자체 Root CA / leaf 발급 / CSR 서명 / PKCS#12 키스토어 모델은 폐기·코드 제거 완료 —
> 경위는 git 히스토리의 이 문서 이전 판 참조.)

---

## 1. 신뢰 모델 = 2 레이어

| 레이어 | 무엇 | 보유/발급 |
|---|---|---|
| ① 공인인증서 (accredited cert) | 운영자가 **외부 공인 CA**에서 이미 발급받은 진짜 X.509 | 운영자 보유 · 외부 CA 발급 (**scatter-dex 무관**) |
| ② zk-X509 proof | 공인인증서가 신뢰 CA 집합(`caMerkleRoot`)에 체인됨 + subject 선택공개를 **영지식 증명** | 운영자가 zk-X509 **delegate prover**에서 생성 → `IdentityRegistry.register` → `isVerified` |

신원의 신뢰근거는 외부 공인 CA가, 영지식 검증은 zk-X509가 담당한다.

**경계 (불변 원칙):** zk-X509 **core(회로/program, contracts, lib)** 는 독립 완성품으로 **수정하지 않는다.** 통합에 필요한 확장은 운영 컴포넌트인 **prover-server**(delegate prover)에만 가한다.

---

## 2. 2-게이트 온보딩 (end-to-end)

```
 운영자 공인인증서 ─zk-X509 delegate prover(consent)─▶ ① IdentityRegistry.isVerified(wallet)=true
        │                                                  └▶ prover가 cert subject+consent를 compliance에 기록
 운영자 KYC 동영상·서류 ──────────────────────────────▶ shared-orderbook 저장
                                                              │
   어드민 "운영자 CA" 화면:                                    ▼
     ① zk-X509 isVerified 여부 표시                    GET {proverUrl}/api/compliance?wallet=
     ② prover compliance의 cert subject(이름/기관/국가)  ──대조──▶ KYC 동영상·서류
        ↳ 일치 → ② kycApprovalRegistry.approve(wallet, CN/O/C, validityDays, expiresAt)
                                                              │
   RelayerRegistry.register():  require ① isVerified  AND  ② kycApproved  ◀───┘
```

1. **operator**: 공인인증서로 zk-X509 **delegated proving**(consent 동의) → `isVerified(wallet)`. delegate prover가 cert subject + consent 증거를 compliance 기록.
2. **operator**: KYC 동영상·신분증 → shared-orderbook 제출 (`apps/operators` register 위자드 Step 0).
3. **admin**: `apps/admin/app/operator-ca` 화면에서 ① zk-X509 검증여부 확인 + ② prover compliance로 cert subject 조회 → KYC 동영상·서류와 **대조** → 일치 시 `kycApprovalRegistry.approve(wallet, CN/O/C, validityDays, expiresAt)`. zk-X509 증명 기록이 없는 지갑도 **수동 KYC 승인**은 가능하다(PR #972) — 단 등록은 여전히 ① 게이트를 통과해야 한다.
4. **register**: `RelayerRegistry.register()` 가 `isVerified`(zk-X509) **AND** `kycApproved`(어드민) 둘 다 충족 시 등록.

### compliance 조회 API (prover-server 확장)

`GET {proverUrl}/api/compliance?wallet=0x..` (dev 기본 `http://localhost:9090`) →
```jsonc
{ "wallet": "0x..", "records": [ {
  "timestamp": 1717200000,   // 증명 시각(unix s)
  "registrant": "0x..",      // == 쿼리 wallet (중복 확인용)
  "commonName": "홍길동", "org": "삼성", "orgUnit": "Engineering", "country": "KR", // cert RDN 분리
  "serial": "0x..", "notAfter": 1800000000,
  "nullifier": "0x..",       // 온체인 IdentityRegistry 등록과 대조하는 키 (public_values에서 기록)
  "consentVerified": true,
  "consentMessage": "zk-x509-delegated-proving-consent\nProver:..\nRegistry:..\nChain ID:..\nWallet:..\nTimestamp:..",
  "consentSignature": "0x.." // 인증서 개인키의 동의문 서명 = 부인방지 증거 (개인키 아님, freshness·바인딩으로 재사용 불가)
} ] }
```
`nullifier`로 온체인 등록과 대조, `wallet`은 registrant 소문자 매칭. proverUrl = `IdentityRegistry.proverUrl()` 또는 dev `:9090`; 운영 PII 가드로 선택적 `X-Compliance-Token`(prover의 `PROVER_COMPLIANCE_TOKEN`) 헤더 지원. (zk-X509 PR #130 — core 무수정, prover-server만 확장)

---

## 3. 컨트랙트 2-게이트

```solidity
// RelayerRegistry.register()
if (!identityRegistry.isVerified(msg.sender)) revert NotVerified();              // ① zk-X509
if (address(kycApprovalRegistry) != address(0)                                   // feature-flag
    && !kycApprovalRegistry.isApproved(msg.sender)) revert NotKycApproved();      // ② 어드민 KYC
```

- **feature-flag**: `kycApprovalRegistry == address(0)` → ② 체크 skip(= zk-X509-only). 주소 세팅 순간부터 AND 강제 → **무중단 마이그레이션·페이즈드 롤아웃**. 세터는 `setKycApprovalRegistry()`(onlyOwner), 호출용 최소 인터페이스 `IKycApproval { function isApproved(address) external view returns (bool); }`.
- `kycApprovalRegistry` = **`IssuanceApprovalRegistry`** (이름은 구 설계의 유산이고 의미는 "어드민 KYC 승인"). 온체인 시그니처: `approve(address wallet, string CN, string O, string C, uint32 validityDays, uint64 expiresAt)`, `revoke(address wallet, string reason)`, `isApproved(address) view returns (bool)`. CN/O/C 는 *어드민이 cert subject 로 확인한 신원값*. 상세는 [../contracts/supporting-contracts.md](../contracts/supporting-contracts.md) §4.

---

## 4. KYC 제출/검토 파이프라인

### 4.1 데이터 흐름

```
 operator 브라우저                 중앙 서버                      admin 브라우저
 ─────────────────                 ─────────                      ──────────────
 [operators :4004]                 [shared-orderbook :4000]       [admin :4005]
 register Step0 KYC 폼  ── POST ──▶ /api/kyc/submit
   email·wallet·video·idDoc          ├ kyc_submissions(DB row)
                                     └ kyc-uploads/<id>/{video,idDoc}
                                            ▲  GET submissions/detail/file (SIWE admin auth)
                                            └──────────────────── operator-ca/kyc-review 리스트/상세
                                                                  [검증완료] POST status=verified
                                                                  [KYC 승인] ─▶ IssuanceApprovalRegistry.approve(...)
                                                                              + POST status=approved
 register 위자드 ◀── 폴링 ── isVerified(zk-X509) & isApproved(KYC) ────────────┘
```

- **KYC 백엔드 = shared-orderbook (:4000)**: 모든 참여자가 바라보는 유일한 중앙 서비스 (zk-relayer 는 per-operator 라 부적합). 라우트: `POST /api/kyc/submit`(공개, rate-limit), `GET /api/kyc/status?wallet=`(공개), `GET /api/kyc/submissions[/:id[/file/:kind]]`·`POST /:id/status`(SIWE admin).
- **멱등·self-healing 동기화**: 온체인 approve 전 `approvals(wallet)` 를 먼저 읽어 이미 approved 면 tx 스킵; DB `status=approved` 쓰기는 tx 성공 후 독립 재시도 — 온체인이 진실원천.

### 4.2 `kyc_submissions` 스키마 (better-sqlite3)

| 컬럼 | 타입 | 비고 |
|---|---|---|
| `id` | TEXT PK | uuid/난수 |
| `wallet` | TEXT | lowercase, `(wallet, created_at)` 인덱스 |
| `email` | TEXT | operator 연락 메일 |
| `video_path` | TEXT | `kyc-uploads/<id>/video.<ext>` |
| `id_doc_path` | TEXT | `kyc-uploads/<id>/id-doc.<ext>` |
| `status` | TEXT | `pending` \| `verified` \| `approved` (\| `rejected`) |
| `notes` | TEXT | 어드민 메모(거절 사유 등) |
| `created_at` | INTEGER | **unix seconds** — 다른 테이블과 단위 통일 |
| `reviewed_at` | INTEGER | unix seconds, null 가능 |

같은 wallet 재제출 시 기존 `pending` row 갱신.

### 4.3 진입점별 강제 방식

| 진입점 | 강제 | 종류 | 비고 |
|---|---|---|---|
| `RelayerRegistry.register()` | `isVerified` AND (`kycApprovalRegistry` 설정 시) `isApproved` | **직접 코드검증(온체인)** | `NotVerified()` / `NotKycApproved()` revert |
| admin KYC 라우트 | SIWE(어드민 지갑 서명) + 감사로그 | **직접 코드검증** | `shared-orderbook/src/core/admin-siwe.ts` |
| KYC 제출 (`POST /api/kyc/submit`) | 본인 제출 공개 엔드포인트, 신원검증 **없음**(rate-limit만) | **아키텍처 보장** | 제출은 권한부여가 아님 — 승인은 admin 검토 + 온체인 approve 라는 별도 다운스트림 게이트가 책임 |

---

## 5. 불변 보안 원칙

- scatter-dex 는 **CA 키를 보유/생성하지 않는다.** 신뢰는 외부 공인 CA가 보증, zk-X509가 영지식 검증.
- **operator 공인인증서 개인키 = operator 만 보유.** delegate prover 엔 일회성 서명·consent 만 전달(개인키 미전송).
- **2-게이트**: 기계 검증(zk-X509 `isVerified`) + 인간 심사(admin KYC `approve`) **모두 필요**. flag ON 시 어느 하나로 단독 등록 불가.
- `consentSignature` = 부인방지 증거(개인키 아님, freshness·바인딩으로 재사용 불가).
- **직무분리**: 기계 검증(zk-X509) ≠ 인간 승인(admin KYC) ≠ 앵커 관리(거버넌스). 한 주체가 단독으로 신원을 통과시킬 수 없음.

## 6. 운영 / PII 주의

업로드 PII(신분증·동영상)는 현재 `shared-orderbook/kyc-uploads/`(gitignore, dev.sh wipe)에 평문 저장된다 — **로컬/테스트 한정**. 전송은 TLS만, URL/쿼리에 PII 금지. **실서비스 배포 전 반드시**: 저장 암호화(KMS), 접근 감사로그, 보존·파기 정책, 격리 스토리지. 주민등록번호 마스킹/해시 적용 범위는 미결.

---

## 7. 프로덕션 목표 — 우리는 CA가 아니라 RA

scatter-dex 가 CA를 운영하지 않으므로 HSM·key ceremony·CA 컴플라이언스(WebTrust) 부담이 없다 — 그건 외부 공인 CA의 몫. 프로덕션 하드닝 대상:

1. **신뢰앵커 거버넌스 (`caMerkleRoot`)** — 어떤 공인 CA를 신뢰할지(앵커 추가/교체)는 고위험 결정 → **멀티시그(Safe)+타임락** 온체인 승인. zk-X509 레지스트리의 앵커 관리 권한 분리.
2. **delegate prover 운영** — prover 가 다루는 **PII(cert subject·consent)** 격리 스토리지·암호화(ECIES 전송 지원)·접근 감사로그·보존/파기. prover 인증·레이트리밋·고가용성. compliance 로그 무결성.
3. **2-게이트 거버넌스(SoD)** — KYC 승인자 권한 = 온체인 role + SIWE + 감사 이벤트.
4. **폐기·라이프사이클** — 공인인증서 **자체** 폐기는 외부 CA(CRL/OCSP) 책임. 우리 측: `kycApprovalRegistry.revoke(wallet, reason)` + zk-X509 만료(`notAfter`)·`nullifier` 재사용 차단. 외부 CRL 동기화는 선택.
5. **컴플라이언스** — RA 운영정책, KYC PII 보존·파기(KMS·격리 스토리지), 접근 감사, 정기 pen-test.

## 8. 로드맵

| Phase | 범위 | 상태 |
|---|---|---|
| 1 | KYC 제출/검토 · SIWE · 감사로그 · revoke · 2-게이트(AND+flag) · zk-X509 delegated proving + compliance 대조 화면 | ✅ 구현 완료 |
| 2 | `caMerkleRoot` 앵커 거버넌스(멀티시그/타임락) + 신뢰 공인 CA 목록 관리 | ⏳ |
| 3 | delegate prover PII 운영 하드닝(격리·KMS·접근로그) | ⏳ |
| 4 | 폐기 동기화(외부 CRL/OCSP ↔ KYC revoke), cert 만료 자동 재검증 | ⏳ |
| 5 | 컴플라이언스(RA 운영정책, PII 보존·파기 감사) | ⏳ |
