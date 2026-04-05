# ZK Private Trading Guide

로컬 환경에서 ZK 프라이빗 거래를 테스트하는 방법입니다.

> 사전 조건: `./scripts/dev.sh --mock`으로 로컬 환경이 실행 중이어야 합니다.

## 1. ZK 컨트랙트 배포

```bash
cd contracts
forge script script/DeployPrivateSettlement.s.sol:DeployPrivateSettlement \
  --rpc-url http://localhost:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

출력에서 주소를 복사하세요:
```
CommitmentPool:        0x...
PrivateSettlement:     0x...
```

`frontend/.env.local`에 추가 후 프론트엔드를 재시작하세요:
```
NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=<CommitmentPool 주소>
```

## 2. Private Escrow (ZK 입금)

http://localhost:3000/trade/private-escrow

1. 지갑 연결
2. 토큰 선택 (WETH 또는 USDC)
3. 금액 입력
4. **Deposit Privately** 클릭
5. MetaMask에서 approve → deposit 서명

입금 후:
- **Private Notes** 목록에 표시됨
- 온체인에는 commitment(해시)만 저장 → **누가 얼마 넣었는지 모름**
- 노트(secret/salt)는 브라우저에 저장됨

> ⚠️ **Backup 필수!** 노트를 잃으면 자금 회수 불가.
> Backup 버튼으로 JSON 파일을 다운로드하세요.

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

## 프라이버시 요약

| 단계 | 온체인에 보이는 것 | 숨겨지는 것 |
|------|-----------------|-----------|
| 입금 | commitment 해시 | 누가, 얼마 |
| 주문 | 없음 (오프체인) | 전부 |
| 정산 | ZK proof + nullifiers | 거래자, 금액, 구조 |
| 수령 | ZK proof + 스텔스 주소 | 수신자 신원, 어떤 정산인지 |
