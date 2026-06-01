# AI Bring-up Prompt — full local stack

A copy-paste prompt for an AI coding agent (Claude Code) that brings the whole
local environment up **in the background**, verifies the ZK artifacts, funds the
test accounts, and (as a follow-up) attaches zk-X509 on the same anvil.

Most of this is already automated by `scripts/dev.sh`; the prompt sequences the
pieces and adds the verification + zk-X509 steps. Run it from the repo root.

---

## The prompt (paste this to the AI)

> scatter-dex 로컬 풀스택을 **백그라운드**로 띄우고 검증까지 해줘. 순서:
>
> **1. 앱 + 인프라 기동 (백그라운드)**
> 레포 루트에서:
> ```bash
> ./scripts/dev.sh --mock --apps pay,pro,operators,admin,hub --background
> ```
> 이 한 명령이 anvil(8545) + 공유오더북(4000) + 릴레이어 A(3002)/B(3003) + 앱 5개
> (pay 4001 · pro 4003 · operators 4004 · admin 4005 · hub 4006)를 띄우고 분리한다.
> 컨트랙트 배포 시 **테스터(anvil #0–#10)에게 자동 지급**된다: 100 WETH · 1,000,000 USDC ·
> 1,000,000 USDT · 100,000 TON (+ ETH는 anvil 기본 프리펀드). 특정 지갑을 더 채우려면
> `apps/pay/e2e/_helpers/fund-wallet.ts`를 써라.
> 기동 후 헬스체크로 전부 떴는지 확인하고, 실패하면 `.dev-logs/*.log` 마지막 줄을 보고 보고해:
> ```bash
> curl -fsS http://localhost:4000/health        # orderbook
> curl -fsS http://localhost:3002/api/info       # relayer A
> curl -fsS http://localhost:3003/api/info       # relayer B
> for p in 4001 4003 4004 4005 4006; do curl -fsS -o /dev/null -w "$p %{http_code}\n" http://localhost:$p; done
> cast block-number --rpc-url http://localhost:8545
> ```
>
> **2. zkey 검증 (온라인 + 오프라인)**
> - 오프라인(아티팩트 드리프트 — 체인 불필요): `scripts/check-zk-artifacts.sh` 를 돌려 zkey가
>   배포 시 매니페스트와 일치하는지 확인(불일치면 드리프트 → 보고).
> - 온라인(온체인 검증): 배포된 Verifier 컨트랙트에 **실제 Groth16 증명**을 제출해 검증이
>   통과하는지 확인. zkey가 온체인 Verifier와 안 맞으면 `InvalidProof()`가 난다. 레포의 실제
>   증명 플로우를 사용해라(예: `cd zk-relayer && npx tsx test/e2e-scatter-direct-auth.ts`
>   같은 e2e 프루프 테스트, 또는 브라우저 deposit). 결과를 요약 보고해.
>
> **3. (나중에) zk-X509를 같은 anvil에 붙이기 — 프론트/백엔드 기동 + vkey 검증까지**
> zk-X509는 별도 레포다(`git clone https://github.com/tokamak-network/zk-X509.git`,
> 최초 1회 `make elf`). 이미 받은 체크아웃 경로를 `<zk-X509>`로 쓴다(이 머신: `~/tokamak-projects/zk-X509`).
> 아래 3a~3e까지가 **AI 작업 범위**다.
> ```bash
> # 3a. 같은 anvil에 IdentityRegistry 배포 (테스트 CA 자동 seed). "IdentityRegistry (proxy)" 주소를 받아둬라.
> #     반드시 프론트 기동(3b)보다 먼저! 배포가 <zk-X509>/frontend/.env.local 에 factory 주소를 쓰고,
> #     Next는 그 파일을 부팅 때만 읽는다. 순서가 바뀌면 웹에서 "Failed to load services from factory contract".
> cd <zk-X509> && MAX_WALLETS_PER_CERT=10 SERVICE_NAME="User CA" bash script/deploy-on-existing-anvil.sh
> # 3b. 프론트(:3000 대시보드) + 백엔드(:4444) 기동 (이제 .env.local 에 factory 주소가 들어가 있음)
> cd <zk-X509> && bash script/start-services.sh
> #     (이미 deploy 전에 프론트를 띄웠었다면 재시작: bash script/stop-services.sh && bash script/start-services.sh)
> # 3c. 배포/vkey 검증: ELF VK == factory/registry.effectiveProgramVKey, caMerkleRoot != 0, paused == false.
> #     Rust/Docker가 없으면 --quick 로 cargo·SP1 캐시 검사를 건너뛰고 온체인 wiring만 검증한다.
> cd <zk-X509> && bash script/verify-deployment.sh --quick
> # 3d. scatter-dex IdentityGate를 그 레지스트리로 swap (검증 통과 후)
> cd <scatter-dex> && ./scripts/swap-identity-registry.sh <3a의 IdentityRegistry 주소>
> # 3e. 프론트/백엔드 헬스체크
> curl -fsS -o /dev/null -w "zkx509-frontend %{http_code}\n" http://localhost:3000
> curl -fsS -o /dev/null -w "zkx509-backend %{http_code}\n" http://localhost:4444
> # 3f. CA 검증용 데스크탑 앱을 사람을 위해 띄워준다 (실제 검증 조작은 사람이 함).
> #     먼저 빌드돼 있어야 한다: cd <zk-X509> && make desktop
> #     GUI라 떠 있는 동안 블록되므로 백그라운드로 띄우고 로그만 남긴다:
> ( <zk-X509>/target/release/bundle/macos/zk-X509.app/Contents/MacOS/zk-x509-desktop \
>     > /tmp/zkx509-app.log 2>&1 & )
> ```
> **여기서 AI는 멈춘다.** 실제 **CA 등록과 지갑 신원검증(`register`)은 사람이** 한다 — 위에서 띄운
> **데스크탑 앱(zk-x509-desktop)** 또는 대시보드(http://localhost:3000)에서 인터랙티브로 직접. AI가 대신 하지 마라.
> (사람: 데스크탑 앱에서 실제 X.509 인증서로 CA 증명 생성/검증, 또는 대시보드 Identity → 레지스트리 선택 →
> seed된 테스트 CA에 대한 증명 제출.) AI는 "대시보드·데스크탑 앱이 떴고 레지스트리가 swap됐고 verify가
> 통과했다"까지만 보장하고, 그 사실을 보고해라.
> 주의: zk-X509의 실제 증명 생성(SP1 prover)은 Docker가 필요하다 — Docker 없이는 배포 + swap + (--quick) 검증까지만 된다.
>
> **종료**: `./scripts/dev.sh --stop` (저장된 PID kill + 8545/3002/3003/4000–4006 포트 스윕).
> zk-X509 서비스는 별도로: `cd <zk-X509> && bash script/stop-services.sh`
>
> 각 단계가 끝날 때마다 무엇이 떴고 어떤 URL로 접근하는지, 검증 결과가 통과/실패인지 한 줄로
> 요약하고, 실패는 로그 근거와 함께 알려줘.

---

## Ground-truth reference (what the prompt maps to)

| Goal | Command / mechanism | Notes |
|---|---|---|
| hub/pay/pro/operators/admin + 2 relayers + orderbook, background | `./scripts/dev.sh --mock --apps pay,pro,operators,admin,hub --background` | one command; detaches and survives terminal close |
| Fund testers ETH/USDC/USDT/TON | automatic in `DeployLocal.s.sol` (mock mode) → anvil #0–#10 get 100 WETH / 1M USDC / 1M USDT / 100k TON; ETH from anvil prefund | extra wallets: `apps/pay/e2e/_helpers/fund-wallet.ts` |
| zkey **offline** verify | `scripts/check-zk-artifacts.sh` | hashes local zkeys vs the deploy-time manifest; no chain needed |
| zkey **online** verify | submit a real proof to the deployed Verifier (e.g. a `zk-relayer/test/e2e-*.ts` proof flow, or browser deposit) | mismatch surfaces as `InvalidProof()` |
| zk-X509 on same anvil (front/back + verify) | `<zk-X509>/script/start-services.sh` → `deploy-on-existing-anvil.sh` → `verify-deployment.sh --quick` → `./scripts/swap-identity-registry.sh <reg>` | separate repo: `github.com/tokamak-network/zk-X509`; SP1 prover needs Docker. **CA registration + wallet identity verification is the human's interactive step** — via the dashboard (:3000) or the desktop app (build: `make desktop`; run: `<zk-X509>/target/release/bundle/macos/zk-X509.app/Contents/MacOS/zk-x509-desktop`). The AI only stands these up and confirms verify passes |
| Stop everything | `./scripts/dev.sh --stop` | kills tracked PIDs + sweeps dev ports |

See [local-setup.md](local-setup.md) for the full native runbook and the
"Integration Mode (with zk-X509)" section.
