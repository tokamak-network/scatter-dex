# ZK Private Trading Guide

ZK 프라이빗 거래의 전체 플로우와 로컬 테스트 방법입니다.

## Architecture

```
Frontend (:3000)
  ├── Private Escrow   → CommitmentPool (deposit)
  ├── Private Order    → zk-relayer (submit order)
  ├── Private Claim    → zk-relayer (gasless claimWithProof)
  └── Private History  → zk-relayer (query orders)

zk-relayer (:3002)
  ├── Order matching (EdDSA signature verification)
  ├── Groth16 proof generation (snarkjs)
  ├── settlePrivate() on-chain call
  └── Gasless claim (claimWithProof on behalf of recipient)

Contracts (anvil :8545)
  ├── CommitmentPool      — UTXO-based private escrow (Poseidon Merkle tree)
  ├── PrivateSettlement   — ZK settlement + claims
  └── Groth16 Verifiers   — WithdrawVerifier, SettleVerifier, ClaimVerifier
```

**참고**: 릴레이어 등록 시 bond 스테이킹은 선택사항입니다 (특허: "optionally stake a financial bond"). `minBond`은 owner가 설정 가능하며 기본값은 0입니다.

## 1. Quick Start

> **최초 1회 — ZK 회로 아티팩트 빌드 필요**
> `dev.sh`와 `make up`은 회로를 빌드하지 않습니다. 레포에는 `authorize.*` / `cancel.*` 만 커밋되어 있고, 나머지 4종(`deposit`, `withdraw`, `settle`, `claim`)은 아래 명령으로 직접 생성해야 프라이빗 트레이딩 플로우가 동작합니다:
>
> ```bash
> cd circuits && npm install && npm run build
> ```
>
> 빌드하지 않으면 브라우저 콘솔에 `CompileError: WebAssembly.compile(): expected magic word 00 61 73 6d, found 3c 21 44 4f` 가 발생합니다 (Next.js 404 HTML이 WASM 로더로 들어간 경우). 자세한 설명은 [docs/operations/local-setup.md](../operations/local-setup.md#prerequisite-build-zk-circuit-artifacts) 참고.

```bash
./scripts/dev.sh --mock
```

이 명령 하나로 **5개 서비스** 전부 시작됩니다:
1. anvil (로컬 블록체인)
2. 컨트랙트 배포 (일반 + ZK)
3. relayer (:3001, 일반 주문)
4. zk-relayer (:3002, ZK 프라이빗 주문)
5. frontend (:3000)

## 2. Private Escrow (ZK 입금)

http://localhost:3000/trade/private-escrow

1. 지갑 연결
2. **Select Folder** 클릭 → 노트 저장할 로컬 폴더 지정 (최초 1회)
3. 토큰 선택 (ETH, WETH, USDC)
4. 금액 입력
5. **Deposit Privately** 클릭
6. MetaMask에서 approve → deposit 서명 (ETH 선택 시 자동 WETH wrap)

입금 후:
- **Private Notes** 목록에 표시됨 (클릭하면 상세 정보)
- 온체인에는 commitment(해시)만 저장 → **누가 얼마 넣었는지 모름**
- 노트(secret/salt)는 지정한 폴더에 JSON 파일로 자동 저장됨

> **노트 파일을 잃으면 자금 회수 불가!** 지정한 폴더를 안전한 곳에 보관하세요.

## 3. Private Order (ZK 주문)

http://localhost:3000/trade/private-order

### 최초 1회: 트레이딩 키 생성
1. **Generate Key** 클릭
2. MetaMask에서 메시지 서명 → EdDSA 키 자동 유도
3. 이후 주문 서명 시 MetaMask 팝업 없이 즉시 서명됨

### 커밋먼트 선택
1. **Open Notes Folder** 클릭 → Private Escrow에서 사용한 같은 폴더 선택
2. Sell 토큰에 해당하는 노트 목록이 표시됨
3. 사용할 노트 선택 → sell amount 자동 입력

### 주문 제출
1. Sell/Buy 토큰과 금액 입력 (우측 PricePanel 참고)
2. **Max Relay Fee** 선택 (0.1%, 0.3%, 0.5%, 1%) — buyAmount가 자동 조정됨
3. Recipients (Scatter) 섹션에서 수신자 추가:
   - **Standard**: 일반 주소 (0x...)
   - **Stealth**: 메타주소 (st:eth:0x...) → 일회용 스텔스 주소 자동 생성
4. 만료 시간 선택
5. **Submit Private Order** 클릭
6. claim JSON 파일이 자동 다운로드됨 (stealth인 경우 ephemeralPubKey 포함)

### 수수료

릴레이어 수수료 (기본 30 bps = 0.3%)는 양쪽 sell 금액에서 차감됩니다.
- Alice sells 1 WETH → fee 0.003 WETH → 릴레이어
- Bob sells 100 USDC → fee 0.3 USDC → 릴레이어
- Alice claims: 99.7 USDC (100 - 0.3)
- Bob claims: 0.997 WETH (1 - 0.003)

**buyAmount는 "내가 받는 토큰" 기준의 최소 수령량입니다.** 내 수수료가 아니라 **상대방의 sell 금액에서 상대방 수수료가 차감된 후** 금액을 기준으로 설정해야 합니다. 예: Alice의 buyAmount는 Bob의 100 USDC에서 Bob의 fee 0.3 USDC가 차감된 99.7 이하여야 합니다. 회로가 `totalLockedMaker + feeTokenMaker <= takerSellAmount`를 검증합니다.

### 매칭 & 정산
매칭되면 zk-relayer가:
1. Groth16 proof 생성 (~수 초)
2. `settlePrivate()` 온체인 호출:
   - CommitmentPool → PrivateSettlement (claim 금액)
   - CommitmentPool → Relayer (수수료)
3. 온체인에 **누가 거래했는지, 얼마에 거래했는지** 보이지 않음

## 4. Private Claim (ZK 수령)

http://localhost:3000/trade/private-claim

1. **Load JSON File** 클릭 → 주문자로부터 받은 claim JSON 로드
2. 여러 claim이 있으면 선택 (multi-claim selector)
3. **Claim Preview** 에서 금액, 수신자, 릴리즈 시간 확인
4. Stealth claim인 경우 안내 표시 (ephemeralPubKey 감지)
5. **Generate Proof & Claim** 클릭
6. 브라우저에서 ZK proof 생성 (~2-3초)
7. proof가 **zk-relayer에 전송** → 릴레이어가 `claimWithProof()` 대신 호출 (gasless)
8. 자금이 수신자 주소로 전송됨

> **지갑 연결 불필요** — claim은 gasless (릴레이어가 가스 대납). 사용자가 직접 보내는 tx sender 지갑 주소는 온체인에 노출되지 않음. 단, 표준 주소 수령에서는 `recipient` 주소가 온체인에 포함될 수 있으며, stealth claim 사용 시에만 수신자의 실제 지갑과 unlink됩니다.
>
> **Claims는 만료 없이 영구적으로 수령 가능합니다.** releaseTime 이후 언제든 claim 가능.

## 5. Private History (주문 조회)

http://localhost:3000/trade/private-history

- EdDSA 키로 자동 로드 (또는 MetaMask에서 재생성)
- 상태 필터: All / Pending / Matched / Settled / Cancelled / Expired
- 페이지네이션 지원

---

## 수동 배포 (디버깅용)

`dev.sh` 대신 각 단계를 수동으로 실행하여 문제를 추적할 수 있습니다.

### Step 1: anvil 시작

```bash
anvil
```

### Step 2: 컨트랙트 배포

```bash
cd contracts
forge script script/DeployLocal.s.sol:DeployLocal \
  --rpc-url http://localhost:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

출력에서 주소를 확인하세요:
```
ScatterSettlement:     0x...
RelayerRegistry:       0x...
WETH:                  0x...
USDC:                  0x...
CommitmentPool:        0x...
PrivateSettlement:     0x...
```

### Step 3: 릴레이어 시작

```bash
cd relayer
cat > .env <<EOF
RPC_URL=http://localhost:8545
RELAYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
SETTLEMENT_ADDRESS=<ScatterSettlement 주소>
RELAYER_FEE=30
PORT=3001
EOF
npm run dev
```

### Step 4: ZK 릴레이어 시작

```bash
cd zk-relayer
cat > .env <<EOF
RPC_URL=http://localhost:8545
RELAYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
COMMITMENT_POOL_ADDRESS=<CommitmentPool 주소>
PRIVATE_SETTLEMENT_ADDRESS=<PrivateSettlement 주소>
RELAYER_FEE=30
PORT=3002
EOF
npm run dev
```

### Step 5: 프론트엔드 시작

```bash
cd frontend
cat > .env.local <<EOF
NEXT_PUBLIC_SETTLEMENT_ADDRESS=<ScatterSettlement 주소>
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=<RelayerRegistry 주소>
NEXT_PUBLIC_WETH_ADDRESS=<WETH 주소>
NEXT_PUBLIC_TOKENS=<WETH>:WETH:18,<USDC>:USDC:18
NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=<CommitmentPool 주소>
NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS=<PrivateSettlement 주소>
NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002
NEXT_PUBLIC_RPC_URL=http://localhost:8545
NEXT_PUBLIC_CHAIN_ID=31337
EOF
npm run dev
```

### 디버깅 팁

| 문제 | 확인 방법 |
|------|----------|
| 입금 실패 | `cast call` 로 `whitelistedTokens`, `allowance` 확인 |
| leaf index 항상 0 | 컨트랙트 재배포 필요 (이벤트 이름 변경 후) |
| 프론트엔드 pool 연결 안 됨 | `.env.local`에 `NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS` 확인 |
| ZK proof 생성 실패 | `frontend/public/zk/` 에 `.wasm`, `.zkey` 파일 존재 확인 |
| 온체인 이벤트 조회 | `cast logs --address <Pool> --from-block 0` |
| zk-relayer 매칭 안 됨 | `curl http://localhost:3002/api/info` 로 상태 확인 |
| settlePrivate 실패 | zk-relayer 로그 확인 (`.dev-logs/zk-relayer.log`) |
| TimestampOutOfRange | anvil block timestamp와 시스템 시간 차이 확인 |
| claim proof 실패 | claim JSON의 `allLeaves` (프론트엔드에서 `allClaimLeaves`로 사용)가 16개인지, leafIndex 범위 확인 |
| claims cap 실패 | `totalLocked + fee > 상대방의 sellAmount` → claims 금액을 상대방 sell에서 fee 차감 후로 조정 |
| InsufficientPoolBalance | CommitmentPool에 충분한 토큰이 있는지 확인 (deposit 선행 필요) |

---

## 보안 모델

### 서명으로 보호되는 것

| 항목 | 보호 방법 |
|------|----------|
| 주문 내용 (토큰, 금액, 가격) | EdDSA 서명 |
| Claim 수신자/금액 | claimsRoot가 EdDSA 서명에 포함 |
| 최소 수령 금액 | 회로: `totalLockedMaker >= makerBuyAmount` |
| Claims 총액 | 회로: `totalLockedMaker == sum(claim amounts)` |
| Claims + Fee 상한 | 회로: `totalLockedMaker + feeTokenMaker <= takerSellAmount` 및 `totalLockedTaker + feeTokenTaker <= makerSellAmount` |
| 수수료 | 회로: per-token fee floor-division 검증 (`feeTokenMaker`, `feeTokenTaker`) |
| Fee bps 상한 | 회로: `makerFee <= makerMaxFee` 및 `takerFee <= takerMaxFee`, 각각 Num2Bits(16) range check |
| 이중 지불 | 회로: settle/withdraw `nullifier = Poseidon(ownerSecret, salt)`, claim `nullifier = Poseidon(secret, leafIndex)` |

### 토큰 플로우

```
Deposit:  User wallet → CommitmentPool
Settle:   CommitmentPool → PrivateSettlement (claim 금액)
          CommitmentPool → Relayer (per-token 수수료)
          CommitmentPool keeps change (new commitment)
Claim:    Browser → zk-relayer API (proof) → claimWithProof (relayer pays gas)
          PrivateSettlement → Recipient (stealth or standard)
```

**Gasless claim**: 브라우저에서 proof 생성 → zk-relayer API로 전송 → 릴레이어가 온체인 tx 제출. 사용자 지갑은 gas를 내지 않고, msg.sender는 릴레이어.

### 프라이버시 요약

| 단계 | 온체인에 보이는 것 | 숨겨지는 것 |
|------|-----------------|-----------|
| 입금 | commitment 해시 | 누가, 얼마 |
| 주문 | 없음 (오프체인) | 전부 |
| 정산 | ZK proof + nullifiers (msg.sender = relayer) | 거래자, 금액, 구조 |
| 수령 | ZK proof + recipient + 금액 (msg.sender = relayer) | 어떤 정산인지, 수령자의 실제 신원 (stealth 사용 시) |

**프라이버시 범위**: gasless claim/relayer를 사용하면 settle/claim 단계의 온체인 `msg.sender` 는 사용자 대신 릴레이어로 보이며, stealth 주소를 사용하면 수신자 신원을 추가로 숨길 수 있습니다. 다만 사용자가 직접 보내는 deposit 등 온체인 자금 이동 트랜잭션은 별도이며, 이 경우 지갑 주소가 온체인에 노출될 수 있습니다.

## 회로 빌드

회로를 수정한 경우:

```bash
cd circuits
bash scripts/build.sh
```

이 스크립트는:
1. circom 컴파일 (r1cs + wasm)
2. Groth16 Phase 2 setup
3. Verification key + Solidity verifier 생성
4. `contracts/src/zk/` 와 `frontend/public/zk/` 에 복사

build.sh는 각 회로의 constraint 수에 맞게 PTAU 크기를 자동 결정합니다 (최소 pot14).
settle 회로: ~58K constraints → pot16. withdraw/claim: ~6K/~2K → pot14.

settle 회로 public inputs (16개):
`currentRoot(= commitmentRoot), makerNullifier, takerNullifier, makerNonceNullifier, takerNonceNullifier, makerNewCommitment, takerNewCommitment, claimsRootMaker, claimsRootTaker, totalLockedMaker, totalLockedTaker, tokenMaker, tokenTaker, feeTokenMaker, feeTokenTaker, currentTimestamp`
