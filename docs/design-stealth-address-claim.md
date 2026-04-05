# Design: Stealth Address for Claim Recipients

**Status: IN PROGRESS**

## Summary

현재 fresh address 방식을 EIP-5564 Stealth Address로 교체. 수신자 프라이버시를 사용자 실수 의존에서 암호학적 보장으로 격상.

## Current (Fresh Address)

- 수신자가 매번 새 지갑 생성
- 수동으로 주소 공유
- 재사용/연결 시 프라이버시 깨짐

## Proposed (Stealth Address)

- 수신자가 meta-address 한 번 공개
- 송신자가 일회용 stealth address 자동 생성
- claimHash = H(secret, stealthAddress)
- 수신자만 개인키 유도 가능

## Changes Required

- [x] Stealth address 생성 라이브러리 (프론트엔드) — `frontend/app/lib/stealth.ts`
- [ ] Ephemeral pubkey 게시 메커니즘 (온체인 또는 오프체인)
- [ ] 수신자 스캐닝 로직 (자기에게 온 stealth 주소 탐색)
- [x] OrderForm에서 meta-address 입력 → stealth address 자동 생성
- [x] Claim 페이지에서 stealth key 유도 + claim

## Open Questions

- ephemeral pubkey를 온체인에 저장할지 오프체인(릴레이어)에 저장할지
- EIP-5564 표준 그대로 쓸지 커스텀할지
- 가스비 영향
