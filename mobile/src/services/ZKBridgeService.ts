/**
 * ZKBridgeService — WebView ZK 엔진과의 통신 브릿지
 *
 * 숨겨진 WebView 내에서 실행되는 snarkjs/circomlibjs와
 * Promise 기반 요청-응답 패턴으로 통신한다.
 */
import type WebView from 'react-native-webview';

// `null` when mopro-ffi isn't on this build (Expo Go, missing arm64 jniLib).
type NativeEdDsaKey = { privateKeyHex: string; pubKeyAx: string; pubKeyAy: string };
type NativeEdDsaSignature = { s: string; r8x: string; r8y: string };
type NativeFns = {
  poseidonHash: ((inputs: string[]) => string) | null;
  deriveEddsaKey: ((sigHash: string) => NativeEdDsaKey) | null;
  signEddsa: ((privHex: string, msg: string) => NativeEdDsaSignature) | null;
};
const _native: NativeFns = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('mopro-ffi');
    return {
      poseidonHash: typeof m.poseidonHash === 'function' ? m.poseidonHash : null,
      deriveEddsaKey: typeof m.deriveEddsaKey === 'function' ? m.deriveEddsaKey : null,
      signEddsa: typeof m.signEddsa === 'function' ? m.signEddsa : null,
    };
  } catch {
    return { poseidonHash: null, deriveEddsaKey: null, signEddsa: null };
  }
})();
const _nativePoseidon = _native.poseidonHash;

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ZKReadyStatus =
  | { status: 'ready' }
  | { status: 'failed'; error: string };

class ZKBridgeServiceImpl {
  private webViewRef: React.RefObject<WebView | null> | null = null;
  private pending = new Map<string, PendingRequest>();
  private ready = false;
  private initError: string | null = null;
  private readyPromise: Promise<ZKReadyStatus>;
  private readyResolve!: (status: ZKReadyStatus) => void;
  // Tracks the live `waitReady` timer so `__init__` and `reload()` can
  // clear it. Without this, a timer armed for attempt N could fire
  // after `reload()` has already produced attempt N+1 with a fresh
  // `readyPromise` / `readyResolve`, incorrectly marking the *new*
  // attempt as timed out.
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  // Tracks the most recent timeout budget passed to `waitReady` so a
  // later `notifyInitStarted()` (fired from HiddenWebView's onLoadStart)
  // can arm the timer with the same budget the caller asked for.
  private readyTimeoutMs: number | null = null;
  // Set to true once the WebView begins loading the bundled HTML. Until
  // then, `waitReady()` defers the timeout — the cold-start budget is
  // for *engine init*, not for asset extraction + WebView content-process
  // spawn (which can themselves consume many seconds on a fresh launch).
  private webViewInitStarted = false;
  // Wall-clock timestamp (ms) when the WebView started loading the
  // bundled HTML. Used to log actual engine-init duration in dev so the
  // 60s budget can be tuned against real low-end-device numbers.
  private initStartedAt: number | null = null;
  // Pre-init watchdog: fires if `onLoadStart` never arrives (e.g.
  // Asset.downloadAsync() failed, WebView ref never mounted, content
  // process killed before any load). Without this, deferring the
  // engine-init timer would leave `waitReady()` hanging forever in the
  // failure case — App.tsx would be stuck on the "Initializing ZK Engine…"
  // spinner with no retryable error.
  private spawnWatchdog: ReturnType<typeof setTimeout> | null = null;
  private requestCounter = 0;

  // 15s for the WebView to fire onLoadStart is generous: even on a cold
  // process spawn, asset extraction + WebView mount finishes well under
  // this on every device we've measured. Anything slower indicates an
  // actual failure (asset missing, JS bundle corrupt, content process
  // refused to start) and the user should see a Retry button rather
  // than a permanent spinner.
  private static readonly SPAWN_WATCHDOG_MS = 15000;

