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

## 프라이버시 요약

| 단계 | 온체인에 보이는 것 | 숨겨지는 것 |
|------|-----------------|-----------|
| 입금 | commitment 해시 | 누가, 얼마 |
| 주문 | 없음 (오프체인) | 전부 |
| 정산 | ZK proof + nullifiers | 거래자, 금액, 구조 |
| 수령 | ZK proof + 스텔스 주소 | 수신자 신원, 어떤 정산인지 |
