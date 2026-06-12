# Archived design docs

현재 코드와 맞지 않는(폐기·완료·실행종료) 설계 문서 보관소. 현행 설계는 [`docs/design/`](../) 와 [`docs/README.md`](../../README.md) 참조.

| 문서 | 보관 사유 |
|---|---|
| [zk-escrow.md](zk-escrow.md) | 모놀리식 `settle.circom` / `settlePrivate()` 원설계 — Half-proof([circuit-split](../circuit-split/design.md))로 대체, 레거시 코드 삭제됨 |
| [zk-settle-stealth.md](zk-settle-stealth.md) | 스텔스 주소 정산 설계 — [ADR-0001](../../architecture-decisions/0001-stealth-deprecation.md)로 스텔스 표면 전체 폐기 |
| [stealth-address-claim.md](stealth-address-claim.md) | 스텔스 claim 수령 설계 — 동일하게 ADR-0001로 폐기 |
| [stealth-announcer.md](stealth-announcer.md) | 미구현 제안(deferred) — 스텔스 폐기로 무의미해짐 |
| [claim-to-pool.md](claim-to-pool.md) | 기능 자체가 제거됨 — 제거 사유의 감사 기록 |
| [upgradeable-migration.md](upgradeable-migration.md) | 프록시 전환 계획·트래킹 — 마이그레이션 완료(PR #659), 계획 문서로서 수명 종료 |
| [relayer-pages-redesign.md](relayer-pages-redesign.md) | 릴레이어 페이지 재구성 기획 초안 — 단계적으로 실행 완료(operators 앱 분리, settlements 인덱서, treasury board), "현재 상태" 서술이 더 이상 유효하지 않음 |