  constructor() {
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  setWebViewRef(ref: React.RefObject<WebView | null>) {
    this.webViewRef = ref;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Resolves with `{status: 'ready'}` once the WebView reports successful
   * snarkjs/circomlibjs init, or with `{status: 'failed', error}` when the
   * init handshake reports failure or `timeoutMs` elapses first. Callers
   * (e.g. `App.tsx`) branch on the status to gate the proving UI rather
   * than silently rendering a broken-prover state — historically
   * `waitReady` resolved void on both paths, leaving callers unable to
   * distinguish.
   *
   * The timeout is the important safety net: if the WebView never posts
   * `__init__` at all (asset load failure, JS crash before the handler
   * registers, content process killed mid-boot), the ready promise would
   * otherwise hang forever and App.tsx's init spinner would be stuck.
   * When the timeout fires we mark the bridge failed so `isReady()` stays
   * false and callers can surface a retryable error.
   */
  waitReady(timeoutMs: number = 60000): Promise<ZKReadyStatus> {
    if (this.ready || this.initError) return this.readyPromise;
    // Remember the budget so a later `notifyInitStarted()` can arm the
    // timer using the same value the caller intended.
    this.readyTimeoutMs = timeoutMs;
    // Defer arming until the WebView actually begins loading. Otherwise
    // the budget is consumed by Asset.downloadAsync() + WebView content-
    // process spawn — both of which run before any engine code executes
    // and which can take several seconds on cold start. If init has
    // already started, arm immediately.
    if (this.webViewInitStarted) {
      this.armReadyTimer();
    } else {
      this.armSpawnWatchdog();
    }
    return this.readyPromise;
  }

  /**
   * Called by HiddenWebView the moment the WebView begins loading the
   * bundled HTML (onLoadStart). Marks the engine-init phase as having
   * truly begun so `waitReady`'s budget measures init, not the preceding
   * asset-extraction / WebView-spawn phases. Safe to call multiple times.
   */
  notifyInitStarted(): void {
    if (this.webViewInitStarted) return;
    this.webViewInitStarted = true;
    this.initStartedAt = Date.now();
    // The spawn watchdog has done its job — replace it with the real
    // engine-init timer so a slow init still fails cleanly.
    this.clearSpawnWatchdog();
    if (this.readyTimeoutMs !== null && !this.readyTimer && !this.ready && !this.initError) {
      this.armReadyTimer();
    }
  }

  private armSpawnWatchdog(): void {
    if (this.spawnWatchdog) return;
    const resolveForThisAttempt = this.readyResolve;
    this.spawnWatchdog = setTimeout(() => {
      this.spawnWatchdog = null;
      if (this.ready || this.initError || this.webViewInitStarted) return;
      const errMsg = `ZK engine WebView did not begin loading within ${ZKBridgeServiceImpl.SPAWN_WATCHDOG_MS}ms`;
      this.initError = errMsg;
      resolveForThisAttempt({ status: 'failed', error: errMsg });
    }, ZKBridgeServiceImpl.SPAWN_WATCHDOG_MS);
  }

  private clearSpawnWatchdog(): void {
    if (this.spawnWatchdog) {
      clearTimeout(this.spawnWatchdog);
      this.spawnWatchdog = null;
    }
  }

  private armReadyTimer(): void {
    if (this.readyTimer || this.readyTimeoutMs === null) return;
    const timeoutMs = this.readyTimeoutMs;
    // Snapshot the resolver so a `reload()` that swaps `readyResolve`
    // before the timer fires can't make this timer resolve the *next*
    // attempt's promise.
    const resolveForThisAttempt = this.readyResolve;

    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      // If the real handshake landed between the race setup and here,
      // honor that result instead of overwriting it with a timeout.
      if (this.ready || this.initError) return;
      const errMsg = `ZK engine init did not complete within ${timeoutMs}ms`;
      this.initError = errMsg;
      resolveForThisAttempt({ status: 'failed', error: errMsg });
    }, timeoutMs);
  }

  /** Internal: cancel the init timeout armed by `waitReady`. Called on
   *  every `__init__` handshake and inside `reload()` so a stale timer
   *  can't stomp on a later init attempt. */
  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  /** Last init failure reason, if any. Useful for diagnostics screens. */
  getInitError(): string | null {
    return this.initError;
  }

