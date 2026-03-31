# TODO: Frontend V2 — 미구현 기능

## 1. Relayers 페이지
- 등록된 릴레이어 목록 (RelayerRegistry에서 조회)
- 각 릴레이어 정보: 주소, URL, 수수료율, 스테이킹 금액, 활성 상태
- 릴레이어별 오더북 보기 (해당 릴레이어의 `/api/orderbook` 호출)
- 릴레이어별 체결 통계 (settle 건수, 평균 체결 시간 등)

## 2. 주문 시 릴레이어 선택
- 현재: `RELAYER_URL` 환경변수 하나에 고정 제출
- 목표: 주문 폼에서 릴레이어를 선택하거나, 최적 릴레이어 자동 추천
- 추천 기준: 수수료율, 오더북 depth, 응답 속도, 체결률
- 여러 릴레이어에 동시 제출 옵션 (경쟁 체결)

## 3. Order Book 페이지 (`/trade/book`)
- 사이드바에 Book 링크 있으나 페이지 미구현
- 전체 오더북 뷰 (릴레이어별 또는 통합)
- 주문 상세 보기, 취소 기능

## 4. Dashboard 페이지
- 내 주문 현황 (pending, settled, cancelled)
- 내 claim 현황 (claimable, claimed, refundable)
- 에스크로 잔액 요약

## 5. Scatter Vault (수수료 관리)
- 수수료 금액을 Scatter Vault에 적립
- Vault에서 권한 가진 주소만 인출 가능
- 프로토콜 treasury 관리 UI
