# Relayer KYC Onboarding — 설계 문서

> 상태: **설계 확정(구현 전)** · 작성: 2026-06-01 · 범위: operators · shared-orderbook · admin · 인증서 발급 사이트
>
> 이 문서 하나로 **다른 세션/사람이 이어서 구현**할 수 있도록 작성한다. 코드 식별자·컨트랙트·파일 경로는 영문 그대로 둔다.

---

## 1. 개요 / 목적

신규 릴레이어 **operator 온보딩 9단계** 중 **1번(KYC + 월렛 제출)** 이 현재 앱에 실체가 없다. 가이드상 "off-chain (email / in-person)"으로만 표기돼 있고, 실제 제출/검토/발급 흐름이 없다.

본 작업은 이를 **end-to-end 기능**으로 구현한다:

1. operator가 register 위자드 **첫 단계**에서 **메일주소·월렛주소·본인 동영상·신분증/사업자등록증 사본**을 업로드해 제출.
2. 제출물은 **중앙 서버(shared-orderbook)** 에 저장되고 **어드민이 검토**.
3. 어드민이 서류 상세 확인 → **[검증완료] / [인증서 발행허용]** → operator 월렛을 **온체인 승인**.
4. 승인 시 **인증서 생성 링크를 operator에게 메일로 발송**.
5. operator는 링크의 **인증서 발급 사이트**에서 cert를 발급받는다 — **승인된(approved) 주소만 발급 가능**, 개인키는 **사용자 비밀번호로 암호화**해 브라우저 키스토어에 보관(은행 PKI 패턴).
6. register 위자드 **상단 9단계 플로우 패널도 순서대로** 진행 표시.

---

## 2. 9단계 온보딩 플로우 (기준 = `apps/operators/app/register/page.tsx:1095 FLOW_STEPS`)

| # | 담당 | 단계 | 위치 |
|---|---|---|---|
| 1 | operator | **Submit KYC + wallet** (메일·월렛·동영상·신분증 제출) | **본 작업으로 신설** (register Step 0 → shared-orderbook) |
| 2 | admin | Anchor company Root CA on zk-X509 | one-time admin setup |
| 3 | admin | **Approve wallet for issuance** (주소 컨펌) | admin 앱 KYC 검토 → 온체인 `IssuanceApprovalRegistry` |
| 4 | operator | Open the Relayer-CA portal | 인증서 발급 사이트 (메일 링크) |
| 5 | external | Issue cert + submit ZK proof | zk-X509 (SP1 prover, Docker 필요) |
| 6 | operator | Confirm verification went green | register Step1 — Refresh |
| 7 | operator | Spin up your relayer process | operator 서버 (zk-relayer) |
| 8 | operator | Register endpoint + post bond | register Step2 & Step3 → `RelayerRegistry.register` |
| 9 | external | Appear on the leaderboard | `/leaderboard` (auto) |

> register `RelayerRegistry.register()` 는 `identityRegistry.isVerified(msg.sender)` 가 아니면 `NotVerified()` 로 revert (`contracts/src/RelayerRegistry.sol:134`). 즉 5번 cert 발급으로 `isVerified`가 켜져야 8번 등록이 가능하다.

---

## 3. 아키텍처 / 데이터 흐름

```
 operator 브라우저                 중앙 서버                      admin 브라우저          온체인 / 외부
 ─────────────────                 ─────────                      ──────────────          ───────────────
 [operators :4004]                 [shared-orderbook :4000]       [admin :4005]
 register Step0 KYC 폼  ── POST ──▶ /api/kyc/submit
   email·wallet·video·idDoc          ├ kyc_submissions(DB row)
                                     └ kyc-uploads/<id>/{video,idDoc}
                                            ▲  GET submissions/detail/file (admin auth)
                                            └──────────────────────────── KYC 검토 리스트/상세
                                                                          [검증완료] POST status=verified
                                                                          [발행허용] ──┐
                                                                                       ├▶ IssuanceApprovalRegistry
                                                                                       │   .approveForIssuance(wallet,...)
                                                                                       ├▶ cert 링크 생성 + Gmail-compose 메일
                                                                                       └▶ POST status=approved
 register Step1 ◀── 10s polling ── IssuanceApprovalRegistry.approvals(wallet) ───────────┘
   (approved 되면 다음 단계 해제)

 메일 cert 링크 클릭
   │
   ▼
 [인증서 발급 사이트]  ── 발급 전 IssuanceApprovalRegistry.approvals(wallet) 확인 (approved만 허용)
   WebCrypto 키쌍 생성 → 비밀번호로 개인키 암호화(AES-GCM) → IndexedDB 키스토어
   공개키/CSR + ZK proof 만 전송 ──▶ zk-X509 (:3000/:4444, SP1=Docker) → cert 발급 → isVerified=true
```