  /**
   * Reload the underlying WebView and reset the ready promise so the next
   * `waitReady()` await tracks the new init handshake. Used by App.tsx's
   * "Retry" button after the initial init fails — recovers without a full
   * app restart and without depending on `expo-updates` being installed.
   */
  reload(): void {
    this.ready = false;
    this.initError = null;
    // The new WebView load will fire `onLoadStart` again, which arms a
    // fresh init timer. Until then, defer arming so the budget covers
    // engine init only — same rationale as the cold-start path.
    this.webViewInitStarted = false;
    this.readyTimeoutMs = null;
    this.initStartedAt = null;
    // Cancel any in-flight init timer before we swap in the new
    // readyPromise — otherwise the old timer would race with the
    // fresh init handshake and could resolve the new promise as failed.
    this.clearReadyTimer();
    this.clearSpawnWatchdog();
    // Reject any in-flight bridge commands so callers don't hang.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('ZK engine restarting'));
    }
    this.pending.clear();
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    this.webViewRef?.current?.reload();
  }

  /**
   * WebView에서 오는 메시지 처리.
   * HiddenWebView의 onMessage에서 호출됨.
   */
  onMessage(data: string) {
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    const { requestId, status, result, error } = parsed;

    // 디버그 메시지
    if (requestId === '__debug__') {
      console.log('ZKBridge debug:', JSON.stringify(parsed));
      return;
    }

    // 초기화 완료 메시지
    if (requestId === '__init__') {
      // Cancel the pending init timeout the moment we hear back, so a
      // slow handshake that lands just before the deadline doesn't still
      // allow the timer to fire and flip us to `failed` afterwards.
      this.clearReadyTimer();
      this.clearSpawnWatchdog();
      const initDurationMs = this.initStartedAt ? Date.now() - this.initStartedAt : null;
      console.log('ZKBridge __init__:', status, 'durationMs=', initDurationMs, JSON.stringify(result));
      if (status === 'success') {
        this.ready = true;
        this.initError = null;
        this.readyResolve({ status: 'ready' });
      } else {
        // Log the raw payload first so debugging has the original shape,
        // then resolve with an extracted user-friendly message. Resolving
        // with explicit failure (vs the old void-resolve) lets callers
        // render an error state instead of mistaking init failure for
        // init success — the proving UI must NOT proceed when ready === false.
        console.error('ZK engine init failed:', error || result);
        const errMsg = error || (typeof result === 'string' ? result : JSON.stringify(result)) || 'ZK engine init failed';
        this.ready = false;
        this.initError = errMsg;
        this.readyResolve({ status: 'failed', error: errMsg });
      }
      return;
    }

    const pending = this.pending.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(requestId);

    if (status === 'success') {
      pending.resolve(result);
    } else {
      pending.reject(new Error(error || 'Unknown ZK engine error'));
    }
  }

  /**
   * WebView에 명령 전송 + 결과 대기
   */
  private sendCommand(cmd: string, payload: Record<string, any> = {}, timeoutMs = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.webViewRef?.current) {
        reject(new Error('WebView not mounted'));
        return;
      }

      const requestId = `req_${++this.requestCounter}_${Date.now()}`;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`ZK command '${cmd}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      this.webViewRef.current.postMessage(
        JSON.stringify({ requestId, cmd, ...payload })
      );
    });
  }

  // ─── Public API ─────────────────────────────────────

  async ping(): Promise<boolean> {
    const result = await this.sendCommand('ping');
    return result.pong === true;
  }

  /** Try the native Poseidon path; returns null when the native module
   *  isn't loaded or threw. Centralises hex→decimal normalization since
   *  light-poseidon only parses decimal but call sites pass hex (merkle
   *  zero-hashes mirror Solidity's hex `_zeros(d)`). */
  private tryNativeHash(inputs: string[], label: string): string | null {
    if (!_nativePoseidon) return null;
    try {
      const decimal = inputs.map((s) =>
        /^0x[0-9a-fA-F]+$/.test(s) ? BigInt(s).toString(10) : s,
      );
      return _nativePoseidon(decimal);
    } catch (e) {
      // Narrow before formatting; pass the raw object as a second arg so
      // any extra diagnostic fields (uniffi error variants, etc.) survive.
      const msg = e instanceof Error
        ? ((e as { shortMessage?: string; reason?: string }).shortMessage
          ?? (e as { reason?: string }).reason
          ?? e.message)
        : String(e);
      console.warn(`[ZKBridge] native ${label} failed (${msg}), falling back:`, e);
      return null;
    }
  }

  async poseidonHash(inputs: string[]): Promise<string> {
    // Native (Rust/light-poseidon): ~0.1 ms FFI vs ~50-200 ms per
    // WebView round-trip. The WebView burst during merkle-tree builds
    // saturated the RN bridge and poisoned subsequent fetches.
    const native = this.tryNativeHash(inputs, 'poseidonHash');
    if (native !== null) return native;
    const result = await this.sendCommand('poseidon_hash', { inputs });
    return result.hash;
  }

  async computeCommitment(params: {
    tag: string;
    secret: string;
    token: string;
    balance: string;
    salt: string;
    pubKeyAx: string;
    pubKeyAy: string;
  }): Promise<string> {
    // Same Poseidon underneath as the WebView path —
    // Poseidon([tag, secret, token, balance, salt, pubKeyAx, pubKeyAy]).
    const inputs = [params.tag, params.secret, params.token, params.balance, params.salt, params.pubKeyAx, params.pubKeyAy];
    const native = this.tryNativeHash(inputs, 'computeCommitment');
    if (native !== null) return native;
    const result = await this.sendCommand('compute_commitment', params);
    return result.commitment;
  }

  async computeNullifier(tag: string, secret: string, salt: string): Promise<string> {
    const native = this.tryNativeHash([tag, secret, salt], 'computeNullifier');
    if (native !== null) return native;
    const result = await this.sendCommand('compute_nullifier', { tag, secret, salt });
    return result.nullifier;
  }

  async deriveEdDSAKey(signatureHash: string): Promise<{
    privateKeyHex: string;
    pubKeyAx: string;
    pubKeyAy: string;
  }> {
    if (_native.deriveEddsaKey) {
      try {
        return _native.deriveEddsaKey(signatureHash);
      } catch (e) {
        console.warn('[ZKBridge] native deriveEddsaKey failed, falling back:', e);
      }
    }
    return this.sendCommand('derive_eddsa_key', { signatureHash });
  }

  async signEdDSA(privateKeyHex: string, message: string): Promise<{
    S: string;
    R8x: string;
    R8y: string;
  }> {
    if (_native.signEddsa) {
      try {
        // babyjubjub-rs's `sign` parses message as decimal BigUint;
        // some callers (orderHash from circomlibjs paths) pass hex.
        // Normalize at the boundary, same shape as `tryNativeHash`.
        const decimalMsg = /^0x[0-9a-fA-F]+$/.test(message)
          ? BigInt(message).toString(10)
          : message;
        const sig = _native.signEddsa(privateKeyHex, decimalMsg);
        // Native uses lower-case (r8x/r8y/s); WebView callers expect
        // upper-case S/R8x/R8y. Adapt at the boundary.
        return { S: sig.s, R8x: sig.r8x, R8y: sig.r8y };
      } catch (e) {
        console.warn('[ZKBridge] native signEddsa failed, falling back:', e);
      }
    }
    return this.sendCommand('sign_eddsa', { privateKeyHex, message });
  }

  async hashOrder(inputs: string[]): Promise<string> {
    const native = this.tryNativeHash(inputs, 'hashOrder');
    if (native !== null) return native;
    const result = await this.sendCommand('hash_order', { inputs });
    return result.hash;
  }

  // Groth16 proof generation lived here (snarkjs in HiddenWebView)
  // until Phase C-4. Every circuit consumer now goes through
  // `NativeProverService.generateNativeProof` (mopro-ffi / arkworks),
  // so the WebView prover code path — including the 14MB+ base64
  // wasm/zkey transfer over the RN bridge — is gone. Poseidon and
  // EdDSA helpers above still backstop their native counterparts via
  // the WebView, so the HiddenWebView component itself remains.
}

export const ZKBridgeService = new ZKBridgeServiceImpl();
