# ScatterDEX 모바일 앱 설계 문서

> **상태**: 분석/설계 (2026-04-10)
> **범위**: Android + iOS 앱, WalletConnect 기반 지갑 연동
> **프레임워크**: Expo + React Native
> **관련 문서**:
> - [../../frontend/](../../frontend/) — 현재 웹 프론트엔드
> - [../architecture-v2.md](../../architecture/architecture-v2.md) — 전체 아키텍처
> - **tokamon** 앱 참고 (Expo/RN 구조 레퍼런스)

---

## 목차

1. [현재 상태 분석](#1-현재-상태-분석)
2. [접근법 결정](#2-접근법-결정)
3. [아키텍처 설계](#3-아키텍처-설계)
4. [WalletConnect 통합 설계](#4-walletconnect-통합-설계)
5. [ZK Proof 모바일 전략](#5-zk-proof-모바일-전략)
6. [코드 재사용 분석](#6-코드-재사용-분석)
7. [NFC & SE 확장 계획 (Phase 2)](#7-nfc--se-확장-계획-phase-2)
8. [구현 단계](#8-구현-단계)
9. [미해결 질문](#9-미해결-질문)

---

## 1. 현재 상태 분석

### 1.1 웹 프론트엔드 스택

| 구성 요소 | 현재 구현 |
|-----------|----------|
| 프레임워크 | Next.js 16.2.1 + React 19.2.4 |
| 지갑 연동 | `window.ethereum` (EIP-1193 injected provider) 직접 접근, injected wallet 의존 |
| 블록체인 | ethers 6.16.0 |
| ZK Proof | snarkjs 0.7.6 Groth16, WASM + Web Worker |
| 암호학 | circomlibjs (Poseidon), @noble/curves (EdDSA BabyJub) |
| 스타일링 | Tailwind CSS 4 |
| 상태 관리 | React Context (WalletProvider) + useState |
| 노트 저장 | File System Access API (`showDirectoryPicker`) + `localStorage` fallback |

### 1.2 tokamon 앱 스택 (기존 경험)

| 구성 요소 | tokamon |
|-----------|---------|
| 프레임워크 | Expo 54 + React Native 0.81.5 + React 19.1.0 |
| 지갑 | ethers 6.16.0 직접 (프라이빗 키 임포트) |
| 상태 관리 | React Context + AsyncStorage |
| 빌드 | EAS Build |
| 저장소 | expo-secure-store, AsyncStorage |
| 네이티브 기능 | GPS, 지도, FCM 푸시, Device Attestation |
| 네비게이션 | React Navigation (Bottom Tabs) |

### 1.3 모바일 핵심 제약

1. **지갑 접근**: `window.ethereum` 없음 — WalletConnect 필수
2. **ZK 성능**: snarkjs WASM — RN에서 동작 검증 필요
3. **파일 저장**: FileSystem API 없음 — expo-secure-store / expo-file-system으로 대체
4. **향후 NFC**: 네이티브 접근 필요 — Expo dev build에서 지원

---

## 2. 접근법 결정

### 2.1 후보 비교

| 기준 | Capacitor | Expo/RN |
|------|-----------|---------|
| 코드 재사용 (웹) | 90%+ | 30~40% (UI 재작성) |
| 코드 재사용 (tokamon) | 0% | 60~70% (구조/패턴 재사용) |
| NFC 지원 | 플러그인 제한적 | react-native-nfc-manager (풀 지원) |
| SE 접근 | 불가 | react-native-keychain (SE-backed P-256) |
| 앱스토어 | O | O |
| ZK WASM | WebView에서 확실 | RN에서 검증 필요 |
| 네이티브 기능 확장 | 제한적 | 무제한 |
| 기존 경험 | 없음 | tokamon에서 검증됨 |
| 개발 시간 (초기) | 1주 | 2~3주 |
| 개발 시간 (NFC 추가 시) | 전체 재작성 | 라이브러리 추가 |

### 2.2 결정: Expo + React Native

**이유:**

1. **NFC & SE 확장성**: 나중에 NFC 기능이 필요할 가능성 있음. Capacitor로 시작하면 전체 재작성 필요. Expo/RN이면 라이브러리 추가만으로 해결.

2. **tokamon 경험 활용**: Expo 54 + React Navigation + ethers 6 + AsyncStorage + expo-secure-store — 동일한 스택과 패턴을 재사용 가능.

3. **장기적 유지보수**: 네이티브 앱이 WebView 래핑보다 성능/UX 모두 우수. DEX 특성상 장기 운영이 목적이므로 기반을 탄탄하게 가는 것이 맞음.

**트레이드오프 인지:**
- UI 코드는 재작성 필요 (React DOM → React Native 컴포넌트)
- snarkjs WASM의 RN 동작 검증 필요 (Phase 1에서 PoC)

---

## 3. 아키텍처 설계

### 3.1 전체 구조

```
┌──────────────────────────────────────────────────┐
│               Expo + React Native                │
│                                                  │
│  ┌────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │ WalletConnect│  │ ZK Proof    │  │ Secure   │ │
│  │ (RN SDK)    │  │ Engine      │  │ Storage  │ │
│  │ + Web3Modal │  │ (snarkjs)   │  │ (SE-enc) │ │
│  └──────┬──────┘  └──────┬──────┘  └────┬─────┘ │
│         │                │               │       │
│  ┌──────▼────────────────▼───────────────▼─────┐ │
│  │            React Native Screens             │ │
│  │  (tokamon 패턴 기반, ScatterDEX 비즈니스)     │ │
│  └─────────────────────────────────────────────┘ │
│                                                  │
│  ┌─────────────────────────────────────────────┐ │
│  │          Phase 2 (향후 확장)                  │ │
│  │  - react-native-nfc-manager (NFC)           │ │
│  │  - react-native-keychain (SE-backed keys)   │ │
│  │  - HCE (Android contactless)                │ │
│  └─────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
         │                        │
    WalletConnect v2          JSON-RPC
         │                        │
    ┌────▼────┐            ┌──────▼──────┐
    │ 지갑 앱  │            │  Titan L2   │
    │ (Rainbow,│            │  / Sepolia  │
    │  Trust)  │            └─────────────┘
    └─────────┘
```

### 3.2 프로젝트 구조

```
scatter-dex/
├── frontend/                    (기존 웹 — 유지)
├── mobile/                      (신규 — Expo 앱)
│   ├── App.tsx                  # 루트 (tokamon 패턴)
│   ├── app.config.js            # Expo 설정
│   ├── eas.json                 # EAS Build 설정
│   ├── package.json
│   ├── src/
│   │   ├── screens/             # 화면 (React Navigation)
│   │   │   ├── HomeScreen.tsx       # 대시보드 (잔액, 최근 거래)
│   │   │   ├── DepositScreen.tsx    # 입금 (ZK proof 생성)
│   │   │   ├── OrderScreen.tsx      # 주문 생성 (authorize proof)
│   │   │   ├── ClaimScreen.tsx      # 클레임
│   │   │   ├── HistoryScreen.tsx    # 거래 내역
│   │   │   └── SettingsScreen.tsx   # 설정
│   │   ├── components/          # 공유 UI 컴포넌트
│   │   │   ├── WalletButton.tsx     # WalletConnect 연결 버튼
│   │   │   ├── ProofProgress.tsx    # ZK proof 진행률
│   │   │   ├── TokenSelector.tsx    # 토큰 선택
│   │   │   └── TxStatus.tsx         # 트랜잭션 상태
│   │   ├── services/            # 비즈니스 로직 (tokamon 패턴)
│   │   │   ├── wallet.ts           # WalletConnect 래퍼
│   │   │   ├── contract.ts         # ethers 컨트랙트 호출
│   │   │   ├── relayerApi.ts       # 릴레이어 API
│   │   │   └── noteStorage.ts      # 노트 암호화 저장
│   │   ├── zk/                  # ZK 관련 (웹에서 포팅)
│   │   │   ├── prover.ts           # snarkjs 래퍼
│   │   │   ├── commitment.ts       # Poseidon 해싱
│   │   │   ├── eddsa.ts            # EdDSA 서명
│   │   │   └── tags.ts             # 도메인 분리 상수
│   │   ├── utils/
│   │   │   ├── constants.ts        # ABI, 주소, 설정
│   │   │   └── config.ts           # 환경변수
│   │   └── hooks/
│   │       ├── useProof.ts         # proof 생성 상태 관리
│   │       └── useBalance.ts       # 잔액 조회
│   ├── android/                 # Expo prebuild (자동 생성)
│   └── ios/                     # Expo prebuild (자동 생성)
│
└── shared/                      (신규 — 웹/모바일 공유 코드)
    ├── zk/                      # ZK 순수 로직 (React 무관)
    │   ├── commitment.ts
    │   ├── eddsa.ts
    │   ├── tags.ts
    │   └── constants.ts
    ├── contracts/               # ABI + 주소
    │   └── abis.ts
    └── types/                   # 공유 타입 (기존 packages/types 확장)
```

### 3.3 웹 vs 모바일 분리 원칙

```
공유 (shared/)          웹 전용 (frontend/)      모바일 전용 (mobile/)
─────────────          ─────────────────        ──────────────────
ZK 로직 (Poseidon,     React DOM 컴포넌트       React Native 화면
 EdDSA, tags)          Next.js 라우팅            React Navigation
ABI + 컨트랙트 주소     window.ethereum          WalletConnect RN SDK
타입 정의              Tailwind CSS              RN StyleSheet
상수                   Web Worker                expo-secure-store
                       IndexedDB                 AsyncStorage
```

---

## 4. WalletConnect 통합 설계

### 4.1 RN 전용 패키지

```json
{
  "@walletconnect/modal-react-native": "^1.x",
  "@walletconnect/ethereum-provider": "^2.x"
}
```

WalletConnect 공식 React Native SDK가 있음. 웹의 Web3Modal과 동일한 역할이지만 RN 네이티브 모달 UI 제공.

### 4.2 wallet.js 설계 (tokamon 패턴 차용)

```javascript
// mobile/src/services/wallet.js
// tokamon의 wallet.js 패턴 + WalletConnect 적용

import { WalletConnectModal } from '@walletconnect/modal-react-native';
import { ethers } from 'ethers';

let provider = null;
let signer = null;
let account = null;
const listeners = [];

// tokamon 패턴: 이벤트 리스너 기반
export function onWalletChange(callback) {
  listeners.push(callback);
  return () => listeners.splice(listeners.indexOf(callback), 1);
}

export async function connect() {
  // WalletConnect 세션 시작 → 지갑 앱 딥링크
  const wcProvider = await WalletConnectModal.open({
    projectId: WALLETCONNECT_PROJECT_ID,
    chains: [TARGET_CHAIN_ID],
  });
  provider = new ethers.BrowserProvider(wcProvider);
  signer = await provider.getSigner();
  account = await signer.getAddress();
  listeners.forEach(cb => cb({ account, provider, signer }));
}

export async function disconnect() {
  // 1. WalletConnect 세션 종료 (서버 릴레이에 disconnect 전파)
  if (provider?.disconnect) await provider.disconnect();
  // 2. 로컬 상태 초기화
  account = null; signer = null; provider = null;
  listeners.forEach(cb => cb({ account: null }));
}

export function getAccount() { return account; }
export function getSigner() { return signer; }
export function getProvider() { return provider; }
```

### 4.3 모바일 UX 흐름

```
[ScatterDEX 앱]                   [지갑 앱 (Rainbow 등)]
     │                                    │
     │── "Connect Wallet" 탭              │
     │── WalletConnect 모달 표시           │
     │── 지갑 선택 → 딥링크 전환 ─────────>│
     │                                    │── 연결 승인
     │<── WC v2 session 수립 ─────────────│
     │── 연결 완료, 잔액 표시              │
     │                                    │
     │── Deposit 실행                      │
     │── ZK proof 생성 (3~5초)             │
     │── 서명 요청 → 딥링크 전환 ─────────>│
     │                                    │── 사용자 서명
     │<── signed tx ──────────────────────│
     │── tx 전송 + 확인                    │
```

---

## 5. ZK Proof 모바일 전략

### 5.1 PoC 검증 결과 (2026-04-10 확정)

> **PoC 코드**: `scatter-dex-mobile-poc/` (scatter-dex 레포 인접 디렉토리)

| 환경 | 테스트 | 결과 |
|------|--------|------|
| Hermes (직접) | ethers 6 (지갑 생성 + RPC) | **PASS** |
| Hermes (직접) | snarkjs, circomlibjs | **FAIL** — WASM/Node.js 의존성 |
| WebView (숨김) | circomlibjs Poseidon | **PASS** |
| WebView (숨김) | circomlibjs BabyJub EdDSA | **PASS** (sign+verify=true) |
| WebView (숨김) | snarkjs groth16.fullProve() | **PASS** (실제 proof 생성+검증) |

### 5.2 확정 아키텍처: Hermes + WebView 하이브리드

```
┌─ Hermes (RN 엔진) ────────┐    ┌─ WebView (숨김, ZK 엔진) ─┐
│ ethers 6                   │    │ snarkjs (Groth16 WASM)    │
│ WalletConnect              │    │ circomlibjs (Poseidon)    │
│ UI 렌더링                   │◄──►│ BabyJub EdDSA             │
│ 상태 관리                   │ post│ proof 생성 + 검증         │
│ 네비게이션                  │ Msg │                           │
└────────────────────────────┘    └───────────────────────────┘
```

**Hermes에서 직접 실행 불가한 이유:**
- snarkjs: Node.js `readline` 의존
- circomlibjs/ffjavascript: `Worker`, `Buffer`, `process`, `crypto` 등 Node.js 글로벌 의존
- esbuild로 브라우저 번들링 + 폴리필 후 WebView에서 정상 동작

**WebView ZK 엔진 번들 빌드:**
```bash
# 1. circomlibjs 브라우저 번들 (esbuild)
npx esbuild zk-engine-src.js --bundle --platform=browser --format=iife --minify \
  --alias:stream=stream-browserify --alias:crypto=crypto-browserify \
  --define:global=globalThis --outfile=zk-engine.min.js

# 2. snarkjs + zk-engine을 HTML에 인라인
node build-webview-html.mjs  # → zk-webview.html (4.6 MB)
```

**필수 폴리필 (zk-engine-src.js 내):**
- `Buffer` (buffer 패키지)
- `process` (process/browser)
- `Worker` (빈 구현 — single-threaded fallback, 아래 성능 주의 참고)
- `crypto` (crypto-browserify)
- `stream` (stream-browserify)

> **Worker fallback 성능 주의**: ffjavascript는 Worker 멀티스레딩으로 증명 성능을 최적화한다. 빈 Worker stub은 single-threaded fallback이므로 대형 회로(authorize ~22K constraints)에서 성능 저하 가능. 프로덕션에서는 (1) WebView 환경에서 실제 Worker를 지원하는 HTML 구조 (file:// 대신 localhost 서빙 등) 검토, (2) proof 생성 중 프로그레스 UI로 대기 시간 처리, (3) Phase 2에서 네이티브 rapidsnark 모듈 검토.

> **WebView HTML 로딩 방식**: zk-webview.html (4.6 MB)을 `source={{ html }}` 인라인 대신 `expo-asset`으로 로컬 파일 URI를 얻어 `source={{ uri }}` 로 로드해야 한다. 인라인 HTML은 메모리 이슈를 유발할 수 있음.

### 5.3 zkey 파일 관리

| 전략 | 설명 |
|------|------|
| 앱 번들 포함 | 앱 크기 +25MB, 다운로드 없음 |
| 첫 실행 다운로드 | 앱 크기 최소, 초기 대기 필요 |
| **권장: 하이브리드** | 가장 작은 zkey만 번들, 나머지 온디맨드 다운로드 + expo-file-system 캐시 |

---

## 6. 코드 재사용 분석

### 6.1 웹에서 직접 포팅 가능 (변경 최소)

| 파일 | 내용 | 재사용률 |
|------|------|---------|
| `lib/zk/commitment.ts` | Poseidon 해싱, Merkle tree | 95% |
| `lib/zk/eddsa.ts` | BabyJub EdDSA | 95% |
| `lib/zk/tags.ts` | 도메인 분리 상수 | 100% |
| `lib/zk/constants.ts` | ZK 상수 | 100% |
| `lib/contracts.ts` | ABI 정의 | 100% |
| `lib/config.ts` | 환경변수 | 80% (RN 환경변수 방식 차이) |
| `lib/relayerApi.ts` | 릴레이어 API 호출 | 90% (fetch → 동일) |
| `packages/types/` | 공유 타입 | 100% |

### 6.2 tokamon에서 패턴 재사용

| tokamon 패턴 | ScatterDEX 적용 |
|-------------|----------------|
| `services/wallet.js` (리스너 패턴) | WalletConnect 래퍼에 동일 패턴 |
| `services/contract.js` (ethers 래퍼) | PrivateSettlement/CommitmentPool 호출 |
| `App.js` (전역 상태 + TabNavigator) | 동일 구조 |
| `utils/constants.js` (ABI + 주소) | 동일 |
| AsyncStorage 활용 패턴 | 네트워크 설정, 언어 등 |
| expo-secure-store 활용 | 노트 암호화 저장 |
| EAS Build 설정 | 동일 |
| React Navigation (Bottom Tabs) | 동일 |

### 6.3 재작성 필요 (UI 레이어)

| 웹 | 모바일 대응 |
|----|-----------|
| `<div>` + Tailwind | `<View>` + StyleSheet |
| `<input>` | `<TextInput>` |
| `<button>` | `<TouchableOpacity>` / `<Pressable>` |
| CSS Grid/Flexbox | RN Flexbox (세로 기본) |
| 라우팅 (Next.js App Router) | React Navigation |
| localStorage / IndexedDB | AsyncStorage / expo-secure-store |

---

## 7. NFC & SE 확장 계획 (Phase 2)

> 현재는 구현하지 않음. Expo/RN 선택으로 향후 확장이 가능하도록 기반을 마련.

### 7.1 NFC 활용 시나리오

#### 시나리오 A: NFC 카드 기반 하드웨어 서명
```
[사용자 폰]          [NFC 카드 (Keycard 등)]
     │── 거래 해시 전송 ──>│
     │                     │── 카드 내부 서명
     │<── 서명 반환 ───────│
     │── tx 전송
```
- JavaCard 기반 NFC 카드 (Keycard, Tangem)
- `react-native-nfc-manager`의 APDU 통신
- 프라이빗 키가 카드에만 존재 — 폰에 노출 안 됨

#### 시나리오 B: NFC 태그로 결제 링크
```
[매장 NFC 태그]       [사용자 폰]
     │── NDEF URL ────>│── 앱 딥링크 열림
                       │── 결제 화면 표시
                       │── 사용자 승인 → tx 전송
```

#### 시나리오 C: HCE 기반 오프라인 결제 (Android only)
```
[사용자 Android 폰]    [매장 NFC 리더]
     │<── APDU 통신 ──>│
     │── 결제 증명 전송 ─>│── 검증 후 완료
```

### 7.2 SE (Secure Element) 활용

**BabyJub 키는 SE에 직접 저장 불가** (SE는 P-256만 지원).

**대안 패턴:**
```
SE (P-256)                    Software
┌──────────────┐              ┌───────────────────┐
│ P-256 마스터 키│──── 암호화 ──>│ BabyJub 키 (암호문)│
│ (절대 노출 안됨)│              │ (expo-secure-store)│
└──────────────┘              └───────────────────┘
                                       │
                              복호화 (proof 생성 시에만)
                                       │
                              ┌────────▼────────┐
                              │ BabyJub 키 (평문)│
                              │ (메모리에만 존재) │
                              └─────────────────┘
```

- P-256 마스터 키를 SE에 생성 (react-native-keychain, SE-backed)
- BabyJub 프라이빗 키를 P-256으로 암호화하여 저장
- proof 생성 시에만 복호화 → 메모리에서 사용 → 즉시 삭제
- 생체인증 (Face ID / 지문)으로 SE 접근 게이팅

### 7.3 필요 패키지 (Phase 2에서 추가)

```json
{
  "react-native-nfc-manager": "^3.17.2",
  "react-native-keychain": "^10.0.0"
}
```

둘 다 Expo config plugin 지원 → dev build에서 바로 동작.

---

## 8. 구현 단계

### Phase 1: 기반 + PoC (1주)

| 작업 | 설명 | 예상 |
|------|------|------|
| 1-1 | Expo 프로젝트 생성 (`mobile/`) | 0.5일 |
| 1-2 | snarkjs RN 동작 PoC (Hermes → fallback WebView) | 1일 |
| 1-3 | WalletConnect RN SDK 연동 + wallet.js | 1일 |
| 1-4 | ZK 공유 코드 추출 (`shared/zk/`) | 0.5일 |
| 1-5 | ethers + 컨트랙트 호출 검증 | 0.5일 |

### Phase 2: 핵심 화면 (1~2주)

| 작업 | 설명 | 예상 |
|------|------|------|
| 2-1 | HomeScreen (잔액, 최근 거래) | 1일 |
| 2-2 | DepositScreen (deposit proof + tx) | 2일 |
| 2-3 | OrderScreen (authorize proof + 릴레이어 제출) | 2일 |
| 2-4 | ClaimScreen (claim proof + tx) | 1일 |
| 2-5 | HistoryScreen (거래 내역) | 1일 |
| 2-6 | SettingsScreen (네트워크, 노트 백업) | 0.5일 |

### Phase 3: 마무리 (0.5~1주)

| 작업 | 설명 | 예상 |
|------|------|------|
| 3-1 | 노트 저장 (expo-secure-store 암호화) | 1일 |
| 3-2 | 에러 핸들링 + 엣지 케이스 | 1일 |
| 3-3 | EAS Build 설정 + 테스트 빌드 | 0.5일 |
| 3-4 | 앱스토어 메타데이터 (아이콘, 스크린샷) | 0.5일 |

### Phase 4: NFC & SE (향후)

| 작업 | 설명 |
|------|------|
| 4-1 | react-native-nfc-manager 통합 |
| 4-2 | react-native-keychain SE-backed 키 관리 |
| 4-3 | NFC 카드 APDU 통신 프로토콜 |
| 4-4 | HCE 구현 (Android) |

---

## 9. 미해결 질문

### OQ-1. snarkjs + Hermes WASM 호환성 — 부분 해결
- PoC에서 Hermes 직접 실행 실패 확인 — 원인은 Node API 의존성 (readline, Worker, Buffer, process, crypto)
- **Hermes WASM 자체의 제약 여부**는 아직 미확인 (Node API를 전부 폴리필한 상태에서의 재테스트 필요)
- 현재 결정: WebView 하이브리드로 확정, Hermes 직접 실행은 Phase 2 최적화 시 재검토

### OQ-2. WalletConnect projectId 관리
- cloud.walletconnect.com에서 발급 필요
- 무료 티어: 월 100,000 relay 메시지

### OQ-3. 노트 동기화
- 웹에서 만든 노트를 모바일에서 사용 가능해야 함
- 내보내기/가져오기 (QR? 파일?) vs 클라우드 동기화
- 보안: 노트에 secret + salt 포함 — 암호화 필수

### OQ-4. 웹과 모바일의 WalletConnect 통합
- 웹도 WalletConnect로 전환하면 wallet.tsx 변경 필요
- 웹/모바일 동시 전환 vs 모바일만 먼저?

### OQ-5. Mono-repo 구조
- `shared/` 패키지를 어떻게 관리?
- 기존 `packages/types/` 확장 vs 새 workspace?

### OQ-6. 앱스토어 심사 (DEX)
- 자체 커스터디(non-custodial) → 금융 라이선스 불필요할 가능성
- Apple의 crypto app 가이드라인 확인 필요

---

## 부록 A — 기술 의사결정 기록

| 날짜 | 결정 | 이유 |
|------|------|------|
| 2026-04-10 | Capacitor → Expo/RN 변경 | NFC & SE 향후 확장 가능성, tokamon 경험 재활용 |
| 2026-04-10 | WalletConnect v2 + Web3Modal RN | MetaMask 의존 탈피, 모바일 필수 |
| 2026-04-10 | 웹/모바일 ZK 코드 공유 (`shared/`) | 중복 제거, 단일 소스 |
| 2026-04-10 | ZK는 WebView 하이브리드 | PoC에서 Hermes 직접 실행 시 snarkjs/circomlibjs의 Node API 의존성(readline, Worker, Buffer, process, crypto)으로 불가 확인. Hermes WASM 자체 제약 여부는 별도 확인 필요. WebView에서 fullProve+verify ALL PASS |
| 2026-04-10 | esbuild + 폴리필 번들 | circomlibjs 브라우저 빌드 부재 + Node 런타임 의존성 대응을 위한 번들링 전략 |

## 부록 B — WalletConnect 지원 지갑 (주요)

| 지갑 | Android | iOS | 딥링크 |
|------|---------|-----|--------|
| MetaMask | O | O | metamask:// |
| Rainbow | O | O | rainbow:// |
| Trust Wallet | O | O | trust:// |
| Coinbase Wallet | O | O | cbwallet:// |
| Zerion | O | O | zerion:// |
| 1inch Wallet | O | O | oneinch:// |

## 부록 C — tokamon 코드 재사용 매핑

| tokamon 파일 | ScatterDEX 모바일 대응 |
|-------------|---------------------|
| `app/App.js` | `mobile/App.js` (전역 상태 + Navigator) |
| `app/src/services/wallet.js` | `mobile/src/services/wallet.js` (WC로 교체) |
| `app/src/services/contract.js` | `mobile/src/services/contract.js` |
| `app/src/utils/constants.js` | `shared/contracts/abis.ts` |
| `app/src/screens/*` | `mobile/src/screens/*` |
| `app/app.config.js` | `mobile/app.config.js` |
| `app/eas.json` | `mobile/eas.json` |
