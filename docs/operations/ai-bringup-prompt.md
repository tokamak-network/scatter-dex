# AI Bring-up Prompt — full local stack (relayer-onboarding model)

A copy-paste prompt for an AI coding agent (Claude Code) that tears everything
down and brings the whole local environment up **from scratch, in the
background**, the way the *real service* works:

- **No relayers are pre-launched or pre-registered.** The old dev flow seeded
  Relayer A/B on-chain; this model does **not**. Relayers come online only by
  going through the actual onboarding (KYC → zk-X509 proof → admin approval →
  register).
- The **admin stands up and manages the Relayer-CA** (the zk-X509 identity
  registry that `RelayerRegistry.register()` gates against) and turns on
  **delegated proving** so any operator can prove their accredited certificate
  against one shared prover.

> ⚠ Design context: scatter-dex **does not issue operator certificates**. An
> operator's identity is their **real accredited certificate**, verified by the
> external **zk-X509** delegated-proving flow. Onboarding is gated by **two
> independent checks** — `isVerified` (zk-X509) **AND** `kycApproved` (admin).
> Single source of truth: `docs/design/relayer-kyc-onboarding/design.md` §11–13.

> 🔧 Prerequisite (dev.sh): this prompt assumes `./scripts/dev.sh` supports a
> **`--no-relayers`** mode that brings up anvil + orderbook + apps **without**
> launching the zk-relayer A/B processes and **without** seeding their on-chain
> registration / KYC approval. If that flag doesn't exist yet, it must be added
> (skip the relayer port starts + the DeployLocal/post-deploy relayer
> register + the #911 A/B `approve` seed). Until then, stop and de-register the
> seeded relayers after bring-up.

---

## The prompt (paste this to the AI)

> scatter-dex 로컬 환경을 **전부 내렸다가 처음부터 백그라운드로** 띄우고, **릴레이어를 미리
> 등록하지 않은 채** "어드민이 Relayer-CA를 등록해 서비스하듯" 온보딩을 테스트할 수 있게 해줘.
> zk-X509 경로는 이제 **선택이 아니라 필수**다(릴레이어 신원 검증이 그걸로 됨). 순서:
>
> **0. 전부 내리기 (clean slate)**
> ```bash
> ./scripts/dev.sh --stop                                   # anvil + orderbook + apps + (있다면)relayers
> cd <zk-X509> && bash script/stop-services.sh; cd -        # zk-X509 front/back
> pid=$(lsof -tiTCP:9090 -sTCP:LISTEN); [ -n "$pid" ] && kill $pid   # prover-server (macOS xargs has no -r)
> ```
>
> **1. 인프라 기동 (릴레이어 없이, 백그라운드)**
> ```bash
> ./scripts/dev.sh --mock --apps pay,pro,operators,admin,hub --no-relayers --background
> ```
> anvil(8545) + 공유오더북(4000) + 앱 5개(pay 4001·pro 4003·operators 4004·admin 4005·hub 4006)만
> 띄운다. **zk-relayer A/B(3002/3003)는 띄우지 않고, 온체인에도 어떤 릴레이어도 등록/승인 시드하지 않는다.**
> 컨트랙트 배포 시 테스터(anvil #0–#10)에게 토큰은 그대로 지급된다(100 WETH·1M USDC·1M USDT·100k TON).
> 헬스체크(릴레이어 제외):
> ```bash
> curl -fsS http://localhost:4000/health
> for p in 4001 4003 4004 4005 4006; do curl -fsS -o /dev/null -w "$p %{http_code}\n" http://localhost:$p; done
> cast block-number --rpc-url http://localhost:8545
> ```
>
> **2. zkey 검증 (오프라인 필수, 온라인 선택)**
> - 오프라인: `scripts/check-zk-artifacts.sh` — zkey가 배포 매니페스트와 일치하는지(드리프트면 보고).
>   ("DRIFT"가 `mobile/assets/zk/` 경로 missing 때문이면 오탐 — 실제 zkey는 `mobile/assets/zk-native/`, 해시 일치 확인).
>
> **3. 어드민이 Relayer-CA를 등록·관리 (서비스 셋업) — AI 작업 범위**
> zk-X509는 별도 레포다(`~/tokamak-projects/zk-X509`, 최초 1회 `make elf`). 릴레이어 신원 레지스트리(=Relayer-CA)를
> 같은 anvil에 붙이고, 단일 프루빙 서버로 위임 증명을 켠다.
> ```bash
> # 3a. 같은 anvil에 zk-X509 IdentityRegistry 배포 (= Relayer-CA). "IdentityRegistry" 주소를 받아둬라.
> #     반드시 zk-X509 프론트 기동(3c)보다 먼저.
> cd <zk-X509> && MAX_WALLETS_PER_CERT=10 SERVICE_NAME="Relayer CA" bash script/deploy-on-existing-anvil.sh
> # 3b. RelayerRegistry의 신원 레지스트리를 그 Relayer-CA로 설정 (register가 게이팅하는 레지스트리).
> #      ⚠ swap-identity-registry.sh 는 Pay IdentityGate(유저용)라 릴레이어엔 쓰지 말 것 —
> #      릴레이어는 RelayerRegistry.setIdentityRegistry(addr) (onlyOwner) 를 직접 호출한다.
> cast send <RelayerRegistry> "setIdentityRegistry(address)" <3a의 IdentityRegistry 주소> \
>     --private-key <anvil #0 key> --rpc-url http://localhost:8545
> #     검증: RelayerRegistry.identityRegistry() 가 그 주소여야 한다.
> cast call <RelayerRegistry> "identityRegistry()(address)" --rpc-url http://localhost:8545
> # 3c. 단일 프루빙 서버 기동 (모든 릴레이어가 공유, URL은 온체인 저장됨).
> cd <zk-X509> && PROVER_PORT=9090 PROVER_URL=http://localhost:9090 PROVER_LOG_DIR=./logs \
>     nohup ./target/release/prover-server > /tmp/prover-server.log 2>&1 &
> curl -fsS http://localhost:9090/api/health
> # 3d. 어드민이 Relayer-CA에 delegated proving ON + 프루버 URL을 온체인 set.
> cd <zk-X509> && REGISTRY_ADDR=<3a 주소> PROVER_URL=http://localhost:9090 REQUIRED=true \
>     bash script/enable-delegated-proving.sh
> #     검증: proverUrl 이 온체인에 저장됐는지.
> cast call <3a 주소> "proverUrl()(string)" --rpc-url http://localhost:8545   # = "http://localhost:9090"
> # 3e. zk-X509 프론트(:3000)/백엔드(:4444) + (사람용) 데스크탑 기동.
> cd <zk-X509> && bash script/start-services.sh
> ( <zk-X509>/target/release/bundle/macos/zk-X509.app/Contents/MacOS/zk-x509-desktop > /tmp/zkx509-app.log 2>&1 & )
> # 3f. 어드민 인증 설정: shared-orderbook 에 ADMIN_ADDRESSES=<anvil #0> 를 넣고 그 서버만 재시작
> #     (어드민이 SIWE 지갑서명으로 KYC 검토/승인하려면 필요). static ADMIN_TOKEN 은 폐기됨.
> ```
> AI는 "인프라+Relayer-CA+프루버가 떴고, RelayerRegistry가 그 레지스트리를 게이팅하며, 온체인 proverUrl이
> set됐고, 어드민 인증이 설정됐다"까지 보장·보고한다.
>
> **★ 모든 서비스 기동 후, 떠있는 서비스와 URL을 표로 화면에 출력한다** (사람이 바로 접속할 수 있게). 최소 항목:
> ```
> 앱        operators http://localhost:4004 · admin http://localhost:4005 · pay :4001 · pro :4003 · hub :4006
> 인프라     orderbook http://localhost:4000 · anvil http://localhost:8545(chainId 31337)
> 릴레이어    (없음 — --no-relayers; /register 온보딩으로만 등록)
> zk-X509    prover http://localhost:9090 · dashboard http://localhost:3000 · backend http://localhost:4444 · desktop(PID)
> Docker     RUNNING / DOWN (DOWN이면 실제 증명 불가 — open -a Docker)
> 온체인     Relayer-CA <addr>(RelayerRegistry.identityRegistry, proverUrl set) · RelayerRegistry <addr>(등록 0, 2게이트 ON) · IssuanceApprovalRegistry <addr>(승인 0)
> ```
> **여기까지가 AI 범위.** 운영자 온보딩(KYC 제출·zk-X509 증명)과 어드민 KYC 검토/승인은 **사람이 직접** 한다(아래 4).
>
> **4. 릴레이어 온보딩 테스트 (2-게이트 실흐름)** — 사람이 인터랙티브로, AI는 보조
> 운영자 지갑(미등록, 예 anvil #3)으로 operators `:4004/register`:
> - **Step1**: KYC 제출(메일·월렛·동영상·신분증) → shared-orderbook 저장.
> - **Step2**: "Open zk-X509 to prove your certificate ↗"(레지스트리 `?tab=register` 딥링크) 또는 데스크탑 앱에서
>   **본인 공인인증서로 zk-X509 위임 증명** → `isVerified` 켜짐. **실제 증명 생성은 Docker 필요**(prover-server의 SP1
>   Groth16/gnark이 Docker FFI). Docker 꺼져 있으면 `/api/prove` 500.
> - **[어드민]** admin `:4005` Operator CA → KYC review: SIWE 로그인 → 제출 서류 + **prover compliance**
>   (`GET :9090/api/compliance?wallet=`)의 증명된 cert subject(이름/기관/국가) 대조 → 일치 시 **approve**
>   (`kycApprovalRegistry.approve(wallet)` = 2번째 게이트).
> - **Step3/4**: 두 게이트(isVerified AND kycApproved) 충족 시 엔드포인트·본드 → `RelayerRegistry.register()` →
>   그때서야 그 운영자의 zk-relayer 프로세스를 띄운다.
>
> **여기서 사람의 판단(서류↔cert 대조 승인)과 실제 증명(데스크탑/지갑 서명)은 사람이 한다.** AI가 대신 승인하지 마라.
> (테스트 편의로 게이트만 통과시키려면 어드민 지갑으로 `kycApprovalRegistry.approve(<운영자지갑>, ...)` 를 직접
> 호출하는 것도 가능 — 단 그건 실검토를 건너뛴 테스트용임을 명시.)
>
> **종료**: `./scripts/dev.sh --stop` + `cd <zk-X509> && bash script/stop-services.sh` + prover-server kill.
>
> 각 단계 끝마다 무엇이 떴고 어떤 URL인지, 검증 통과/실패를 한 줄로 요약하고 실패는 로그 근거와 함께 보고해.
> ⚠ 주의: `dev.sh` 재기동은 anvil을 리셋한다 → zk-X509 배포·온체인 proverUrl·진행 중 검증이 전부 날아가므로,
> 3a~3d(Relayer-CA 재부착)를 매 재기동마다 다시 해야 한다. 가능하면 코드 변경은 hot-reload로 반영하고 재기동을 피해라.

---

## Ground-truth reference (what the prompt maps to)

| Goal | Command / mechanism | Notes |
|---|---|---|
| 인프라만 (릴레이어 없이) | `./scripts/dev.sh --mock --apps pay,pro,operators,admin,hub --no-relayers --background` | anvil+orderbook+apps. 릴레이어 미기동·미등록 |
| zkey offline verify | `scripts/check-zk-artifacts.sh` | 매니페스트 대비 해시 |
| Relayer-CA 부착 | `<zk-X509>/script/deploy-on-existing-anvil.sh` → `./scripts/swap-identity-registry.sh <reg>` | `RelayerRegistry.identityRegistry()` 가 그 레지스트리가 됨 |
| 단일 프루버 (위임 증명) | `prover-server`(:9090) + `enable-delegated-proving.sh` (REGISTRY_ADDR=Relayer-CA, PROVER_URL) | proverUrl 온체인 저장, 모든 릴레이어 공유. 실제 proof=Docker 필요 |
| 어드민 인증 | shared-orderbook `ADMIN_ADDRESSES=<anvil #0>` + SIWE 지갑서명 | static `ADMIN_TOKEN` 폐기(#914) |
| 온보딩 검토 | admin `:4005` Operator CA → KYC review + compliance 대조(`:9090/api/compliance?wallet=`) | isVerified ∧ kycApproved 둘 다여야 register |
| 종료 | `./scripts/dev.sh --stop` + zk-X509 `stop-services.sh` + prover kill | dev.sh 재기동 = anvil 리셋 → 3a~3d 재실행 필요 |

See [local-setup.md](local-setup.md) and `docs/design/relayer-kyc-onboarding/design.md` §11–13.