핵심: **개인키·비밀번호·평문 PII는 서버로 가지 않는다.** 서버가 보는 것 = (KYC 서류는 admin 검토용 저장) + (발급측은 공개키/ZK proof만).

---

## 4. 확정 설계 결정 (근거 포함)

1. **KYC 백엔드 = shared-orderbook (:4000).** zk-relayer는 operator마다 늘어나는 per-operator 서비스(사용자 증가 시 N개)라 "신규 가입 단일 창구"로 부적합. shared-orderbook은 모든 참여자가 바라보는 유일한 중앙 서비스이고, 이미 better-sqlite3 + 자체 디렉토리 저장 패턴 보유.
2. **메일 = 서버 SMTP 없음.** 기존 `apps/pay/app/payouts/detail/page.tsx:1359 openClaimMailDraftAndConfirm` 의 **Gmail 웹-compose URL + anchor 클릭 + confirm()** 패턴 재사용(어드민 메일 클라이언트로 발송).
3. **어드민 "주소 컨펌" = 온체인 `IssuanceApprovalRegistry.approveForIssuance`** (가이드 3번). register 페이지가 이미 `apps/operators/app/lib/useIssuanceApproval.ts` 로 이 컨트랙트를 10초마다 폴링 → 컨펌되면 위자드가 자동으로 다음 단계로 풀림.
4. **인증서 생성 링크 목적지 = 인증서 발급 사이트(Stage 3).** wallet prefill.
5. **인증서 발급은 승인된(approved) 주소만 가능.** 발급 사이트가 발급 전 온체인 `IssuanceApprovalRegistry.approvals(wallet)` 확인.
6. **범위 = 단계별 분할(PR 여러 개).**
7. **착수 전 전체 설계를 레포 문서로 먼저 작성**(= 본 문서).

---

## 5. 보안 아키텍처 (은행급)

### 5.1 운영자 인증서 키 관리 (최우선)
- **개인키는 클라이언트에서만 생성·보관.** 서버/오더북/릴레이어/어드민 어디에도 평문 개인키·비밀번호가 가지 않는다(zero-knowledge). 서버엔 **공개키/CSR + zk-X509 ZK proof**만.
- **KDF**: Argon2id(가능 시 WASM) 또는 PBKDF2-HMAC-SHA256 ≥ 600k iters (OWASP 2023). keystore마다 **랜덤 salt + IV**.
- **대칭암호**: PKCS#12 컨테이너는 **AES-256-CBC + HMAC-SHA256 MAC**(PBES2 표준·상호운용); 의존성-0 JSON 봉투 폴백은 **AES-256-GCM**(AEAD). 평문 개인키는 메모리에서만, 사용 후 폐기.
- **키스토어 포맷 = PKCS#12 (.p12)** [2026-06-01 확정, PR#891]. 발급 개인키는 EVM secp256k1이 아니라 **WebCrypto P-256 cert 키**라 keystore-v3(secp256k1 raw 전용)는 부적합. PKCS#12는 cert+키를 함께 담는 PKI 표준 컨테이너 + OS/브라우저/openssl native import. 인코딩은 **pkijs/@peculiar**(node-forge는 레거시 PBE). **PBES2 = PBKDF2-HMAC-SHA256 600k + AES-256-CBC + HMAC-SHA256 MAC** — openssl/OS importer가 GCM PKCS#12를 못 읽으므로 컨테이너 cipher는 GCM이 아닌 CBC+MAC(openssl `pkcs12 -info` 검증됨). 폴백: 브라우저 PBES2-PKCS12 비현실 시 dependency-free JSON 봉투(PBKDF2-600k + AES-256-GCM) interim 유지, 비표준 명시.
- **저장**: 1차 **IndexedDB**(origin 격리 소프트 키스토어) + 선택적 **암호화 파일 내보내기**(백업). 브라우저 저장은 HW-backed 아님 — 향후 **WebAuthn/passkey·Secure Enclave** 로드맵.
- **비밀번호 복구 불가**(은행과 동일): 분실 시 폐기 후 재발급.

