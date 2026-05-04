# ScatterDEX 모바일 앱 — 구현 문서

> **스냅샷**: 2026-04-21, `main` 기준
> **플랫폼**: Android + iOS, Expo 54 + React Native 0.81 + Hermes + 숨김 WebView(ZK)
> **단일 source of truth** — 드리프트 막기 위해 이 파일만 유지. 새 설계 메모를 별도로 만들지 마세요.

---

## 목차

1. [플랫폼 보안 스택 — 모바일 고유 요소](#1-플랫폼-보안-스택--모바일-고유-요소)
2. [시큐어 공간에 저장/읽기](#2-시큐어-공간에-저장읽기)
3. [생체 인증 게이트](#3-생체-인증-게이트)
4. [시스템 구성 — 서비스 인벤토리](#4-시스템-구성--서비스-인벤토리)
5. [서비스별 저장소 스키마](#5-서비스별-저장소-스키마)
6. [멀티월렛 아키텍처](#6-멀티월렛-아키텍처)
7. [지갑 생성/복구 로직 (모바일 고유)](#7-지갑-생성복구-로직-모바일-고유)
8. [Per-address 네임스페이싱과 레거시 마이그레이션](#8-per-address-네임스페이싱과-레거시-마이그레이션)
9. [스텔스 주소 (EIP-5564) 수신 흐름](#9-스텔스-주소-eip-5564-수신-흐름)
10. [ZK 하이브리드 아키텍처](#10-zk-하이브리드-아키텍처)
11. [WalletConnect 흐름](#11-walletconnect-흐름)
12. [기여자 가이드라인](#12-기여자-가이드라인)
13. [부록 — 파일 구조](#13-부록--파일-구조)

---

## 1. 플랫폼 보안 스택 — 모바일 고유 요소

웹 프론트엔드에 대응되는 개념이 없는 영역입니다. 앱은 OS가 제공하는 두 저장소와 생체 인증에 의존합니다.

### 1.1 두 저장소의 차이

| 구분 | `expo-secure-store` | `@react-native-async-storage/async-storage` |
|------|---------------------|----------------------------------------------|
| **iOS 구현** | **Keychain** — OS 암호화 키 저장소. 디바이스 passcode/생체 기반 Secure Enclave 접근 | `NSUserDefaults` → 파일 시스템에 평문 plist |
| **Android 구현** | **AndroidKeyStore** 기반 **EncryptedSharedPreferences** — 하드웨어 키(TEE/StrongBox) AES-GCM 암호화 | **SQLite** 파일, 앱 샌드박스에만 있는 평문 |
| **암호화** | ✅ OS 수준 (하드웨어 키 파생) | ❌ 없음 (앱 샌드박스 격리만) |
| **기기 바인딩** | `WHEN_UNLOCKED_THIS_DEVICE_ONLY` 플래그 시 **다른 기기 복원 불가** | 일반 백업에 포함되어 다른 기기로 복원 가능 |
| **잠금 상태 접근** | 기기 잠금 해제 후에만 읽기 가능(부팅 직후 첫 unlock 전 차단) | 앱 실행 중 언제든 접근 |
| **크기 제한** | iOS 무제한 / **Android ~2KB 권장** (초과 시 크래시) | 실질 무제한 (수 MB도 가능) |
| **API 형식** | 모두 async(`setItemAsync` 등) | 모두 async(`setItem` 등) + multi 지원 |
| **루팅/탈옥 기기 노출** | 공격 난이도 높음(하드웨어 키 필요) | **평문 노출 가능** |

**사용 규칙 (이 앱에서)**:
- **secret/key/mnemonic** 은 **무조건** `expo-secure-store`
- **공개 메타데이터/인덱스/네트워크 구성** 은 `AsyncStorage`
- **혼합 페이로드** (예: 클레임 = secret + 큰 메타데이터 + allLeaves 배열) 는 **분할 저장** — secret만 SecureStore, 나머지는 AsyncStorage. Android 2KB 제한이 이 분할의 실질적 이유이기도 함.

### 1.2 SecureStore 접근성 플래그

민감 blob 저장 시 항상 이 플래그를 지정합니다:

```ts
import * as SecureStore from 'expo-secure-store';

await SecureStore.setItemAsync(
  'scatterdex_wallet_secret_<id>',
  JSON.stringify({ privateKey, mnemonic }),
  { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
);
```

의미:
- **기기 바인딩**: 다른 기기로 OS 백업을 복원해도 이 blob은 따라가지 않음.
- **잠금 상태**: 기기가 잠금 해제 된 상태에서만 읽기/쓰기 가능. 부팅 직후 passcode 입력 전에는 Keychain이 잠겨 있음.

공개 데이터(예: 지갑 주소)는 플래그 없이 저장 가능:

```ts
await SecureStore.setItemAsync('scatterdex_wallet_address', address);
// 플래그 없으면 기본값 AFTER_FIRST_UNLOCK (부팅 후 1회 unlock 이후 항상 접근)
```

---

## 2. 시큐어 공간에 저장/읽기

### 2.1 SecureStore — 전형적 패턴

**쓰기**:
```ts
import * as SecureStore from 'expo-secure-store';

const SECURE_OPTS = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
} as const;

async function writeSecret(id: string, secret: WalletSecret): Promise<void> {
  await SecureStore.setItemAsync(
    `scatterdex_wallet_secret_${id}`,
    JSON.stringify(secret),
    SECURE_OPTS,
  );
}
```

**읽기**:
```ts
async function readSecret(id: string): Promise<WalletSecret | null> {
  const raw = await SecureStore.getItemAsync(`scatterdex_wallet_secret_${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WalletSecret;
  } catch {
    return null; // 손상된 entry는 null 반환 (상위에서 delete 후 재유도 처리)
  }
}
```

**삭제**:
```ts
await SecureStore.deleteItemAsync(`scatterdex_wallet_secret_${id}`);
```

**병렬 I/O**:
```ts
// 서로 독립적인 여러 키를 동시에 처리 — Promise.all 로 round-trip 절약.
// SecureStore는 내부적으로 직렬화되므로 CPU 병렬성은 없지만
// JS 쪽 오버헤드와 await chain 숏닝으로 체감 지연 감소.
const [addr, pk, mnemonic] = await Promise.all([
  SecureStore.getItemAsync(ADDRESS_KEY),
  SecureStore.getItemAsync(WALLET_KEY),
  SecureStore.getItemAsync(MNEMONIC_KEY),
]);
```

### 2.2 AsyncStorage — 전형적 패턴

**쓰기/읽기**:
```ts
import AsyncStorage from '@react-native-async-storage/async-storage';

// 쓰기
await AsyncStorage.setItem(
  `scatterdex_note_index_${address.toLowerCase()}`,
  JSON.stringify(noteIds),
);

// 읽기
const raw = await AsyncStorage.getItem(`scatterdex_note_index_${address.toLowerCase()}`);
const ids = raw ? JSON.parse(raw) as string[] : [];

// 삭제
await AsyncStorage.removeItem(`scatterdex_note_index_${address.toLowerCase()}`);
```

**배치 I/O**:
```ts
// 여러 키를 한 번에 읽기/쓰기
const entries = await AsyncStorage.multiGet([key1, key2, key3]);
await AsyncStorage.multiSet([[key1, val1], [key2, val2]]);
```

### 2.3 분할 저장 패턴 — 대용량 + 민감 데이터

클레임(`PendingClaimsStorage`)은 전형적 분할 예:

```ts
// 민감: secret 문자열만 SecureStore
await SecureStore.setItemAsync(
  `scatterdex_pending_claim_secret_${address.toLowerCase()}_${id}`,
  secret,
  SECURE_OPTS,
);

// 메타: allLeaves 배열 등 큰 페이로드는 AsyncStorage
await AsyncStorage.setItem(
  `scatterdex_pending_claim_meta_${address.toLowerCase()}_${id}`,
  JSON.stringify({ recipient, token, amount, releaseTime, leafIndex, allLeaves, txHash }),
);

// 인덱스: id 배열 (작고 비민감) AsyncStorage
await AsyncStorage.setItem(
  `scatterdex_pending_claim_ids_${address.toLowerCase()}`,
  JSON.stringify([...existingIds, id]),
);
```

근거:
- Android SecureStore entry당 ~2KB 제한으로 `allLeaves` 같은 배열은 비정상 크래시 유발.
- `secret`이 유일한 spend 권한 → 분리된 SecureStore blob으로 최소 공격 표면 유지.
- 인덱스 조회는 빈번하므로 Async 평문 OK.

### 2.4 에러 처리 관례

- **JSON.parse 실패**: 손상된 entry는 `null` 반환 + 해당 키 best-effort 삭제 → 다음 호출이 정상 경로(재유도)로 감. `EdDSAKeyService.loadKey`, `KeySecurityService.readSecret` 등이 표준 예.
- **일시적 Keychain 오류**: 마이그레이션의 module-level promise latch는 실패 시 latch 리셋 → 다음 호출이 재시도.

---

## 3. 생체 인증 게이트

`expo-local-authentication` + `KeySecurityService` 로 중앙화.

```ts
// 사용자가 Settings 토글로 on/off. 토글 off 면 게이트는 no-op.
async _biometricGate(reason: string): Promise<boolean> {
  if (!(await this.isBiometricEnabled())) return true;
  return this.authenticate(reason);
},

async authenticate(reason: string): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,                  // OS 시트에 표시될 "무엇을 승인"
    fallbackLabel: 'Use passcode',          // 생체 미등록 사용자 대응
    disableDeviceFallback: false,
  });
  return result.success;
},
```

**게이트 적용 지점**:
- 개인키 노출 (`getPrivateKey`)
- 시드 구문 노출 (`getMnemonic`)
- Signer 인스턴스화 (`getSigner*`)
- 모든 쓰기 서비스(Order/Market/Cancel/Deposit/Claim/Stealth)의 `authorizeTransaction(description)`

**프롬프트 메시지 규칙**: 항상 사람이 읽을 수 있는 `reason` — 예: `Approve: Submit order`, `Authenticate to view recovery phrase`. "Authenticate" 같은 일반 문구는 사용자가 맹목적으로 통과하도록 훈련시키므로 금지.

---

## 4. 시스템 구성 — 서비스 인벤토리

`mobile/src/services/` 하위 **18개 서비스 + `WalletContext`**.

### 4.1 지갑 + 키 재료

- **`KeySecurityService`** — 멀티월렛 스토리지 레이어. `wallets_index` / `wallets_active_id` / `wallet_secret_<id>` 스키마 + 생체 게이트. API: `listWallets / getActiveWalletId / setActiveWalletId / getActiveAddress / getSignerForWallet / createWallet / importFromMnemonic / importFromPrivateKey / deleteWallet` + 레거시 호환(`getAddress / getPrivateKey / getSigner / getMnemonic / hasWallet`).
- **`WalletContext`** (`src/contexts/WalletContext.tsx`) — 유일한 React 진입점. `wallets / activeWalletId / connectionMode / account / signer / readProvider` + `switchWallet / addWalletFromCreate / addWalletFromMnemonic / addWalletFromPrivateKey / removeWallet / refreshWallets / disconnect / connectBuiltin`. `notifyWalletSwitch(newAddr)` 로 per-address 캐시 재구독 신호 발신.
- **`EdDSAKeyService`** — 회로 서명용 BabyJub EdDSA 키 유도/저장, per wallet address. `deriveKey`는 stateless(Signer → 키), `getOrDeriveKey`는 SecureStore 조회 후 없으면 유도-저장.
- **`StealthIdentityService`** — EIP-5564 meta-address 생성/저장, per wallet address. spending + viewing 키를 보관(앱에서 가장 민감한 blob).

### 4.2 저장소 / 데이터

- **`NoteStorageService`** — per-wallet 노트 인덱스 + per-note SecureStore blob. 노트는 `secret + salt` 포함.
- **`PendingClaimsStorage`** — per-wallet pending-claim 인덱스, 분할 저장(메타 Async, secret Secure), 2단 마이그레이션(v0 → v1 → v2), 동시호출 latch.
- **`AddressBookService`** — per-wallet 라벨드 수신자(AsyncStorage, 비민감). EOA와 스텔스 meta-address 모두 지원.
- **`EscrowHiddenStorage`** — DepositScreen에서 사용자가 숨긴 escrow commitment 리스트, per wallet.
- **`BackupService`** — SecureStore + AsyncStorage 슬라이스를 묶어 export/restore. 사용자 비밀번호 기반 PBKDF2 → AES-GCM.

### 4.3 트랜잭션 흐름

- **`OrderService`** — Private 지정가 주문: authorize proof → relayer 제출 → 노트 spent 처리 전에 per-claim secret을 `PendingClaimsStorage.append`.
- **`MarketOrderService`** — 시장가: authorize proof + 온체인 `settleWithDex`. 모든 proof-검증 필드를 public signals(`ps[]`)에서 직접 소싱하여 로컬/서명 드리프트 방지.
- **`CancelService`** — cancel proof 발행으로 escrow 노트 취소. 커밋먼트 rotate.
- **`ClaimService`** — 정산 후 클레임. `PendingClaimsStorage`에서 secret 조회 + claim proof 빌드.
- **`DepositService`** — 입금 흐름(ETH는 wrap, 커밋먼트 생성, 풀로 deposit).

### 4.4 인프라

- **`NetworkService`** — 내장 + 커스텀 네트워크 레지스트리. Settings → Add Custom Network 모달이 `addCustomNetwork / removeCustomNetwork / testConnection`.
- **`TokenService`** — 토큰 리스트 + 온체인 `decimals()` 조회(Promise 캐시로 동시 호출 dedupe). `ProviderService.subscribeReset`에 캐시 wipe 구독.
- **`ConfigService`** — env 기반 구성(컨트랙트 주소, RPC, WETH). `NetworkService` 위 단일 표면.
- **`ProviderService`** — `ethers.JsonRpcProvider` 풀(RPC URL 키), reset 이벤트 방송.
- **`RelayerApiService`** — relayer discovery + capability 폴링 + 주문 제출 HTTP 클라이언트.

### 4.5 오프로드된 ZK

- **`ZKBridgeService`** — Hermes ↔ 숨김 WebView 브리지. `waitReady(timeoutMs)` 는 `ZKReadyStatus`(ready/failed/timeout) 반환. `deriveEdDSAKey / sign_eddsa / groth16_fullProve / verify` 등 노출. 모든 회로 prover가 여기로 흐름.

---

## 5. 서비스별 저장소 스키마

Address-민감 키는 모두 `<prefix>_<addr>`(소문자) 네임스페이스.

| 서비스 | 키 | 저장소 |
|--------|-----|--------|
| `KeySecurityService` | `scatterdex_wallets_index` | Async (JSON `WalletMeta[]`) |
|  | `scatterdex_wallets_active_id` | Async |
|  | `scatterdex_wallet_secret_<id>` | **Secure** + 생체 게이트 |
|  | `scatterdex_biometric_enabled` | Secure |
|  | `scatterdex_wallet_pk` / `_mnemonic` / `_address` (레거시 미러) | Secure (pk/mnemonic) / Secure (address) |
| `EdDSAKeyService` | `scatterdex_eddsa_<addr>` | Secure |
| `StealthIdentityService` | `scatterdex_stealth_identity_v1_<addr>` | Secure |
|  | `scatterdex_stealth_migrated_v2` | Secure |
| `PendingClaimsStorage` | `scatterdex_pending_claim_ids_<addr>` | Async |
|  | `scatterdex_pending_claim_meta_<addr>_<id>` | Async |
|  | `scatterdex_pending_claim_secret_<addr>_<id>` | **Secure** |
|  | `scatterdex_pending_claims_migrated_v1` / `_v2` | Async |
| `NoteStorageService` | `scatterdex_note_index_<addr>` | Async |
|  | `scatterdex_note_<addr>_<id>` | **Secure** (노트에 secret+salt) |
|  | `scatterdex_migrated_notes_v2` | Async |
| `AddressBookService` | `scatterdex_wallet_book_v1_<addr>` | Async |
|  | `scatterdex_wallet_book_migrated_v2` | Async |
| `EscrowHiddenStorage` | `scatterdex_escrow_hidden_<addr>` | Async |
| `NetworkService` | `scatterdex_networks_custom` / `_selected` | Async |

---

## 6. 멀티월렛 아키텍처

### 6.1 데이터 모델

```
SecureStore (기기 바인딩, 생체 게이트 가능):
  scatterdex_wallets_index        → JSON WalletMeta[]
  scatterdex_wallets_active_id    → 활성 wallet id (uuid)
  scatterdex_wallet_secret_<id>   → JSON { privateKey, mnemonic? }
  scatterdex_biometric_enabled    → 'true' | 'false'

  -- 레거시 미러 (다른 서비스의 per-address 마이그레이션 가드용):
  scatterdex_wallet_pk / _mnemonic / _address
```

```ts
type WalletSource = 'mnemonic' | 'privateKey' | 'created';

interface WalletMeta {
  id: string;              // uuid — 각 account 고유
  address: string;         // 체크섬 0x…
  nickname?: string;       // 기본 'Wallet N'
  source: WalletSource;
  createdAt: number;       // unix ms

  // HD derivation 그룹핑 (선택적 — 상세는 §7.2)
  seedId?: string;         // 같은 mnemonic 에서 파생된 entry 공유 그룹 id
  derivationIndex?: number; // 그 seed 안에서의 BIP-44 account index
}

interface WalletSecret {
  privateKey: string;
  mnemonic?: string;
}
```

### 6.2 불변식

1. **입력은 체크섬, 저장 키 suffix는 소문자.** `WalletMeta.address`는 `ethers.getAddress` 적용. 저장 키 suffix는 `address.toLowerCase()`. `lib/address.ts → eqAddr(a, b)` 가 case-insensitive 비교를 중앙화.
2. **단일 mnemonic 불변식.** 이미 mnemonic을 관리하는 기기는 **다른** mnemonic을 import 불가. `importFromMnemonic`은 BIP-44 경로로 다음 account를 유도하고 `reusedSeed: true` 반환. 다른 mnemonic은 거부. 상세 케이스 분석은 §7.3–§7.4.
3. **레거시 미러는 활성 지갑을 반영.** 모든 `setActiveWalletId` / 삭제-후-승계 시 활성 지갑의 `{ pk, mnemonic?, address }` 를 레거시 키에 기록.
4. **파괴적 no-arg 가드.** `deleteWallet()` 에 id 없고 active id도 없을 때, `wallets_index`가 비어있지 않으면 거부.

### 6.3 지갑 전환 파이프라인

```
사용자가 wallet row 탭
  ├─ SettingsScreen.handleSwitchWallet(id)
  │    └─ 가드: same id ? / walletLoading ? → bail
  ├─ WalletContext.switchWallet(id)
  │    ├─ KeySecurityService.setActiveWalletId(id)
  │    │    ├─ meta + secret 읽기
  │    │    ├─ ACTIVE_WALLET_ID_KEY 쓰기
  │    │    └─ mirrorLegacyFromSecret(secret, meta.address)
  │    ├─ React state(account, signer, wallets) 재수화
  │    └─ notifySubscribers(newAddr)  ← subscribeWalletSwitch 훅
  └─ 훅 구독한 화면은 무효화/재조회:
       NoteStorage, Stealth, AddressBook, PendingClaims, EscrowHidden,
       Settings/History의 EdDSA in-memory 캐시
```

---

## 7. 지갑 생성/복구 로직 (모바일 고유)

웹 프론트엔드에는 존재하지 않는 기능입니다(웹은 외부 지갑 `window.ethereum`에 의존). 모바일은 앱이 **시드와 개인키를 직접 관리**하므로 생성/복구 정책이 중요합니다.

### 7.1 핵심 원칙: "한 기기에 하나의 mnemonic"

- **사용자가 백업해야 할 recovery phrase는 단 하나**. Created / Imported-from-mnemonic 지갑을 몇 개 만들든 모두 같은 BIP-39 seed에서 파생.
- **BIP-44 경로**: `m/44'/60'/0'/0/<derivationIndex>` (Ethereum mainnet coin type 60). 같은 seed에서 `derivationIndex` 만 증가시켜 새 account 생성.
- **`privateKey` import 는 예외** — 원본 mnemonic 없이 들어온 키는 standalone entry (seedId 없음).

### 7.2 `WalletMeta` HD 필드

전체 타입 정의는 §6.1 참조. HD 관련 두 필드:

- **`seedId?: string`** — 같은 BIP-39 mnemonic 에서 파생된 entry 들이 공유하는 그룹 id. 같은 seedId 를 가진 모든 wallet 은 같은 recovery phrase 로 복원 가능.
- **`derivationIndex?: number`** — 그 seed 안에서의 BIP-44 account index. 경로는 `m/44'/60'/0'/0/<derivationIndex>`.

**legacy 호환**: Phase 1 이전에 생성된 단일 지갑은 `seedId` / `derivationIndex` 가 `undefined`. Caller 는 이를 "standalone seed, index 0"으로 해석. 첫 reuse 시 자신의 `id` 를 `seedId` 로 채택.

### 7.3 `createWallet(nickname?)` — 세 가지 분기

입력: 선택적 nickname. 반환: `{ id, address, reusedSeed: true }` (phrase 감춤) 또는 `{ id, address, mnemonic, reusedSeed: false }` (새 phrase 노출).

**분기 A — reuse (happy path)**: 이미 seed-backed 지갑(`source === 'created' || 'mnemonic'`)이 있을 때.

```
1. ensureMigrated() + readIndex() → candidates 수집
   (새 포맷 seedId 있는 것 우선, 그 다음 legacy)
2. authenticate('Authenticate to derive a new account')
   ← _biometricGate 가 아님. getMnemonic 과 같은 수준(생체 OFF 이어도 프롬프트).
   실패 시 throw.
3. 후보 루프: readSecret(hosted.id).mnemonic 을 찾을 때까지
   - 실패하면 console.warn 로그 남기고 다음 후보
4. 찾은 mnemonic + seedId + 기존 derivationIndex 최대치+1 로
   HDNodeWallet.fromPhrase(mnemonic, undefined,
     `m/44'/60'/0'/0/${nextIndex}`)
5. addWalletInternal( pk, address, mnemonic, 'created', nickname,
                      { seedId, derivationIndex: nextIndex } )
6. 반환: { id, address, reusedSeed: true } ← mnemonic 노출 안 함
```

`mnemonic` 을 반환값에서 **의도적으로 생략** — 사용자가 이미 저장한 phrase 를 다시 보여줄 이유가 없고, JS 메모리 체류 시간도 최소화(크래시 리포트/로그 노출 표면 축소).

**분기 B — 모든 후보 부패**: candidates 있는데 모두 mnemonic 읽기 실패.

```
1. 루프가 끝까지 돌면서 매번 console.warn
2. 소실 로그 후 아래 분기 C 로 fall-through (fresh mint)
```

corruption 시나리오: iOS Keychain ACL 변경, 전원 중단 마이그레이션, SecureStore 쓰기 실패 등. 실패가 **첫 후보에서 멈추지 않음** — 같은 seed 에서 파생된 형제 entry 가 멀쩡할 수 있으므로 전부 시도.

**분기 C — fresh mint**: 기존 seed 없음 (빈 index, 또는 privateKey-import 뿐, 또는 분기 B 까지 도달).

```
1. ethers.Wallet.createRandom() → 새 mnemonic + 새 HD root
2. seedId = generateWalletId() (uuid)
3. addWalletInternal( pk, address, mnemonic, 'created', nickname,
                      { seedId, derivationIndex: 0 } )
4. 반환: { id, address, mnemonic, reusedSeed: false } ← phrase 노출
```

이 경로는 "진짜 첫 지갑" 또는 seed 복구 불가 상황. UI 가 반환된 `mnemonic` 을 반드시 저장 안내 alert 에 표시.

### 7.4 `importFromMnemonic(mnemonic, nickname?)` — 세 가지 케이스

입력: BIP-39 phrase + 선택적 nickname. 반환: `{ address, reusedSeed: boolean }`.

| 상황 | 동작 | reusedSeed |
|------|------|-----------|
| seed-backed 지갑 없음 | phrase 를 기기 seed 로 anchor, index 0 | `false` |
| **같은** mnemonic 이 이미 있음 | 그 seed 에서 다음 free BIP-44 index 파생 (Create 와 동일) | `true` |
| **다른** mnemonic 이 이미 있음 | **거부** — `Error('This device already manages a recovery phrase...')` | — |

세 번째 케이스가 **단일-mnemonic 불변식**을 보장. 사용자가 다른 phrase 를 복구하려면 먼저 기존 seed-backed 지갑을 모두 삭제해야 함.

```
1. ensureMigrated() + readIndex()
2. hosted = 새 포맷 seeded wallet ?? legacy seeded wallet
3. hosted 있음:
   3a. _biometricGate('Authenticate to import recovery phrase')
   3b. readSecret(hosted.id).mnemonic 과 입력 trim 비교
   3c. 동일 → 다음 derivationIndex 로 새 account 파생 (reusedSeed: true)
   3d. 다름 → throw (위의 안내 문구)
4. hosted 없음:
   4a. ethers.Wallet.fromPhrase(trimmed) — phrase 검증 겸 첫 account 파생
   4b. seedId = generateWalletId(), derivationIndex = 0
   4c. reusedSeed: false
```

### 7.5 `importFromPrivateKey(privateKey, nickname?)`

```ts
// 1. '0x' prefix 정규화
// 2. ethers.Wallet(pk) 로 주소 파생
// 3. addWalletInternal(..., { seedId: undefined, derivationIndex: undefined })
// 4. 반환: address (string)
```

- standalone 엔트리. seedId 없음 → `createWallet` 의 candidates 풀에 포함되지 않음.
- 사용자가 이 지갑으로 Create 를 눌러도 **새 mnemonic이 mint** 됨 (이 키는 phrase 로 복원 불가이므로).

### 7.6 `deleteWallet(id?)` 와 mnemonic 수명

- `deleteWallet(id)` 는 해당 entry 의 `wallet_secret_<id>` 를 삭제.
- 같은 `seedId` 를 공유하는 다른 wallet 이 남아 있으면 mnemonic 은 기기에 **계속 존재** (그쪽 entry 의 SecureStore 에).
- 마지막 seed-backed 지갑이 삭제되면 mnemonic 도 함께 제거 — 기기에서 그 phrase 가 사라짐.
- `deleteWallet()` no-arg + empty index → 레거시 키(`scatterdex_wallet_pk/_mnemonic/_address`) 만 wipe. index 가 비어있지 않은 상태에서 no-arg 는 **거부** (§6.2 invariant 4).

### 7.7 생체 게이트 정책 (`authenticate` vs `_biometricGate`)

- `createWallet` 의 reuse 분기 → **항상 `authenticate`** (생체 토글 OFF 여도 프롬프트).
- `importFromMnemonic` 의 reuse-or-reject 분기 → **`_biometricGate`** (토글 OFF 면 no-op).
- `getMnemonic` (phrase 조회) → **`authenticate`**.

**근거**: `createWallet` 의 reuse 분기는 내부적으로 mnemonic 을 메모리에 꺼낸 뒤 `HDNodeWallet.fromPhrase` 로 파생. `getMnemonic` 과 동일한 민감도이므로 같은 보안 등급 유지. 사용자가 biometric 을 끈 상태에서 잠시 잠금 해제된 폰을 두고 간 사이 "Create New Wallet" 탭 한 번으로 phrase 가 메모리에 재진입하는 것을 차단.

### 7.8 UI 표면 (SettingsScreen)

- Create Wallet row → `addWalletFromCreate(nickname?)` → `KeySecurityService.createWallet` → 분기 결과를 Alert 으로 표시
  - `reusedSeed: false` → phrase 표시 + "I have saved it" 버튼 → `switchWallet(newId)` auto-activation
  - `reusedSeed: true` → "Derived from your existing recovery phrase" 짧은 안내
- Import Wallet row → 모달에서 mnemonic / privateKey 토글 + nickname 입력
  - `addWalletFromMnemonic` / `addWalletFromPrivateKey` 호출
  - 거부 시 (서로 다른 mnemonic) Alert 메시지로 delete-first 안내
- Delete trash icon → `removeWallet(id)` + 생체 게이트

---

## 8. Per-address 네임스페이싱과 레거시 마이그레이션

`NoteStorageService`, `PendingClaimsStorage`, `StealthIdentityService`, `AddressBookService`, `EscrowHiddenStorage` 가 공유.

**저장 shape**:
- v2 (현재): `<prefix>_<소문자-addr>[_<id>]`
- v1 (레거시): `<prefix>[_<id>]` — 단일 내장 지갑용
- 마이그레이션 마커 (Async): `<prefix>_migrated_v2`

**알고리즘 (install별 첫 호출 시 lazy 실행)**:

1. 마커 설정됨 → return.
2. v1 blob 없음 → 마커 설정 + return.
3. `scatterdex_wallet_address` 읽기(레거시 소유자).
4. 이 주소가 caller 주소와 `eqAddr` 아니면 → v1 blob 그대로 두고 **마커 설정 안함**. 나중에 일치하는 호출이 claim.
5. 일치하면: v1 → v2 복제 → 마커를 **v1 삭제 전에** 설정(crash-safety) → v1 best-effort 삭제.

`NoteStorageService` 는 rekey 청크 병렬화(`REKEY_CONCURRENCY=32`) + 모듈 레벨 promise latch로 동시 첫 호출이 각각 rekey 루프를 걷는 것 방지.

---

## 9. 스텔스 주소 (EIP-5564) 수신 흐름

수신자 기기에서만 동작. 발신자는 온체인 stealth announcer 컨트랙트 사용. **현재 자동 스캐너는 없으며 claim import 는 수동**.

### 9.1 단계

1. **정체성 생성** (수신자, 1회) — `StealthIdentityService.generate(addr)` 가 BabyJub + secp256k1 파생으로 `{ spendingKey, viewingKey, metaAddress }` 생성, `scatterdex_stealth_identity_v1_<addr>`(SecureStore)에 저장. Settings → Stealth Identity 에서 트리거.
2. **meta-address 공개** — `metaAddress` 는 공개 안전. Settings 의 Share 시트로 복사/전송.
3. **발신자 측 (앱 외부)** — 발신자가 수신자의 meta-address 로부터 일회용 stealth address 를 파생하고, on-chain stealth announcer 컨트랙트에 거래. Claim 정보(ephemeralPubKey + stealthAddress + claim payload)를 수신자에게 **별도 채널로 전달** — 파일 공유, QR, 메신저 등. 현재 앱은 announcer 이벤트를 앱에서 자동 스캔하지 않음.
4. **claim 수신 & 가져오기 (수신자, 수동)** — 수신자가 받은 claim JSON/payload 를 앱의 ClaimScreen 에서 **사용자 조작으로 import**.
5. **개인키 파생 (사용자 조작)** — ClaimScreen 의 `handleRevealStealthKey` 핸들러가 `deriveStealthPrivateKey(viewingKey, spendingKey, ephemeralPubKey)` 호출. 파생된 private key 로부터 주소를 재계산해 claim 이 가리키는 `stealthAddress` 와 일치하는지 `ethers.getAddress` 비교로 검증(불일치 시 refuse).
6. **Claim proof 생성 & settle (사용자 조작)** — 파생된 키로 `ClaimService` 가 claim proof 를 빌드 → on-chain `settleAuth` 호출. 자금이 수신자가 지정한 최종 목적지로 이동.

### 9.2 정체성 재생성

`regenerate` 가 spending/viewing 키 교체. **파괴적**: 기존 키 기반 stealth 주소들은 spend 불가(사전 Reveal Keys 백업한 경우 예외). UI에서 이중 확인 필수.

### 9.3 지갑 전환 안전성

키는 per wallet address → 활성 지갑 전환 시 stealth 서브시스템이 자연스럽게 다른 meta-address 를 가리킴. 현재 wallet 전환에 즉시 반응 — 이 부분은 `notifyWalletSwitch` 훅 소비 경로를 통해 작동.

### 9.4 아직 구현 안 된 것

- **on-chain Announcer 이벤트 자동 폴러** — 수신자가 viewingKey 로 "내 것" 판정하는 스캔 루프가 없음. Claim import 는 여전히 외부 채널에서 payload 를 받아 수동 붙여넣기 필요.
- **백그라운드 실행** — 앱이 foreground 에 있을 때만 동작. `expo-background-fetch` 등으로 OS 스케줄러 연동 미구현.
- 두 기능이 들어오면 "자동 수신"이 가능해짐. 현재 문구에서 "automated" / "background scanning" 을 쓸 수 없는 이유.

---

## 10. ZK 하이브리드 아키텍처

```
Hermes (RN)                        WebView (숨김)
  ethers 6                            snarkjs (Groth16 WASM)
  WalletConnect / built-in            circomlibjs (Poseidon)
  UI + 상태                           BabyJub EdDSA
      │                                   │
      └───── postMessage 브리지 ──────────┘
               (ZKBridgeService)
```

- **브리지 로드**: 숨김 `WebView`가 `zk-webview.html`(~4.6MB)을 `expo-asset` 로컬 파일 URI로 로드(inline 금지 — Android에서 OOM).
- **리스너 등록**: WebView 브리지는 `window`와 `document` **양쪽**에 메시지 핸들러 등록. Android는 `document`, iOS는 `window`로 전달. 한쪽만 등록하면 다른 플랫폼에서 조용히 실패.
- **Worker fallback**: 무거운 회로(authorize ~22K constraints)는 single-thread로 실행, UI는 진행 표시로 대기 처리.
- **zkey 관리**: 작은 zkey는 앱 번들에 포함, 큰 zkey는 첫 실행 시 다운로드 + `expo-file-system` 캐시.
- **`waitReady` 상태**: `Promise<ZKReadyStatus>` — callers는 ready/failed/timeout을 구분해 UI gating 가능.

**ZK 엔진 번들 빌드** (`mobile/scripts/build-zk-webview.mjs`):

1. circomlibjs 브라우저 번들 (esbuild + 폴리필: `Buffer` / `process` / `Worker` stub / `crypto` / `stream`).
2. snarkjs + zk-engine을 HTML에 인라인 → `zk-webview.html`.

### 10.1 회로 티어 정책 — 모바일은 TIER_16 전용

웹 프론트엔드(apps/pay, apps/pro)는 멀티-티어 인프라(TIER_16 / TIER_64 / TIER_128)를 지원하고 `pickActiveTier(recipientCount)`로 자동 라우팅하지만, **모바일은 TIER_16만 번들링**합니다.

이유:
- **번들 사이즈**: TIER_64 zkey ≈ 50 MB, TIER_128 zkey ≈ 90 MB. 두 티어를 합치면 APK/IPA에 ~140 MB가 추가되어 제품 코드 이전에 이미 모바일 설치 풋프린트가 무너집니다. 웹은 정적 호스팅 + 워커 lazy-load로 해결하지만 RN의 asset 파이프라인에는 직접 매핑되지 않습니다.
- **프루빙 시간**: TIER_128은 미들급 노트북에서 ~6–12s. 모바일급 하드웨어는 더 느려서 foreground 작업으로 합리적인 시간을 넘기게 됩니다. TIER_16(~1–2s)도 이미 로딩 UX 한계입니다.

함의:
- 모바일은 17명 이상 수신자 run을 거부하거나, 16명 단위로 분할(웹의 multi-batch fallback과 동일 패턴)해야 합니다. UI에서 `pickActiveTier`를 그대로 호출하면 안 되고, 모바일은 TIER_16을 단일 옵션으로 취급해야 합니다.
- `mobile/scripts/copy-zk-assets.sh`의 `CIRCUITS` 목록과 `scripts/check-zk-artifacts.sh`의 `mobile_copies()` 술어가 이 정책을 코드에 반영합니다.
- 향후 모바일에서 더 큰 티어를 띄우려면 (예: 진행 표시 UI를 갖춘 on-demand asset download), 본 README의 정책 + 두 스크립트 + 본 문서 절을 함께 갱신해야 합니다.

---

## 11. WalletConnect 흐름

내장 지갑이 기본, WalletConnect는 보조.

**패키지**: `@walletconnect/ethereum-provider`, `@walletconnect/modal-react-native`.

**연결 흐름**:
```
[ScatterDEX 앱]                   [지갑 앱 (Rainbow 등)]
     │── "Connect Wallet" 탭              │
     │── WalletConnect 모달                │
     │── 지갑 선택 → 딥링크 ─────────────>│
     │                                    │── 연결 승인
     │<── WC v2 session ──────────────────│
     │── 잔액 표시                         │
     │── ZK proof 생성 (Worker fallback)  │
     │── 서명 요청 → 딥링크 ─────────────>│
     │                                    │── 사용자 서명
     │<── signed tx ──────────────────────│
     │── tx 전송 + 확인                    │
```

**accountsChanged / chainChanged**: WalletConnect 세션에서 계정/체인 변경 이벤트 수신 시 세션을 끊지 않고 내부 state만 갱신 → 네트워크 전환 시 세션 churn 제거.

---

## 12. 기여자 가이드라인

- **`WalletSecret`을 절대 AsyncStorage로 `JSON.stringify` 하지 말 것** — secret은 SecureStore에만. `PendingClaimsStorage` 가 분할 패턴의 canonical 예시.
- **주소를 `===` 로 비교하지 말 것** — `lib/address.ts → eqAddr(a, b)` 사용. 양쪽 inline 소문자화는 `eqAddr` 가 방지하려는 바로 그 footgun.
- **모든 생체 프롬프트에 사람이 읽을 `reason` 지정** — OS 시트가 최후 방어선.
- **모든 사용자 데이터는 per-address 네임스페이스** — 신규 저장은 `<prefix>_<addr>` 형태, 레거시 데이터 있으면 §8 패턴의 마이그레이션 가드 작성.
- **`account` 키 기반 in-memory 캐시는 `notifyWalletSwitch` 구독** — 안 그러면 전환 후 한 렌더 동안 이전 지갑 데이터 노출.
- **SecureStore 쓰기 시 `WHEN_UNLOCKED_THIS_DEVICE_ONLY` 명시** — 민감 blob은 기기 바인딩 필수. 공개 데이터는 플래그 생략.
- **Android 2KB 제한 의식** — SecureStore entry가 클 것 같으면 바로 분할 패턴 적용.

---

## 13. 부록 — 파일 구조

```
mobile/
├── App.tsx
├── src/
│   ├── screens/
│   │   HomeScreen / TradeScreen / DepositScreen / ClaimScreen
│   │   HistoryScreen / SettingsScreen
│   ├── components/
│   │   ScreenHeader / BaseModal / BackupModal / AddressBookModal
│   │   SecretRevealModal / HiddenWebView / RelayerLogo / …
│   ├── contexts/
│   │   WalletContext.tsx
│   ├── services/          ← §4 인벤토리
│   ├── zk-engine/         ← 회로별 prover (authorize / claim / deposit / cancel)
│   ├── hooks/
│   │   useBalances / useClaimStatuses / useTerminateWorkerOnUnmount / …
│   ├── lib/
│   │   address.ts (eqAddr) / format.ts / error-messages.ts / stealth.ts
│   │   merkleTree.ts / proofFormat.ts / contracts.ts (ABI)
│   ├── navigation/
│   │   TabNavigator.tsx (Settings slot 숨김)
│   ├── shims/
│   │   브리지 앞단 폴리필
│   └── types/
│       wallet.ts (WalletMeta / WalletSource / WalletSecret)
└── scripts/
    build-zk-webview.mjs  ← ZK 엔진 번들러
```
