# ZK Private Trading Guide

로컬 환경에서 ZK 프라이빗 거래를 테스트하는 방법입니다.

## 1. 로컬 환경 시작

```bash
./scripts/dev.sh --mock
```

이 명령 하나로 **일반 + ZK 컨트랙트 전부** 배포됩니다:
- anvil (로컬 블록체인)
- ScatterSettlement + RelayerRegistry (일반)
- CommitmentPool + PrivateSettlement + Verifiers (ZK)
- 릴레이어 + 프론트엔드

배포 완료 후 출력에서 `NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS`를 확인하세요.

`frontend/.env.local`에 없다면 추가 후 프론트엔드를 재시작하세요:
```
NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=<출력된 CommitmentPool 주소>
```

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

> ⚠️ **노트 파일을 잃으면 자금 회수 불가!**
> 지정한 폴더를 안전한 곳에 보관하세요.

## 3. Private Order (ZK 주문)

http://localhost:3000/trade/private-order

**최초 1회: 트레이딩 키 생성**
1. **Generate Key** 클릭
2. MetaMask에서 메시지 서명 → EdDSA 키 자동 유도
3. 이후 주문 서명 시 MetaMask 팝업 없이 즉시 서명됨

**주문 제출:**
1. Sell/Buy 토큰과 금액 입력
2. 만료 시간 선택
3. **Submit Private Order** 클릭
4. 릴레이어에 전송 (온체인 아님)

매칭되면 릴레이어가 ZK proof를 생성하고 `settlePrivate()`를 호출합니다.
→ 온체인에 **누가 거래했는지, 얼마에 거래했는지** 보이지 않음.

## 4. Claim (ZK 수령)

http://localhost:3000/claim

1. 시크릿 입력 (거래 상대방이 전달)
2. **Preview** 클릭 → 수령 가능 금액 확인
3. 수령 방법 선택:
   - **Standard**: 직접 클레임 (가스비 필요)
   - **Gasless**: 릴레이어가 가스 대납 (스텔스 주소로 수령)
4. 브라우저에서 ZK proof 생성 (~3초) → 클레임 완료

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

### Step 4: 프론트엔드 시작

```bash
cd frontend
cat > .env.local <<EOF
NEXT_PUBLIC_SETTLEMENT_ADDRESS=<ScatterSettlement 주소>
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=<RelayerRegistry 주소>
NEXT_PUBLIC_WETH_ADDRESS=<WETH 주소>
NEXT_PUBLIC_TOKENS=<WETH>:WETH:18,<USDC>:USDC:18
NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=<CommitmentPool 주소>
NEXT_PUBLIC_RPC_URL=http://localhost:8545
NEXT_PUBLIC_CHAIN_ID=31337
EOF
npm run dev
```

### Step 5: 토큰 화이트리스트 확인

```bash
# CommitmentPool에 토큰이 화이트리스트되어 있는지 확인
cast call <CommitmentPool> "whitelistedTokens(address)(bool)" <WETH> --rpc-url http://localhost:8545
cast call <CommitmentPool> "whitelistedTokens(address)(bool)" <USDC> --rpc-url http://localhost:8545
```

### Step 6: 테스트 입금 (CLI에서 직접)

```bash
# 1. WETH wrap
cast send <WETH> "deposit()" --value 1ether \
  --private-key <유저 키> --rpc-url http://localhost:8545

# 2. approve
cast send <WETH> "approve(address,uint256)" <CommitmentPool> 1000000000000000000 \
  --private-key <유저 키> --rpc-url http://localhost:8545

# 3. deposit (commitment은 아무 값 — 테스트용)
cast send <CommitmentPool> "deposit(uint256,address,uint256)" 12345 <WETH> 1000000000000000000 \
  --private-key <유저 키> --rpc-url http://localhost:8545

# 4. 확인
cast call <CommitmentPool> "nextIndex()(uint32)" --rpc-url http://localhost:8545
cast call <CommitmentPool> "getLastRoot()(uint256)" --rpc-url http://localhost:8545
```

### 디버깅 팁

| 문제 | 확인 방법 |
|------|----------|
| 입금 실패 | `cast call` 로 `whitelistedTokens`, `allowance` 확인 |
| leaf index 항상 0 | 컨트랙트 재배포 필요 (이벤트 이름 변경 후) |
| 프론트엔드 pool 연결 안 됨 | `.env.local`에 `NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS` 확인 |
| ZK proof 생성 실패 | `frontend/public/zk/` 에 `.wasm`, `.zkey` 파일 존재 확인 |
| 온체인 이벤트 조회 | `cast logs --address <Pool> --from-block 0` |

---

## 프라이버시 요약

| 단계 | 온체인에 보이는 것 | 숨겨지는 것 |
|------|-----------------|-----------|
| 입금 | commitment 해시 | 누가, 얼마 |
| 주문 | 없음 (오프체인) | 전부 |
| 정산 | ZK proof + nullifiers | 거래자, 금액, 구조 |
| 수령 | ZK proof + 스텔스 주소 | 수신자 신원, 어떤 정산인지 |