### 5.2 KYC PII (주민등록번호·신분증·동영상)
- **전송은 TLS만, URL/쿼리에 PII 절대 금지.** 저장은 **암호화 at-rest** + **admin 인증으로만 접근** + **감사로그** + **보존·파기 정책**.
- 데이터 최소화: 주민등록번호 **마스킹/해시** 고려, 원본 동영상·스캔은 검토 후 보존기간 경과 시 파기.
- **로컬/테스트 한정**: 현재 구현은 `shared-orderbook/kyc-uploads/` (gitignore, dev.sh wipe). ⚠ **실배포 전 KMS 암호화·접근로그·격리 스토리지 필수.**

### 5.3 발급 인가(approval) & 폐기
- 인가의 **단일 진실원천 = 온체인 `IssuanceApprovalRegistry`.** 발급 사이트는 발급 전 **approved ∧ 미만료 ∧ 미취소** 검증.
- **revoke** 경로: 어드민 revoke → 발급 사이트·검증자 즉시 반영(struct에 `revoked/revokeReason/revokedAt` 존재).

### 5.4 메일 링크 = 편의일 뿐, 권한 아님
- cert 링크는 wallet prefill 편의용. 토큰을 쓰더라도 **단발·만료·wallet 바인딩**, **그 자체로 발급 권한 없음**(발급은 항상 온체인 approval로 게이팅).

### 5.5 직무분리 & 신뢰경계 (threat model)
- **operator**(KYC 제출 + 개인키 소유) / **admin**(검토 + 온체인 승인) / **CA(zk-X509)**(cert 발급) 3자 분리. 어느 한 주체도 operator의 키 없이 단독으로 신원을 위조 발급할 수 없음.
- 서버는 개인키·비밀번호를 못 봄. 발급측은 공개키 + ZK proof만 봄(개인키 비노출 증명).

---

## 6. 데이터 모델

### 6.1 `kyc_submissions` (shared-orderbook, better-sqlite3 — 신규)
| 컬럼 | 타입 | 비고 |
|---|---|---|
| `id` | TEXT PK | uuid/난수 |
| `wallet` | TEXT | lowercase, 인덱스 |
| `email` | TEXT | operator 연락 메일 |
| `video_path` | TEXT | `kyc-uploads/<id>/video.<ext>` |
| `id_doc_path` | TEXT | `kyc-uploads/<id>/id-doc.<ext>` |
| `status` | TEXT | `pending` \| `verified` \| `approved` (\| `rejected`) |
| `notes` | TEXT | 어드민 메모(거절 사유 등) |
| `created_at` | INTEGER | epoch ms |
| `reviewed_at` | INTEGER | epoch ms, null 가능 |

> 같은 wallet 재제출 시 기존 `pending` row 갱신. 마이그레이션은 `db.ts:138` 의 `table_info`/`ALTER TABLE` 패턴 따름.

### 6.2 `IssuanceApprovalRegistry.approvals(wallet)` (온체인, 기존)
`apps/operators/app/lib/useIssuanceApproval.ts` 기준 struct: `commonName, organization, country, validityDays, approvedBy, approvedAt, expiresAt, revoked, revokeReason, revokedAt`. classify: idle/checking/not-approved/approved/revoked/expired/error.

---

## 7. 구현 단계 (PR 분할)

### 진행 현황 (2026-06-01)
- **Stage 0** 설계 문서 ✅ (commit 21ae17fb, branch docs/relayer-kyc-onboarding-design).
- **PR1-A** shared-orderbook KYC 백엔드 → **PR #888** (K2). 봇 리뷰 대기.
- **PR1-B** operators register Step0 KYC 폼 → **PR #889** (K0). 봇 리뷰 대기.
- **개인키 암호화 코어** → **PR #887** (K1, interim JSON 봉투 → PKCS#12로 교체 예정).
- **PR2** admin 검토+approve+메일 → K0 착수 예정 (PR1-A의 admin 501 stub 위에).
- **PR3 발급 게이트+키스토어** → K1 (apps/admin/app/operator-ca, PKCS#12).

### Stage 0 — 설계 문서 (= 본 문서) ✅ 완료 (commit 21ae17fb)
- `docs/design/relayer-kyc-onboarding/design.md` (본 파일) + `MEMORY.md` 한 줄 포인터.
- `docs/operations/` 런북에서 링크(선택).

### PR 1 — KYC 제출 폼(operators) + 중앙 KYC 백엔드(shared-orderbook)
> 구현 시 위자드는 step0(0|1|2|3) 대신 **1-based 4스텝(1=KYC,2=Verify,3=Endpoint,4=Bond)** 으로 렌더(버블에 "0" 회피). PR1-A=#888, PR1-B=#889.
**A. shared-orderbook (Express, better-sqlite3)**
- `src/core/db.ts`: `kyc_submissions` 테이블 + insert/getByWallet/list/getById/updateStatus 스테이트먼트.
- `config.ts`: `kycUploadDir = env("KYC_UPLOAD_DIR", "kyc-uploads")`.
- `src/routes/kyc.ts` (신규 Router, `index.ts` 마운트):
  - `POST /api/kyc/submit` — 공개(operator 본인), `rateLimit`. multipart(`multer`, 신규 dep): `wallet, email`, files `video`, `idDoc` → 파일+row 저장 → `{id,status}`.
  - `GET /api/kyc/status?wallet=` — 공개. wallet 제출 상태(위자드 새로고침 후 step0 판정).
  - (자리만 확보, 구현은 PR2) admin 라우트: `GET /api/kyc/submissions`, `/:id`, `/:id/file/:kind`, `POST /:id/status` — `middleware/auth.ts`.
- `scripts/dev.sh`: DB wipe 구간에 `kyc-uploads/` 정리. `.gitignore`: `shared-orderbook/kyc-uploads/`.

**B. operators register 위자드 — KYC를 Step 0로**
- `apps/operators/app/register/_Stepper.tsx`: `StepDef.id`·`Stepper.current` 타입 `1|2|3` → `0|1|2|3`.
- `apps/operators/app/register/page.tsx`:
  - 신규 `Step0Kyc` — `StepSection`(:981) 래핑, `Field`(:1196) 재사용. 필드: email, wallet(`account` prefill), video `<input type=file accept=video/*>`, idDoc `<input type=file accept=image/*,application/pdf>`. 파일입력 패턴 = `apps/pro/app/components/WorkspaceBar.tsx`. 제출 → FormData multipart → `${NEXT_PUBLIC_SHARED_ORDERBOOK_URL}/api/kyc/submit`.
  - `step0Done`(= GET status) 추가, `step1Done`을 그에 게이팅, `currentStep` `0|1|2|3`, `step0Caption` 추가, `stepperSteps` 4개.
  - 렌더: `<Step0Kyc>` 를 `<Step1Verify>` 앞에. Step1Verify `gated={!step0Done}`.
  - **상단 플로우 순서 진행**: `FLOW_STEPS` 1번을 `wizardStep:0` 매핑, `FlowContextPanel`(:1116)에 완료 단계 집합(step0Done→1, approval.approved→3, isVerified→6, registered→8) 전달 → 완료=초록/현재=하이라이트/이후=흐림.

**PR1 검증**: operators :4004/register 를 미등록 지갑 #3(`0x90F7…b906`)으로 접속 → Step0 KYC 폼 → 작은 mp4+이미지 업로드·제출 → `sqlite3 shared-orderbook/shared-orderbook.db "select * from kyc_submissions"` row + `kyc-uploads/<id>/` 파일 + `curl localhost:4000/api/kyc/status?wallet=…` = pending. 새로고침 후에도 Step0 done, 상단 1번 초록.

### PR 2 — 어드민 검토 UI + 온체인 컨펌 + 메일
- admin 앱(:4005) KYC 검토 페이지: 리스트 → 상세(동영상 `<video>` + 신분증 `<img>/<iframe>` 를 `/:id/file/:kind` admin 스트림 로드) → **[검증완료]**(status=verified) / **[발행허용]**.
- 발행허용: (a) `IssuanceApprovalRegistry.approveForIssuance(wallet, CN/O/C/validityDays)` — 기존 어드민 쓰기 경로 재사용, (b) cert 링크 생성, (c) `openClaimMailDraftAndConfirm` 패턴으로 Gmail-compose 메일, (d) status=approved.
- shared-orderbook admin 라우트(PR1 자리 확보분) 구현 완성.
- **미해결**: 기존 `approveForIssuance` 쓰기 UI 위치 확인 후 재사용 / cert 링크 토큰·만료 스킴 필요 여부.

### PR 3 — 인증서 발급 사이트 (승인 게이팅 + 비밀번호-암호화 키스토어)
- **승인 게이팅**: 로드 시 `IssuanceApprovalRegistry.approvals(wallet)` 확인(`useIssuanceApproval` 재사용) → approved(미만료·미취소)만 발급 UI 활성.
- **클라이언트 키 생성·암호화**: WebCrypto 키쌍 → 비밀번호 PBKDF2/Argon2id → AES-256-GCM 으로 개인키 암호화.
- **저장**: IndexedDB 키스토어 + 선택적 암호화 파일 다운로드. 평문 개인키 비반출.
- **발급**: 공개키/CSR + ZK proof만 zk-X509(:3000/:4444)로 → cert 발급 → `isVerified` true.
- **확정**: 발급 사이트 = **scatter-dex `apps/admin/app/operator-ca`** (K1 확인, 기존 발급 진입점). 키스토어 = **PKCS#12** (§5.1). 승인 게이트는 K1이 암호화 PR과 분리한 후속 PR로.
- **미해결**: SP1 prover Docker(없으면 발급 mock).

---

## 8. 재사용 자산 (구현 시 새로 만들지 말 것)

| 용도 | 위치 |
|---|---|
| IssuanceApprovalRegistry read/classify | `apps/operators/app/lib/useIssuanceApproval.ts` |
| 메일(Gmail-compose + confirm) 패턴 | `apps/pay/app/payouts/detail/page.tsx:1359 openClaimMailDraftAndConfirm` |
| SQLite 테이블·마이그레이션 패턴 | `shared-orderbook/src/core/db.ts` (특히 :138 ALTER) |
| 위자드 스텝/폼 primitives | `apps/operators/app/register/page.tsx` — `StepSection`(:981), `Field`(:1196) |
| 9단계 플로우 데이터/패널 | 동 파일 `FLOW_STEPS`(:1095), `FlowContextPanel`(:1116) |
| 파일 업로드 input 패턴 | `apps/pro/app/components/WorkspaceBar.tsx` |
| shared-orderbook admin 인증 | `shared-orderbook/src/middleware/auth.ts` |
| RelayerRegistry 신원 게이팅(컨트랙트) | `contracts/src/RelayerRegistry.sol:134 NotVerified()` |

---

## 9. 미해결 결정 (오픈)
- ~~발급 사이트 위치~~ → **확정: apps/admin/app/operator-ca** (2026-06-01).
- ~~키스토어 포맷~~ → **확정: PKCS#12 (PBES2, pkijs)** (2026-06-01).
- 저장 위치(IndexedDB vs 파일 vs 둘 다) — 둘 다 권장, K1 구현 시 확정.
- cert 링크 토큰/만료 스킴.
- 주민등록번호 마스킹/해시 적용 범위.
- zk-X509 ZK proof 생성 = SP1 prover(Docker) 필요 — 로컬 Docker 부재 시 발급 단계 mock.

---

## 10. 운영 / PII 주의
현재 구현은 **로컬/테스트 한정**. 업로드 PII(주민등록번호·신분증·동영상)는 `shared-orderbook/kyc-uploads/`(gitignore, dev.sh wipe)에 평문 저장된다. **실서비스 배포 전 반드시**: 저장 암호화(KMS), 접근 감사로그, 보존·파기 정책, 격리 스토리지, 개인키·비밀번호 비수집 원칙 재확인.
