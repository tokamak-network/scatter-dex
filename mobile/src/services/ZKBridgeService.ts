/**
 * ZKBridgeService — WebView ZK 엔진과의 통신 브릿지
 *
 * 숨겨진 WebView 내에서 실행되는 snarkjs/circomlibjs와
 * Promise 기반 요청-응답 패턴으로 통신한다.
 */
import type WebView from 'react-native-webview';

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
};

class ZKBridgeServiceImpl {
  private webViewRef: React.RefObject<WebView | null> | null = null;
  private pending = new Map<string, PendingRequest>();
  private ready = false;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private requestCounter = 0;

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

  waitReady(): Promise<void> {
    return this.readyPromise;
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
      console.log('ZKBridge __init__:', status, JSON.stringify(result));
      if (status === 'success') {
        this.ready = true;
        this.readyResolve();
      } else {
        // ZK engine failed — still resolve to unblock app, but log error
        console.error('ZK Engine initialization failed:', JSON.stringify(result));
        this.ready = false;
        this.readyResolve(); // unblock UI so user can see other screens
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

  async poseidonHash(inputs: string[]): Promise<string> {
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
    const result = await this.sendCommand('compute_commitment', params);
    return result.commitment;
  }

  async computeNullifier(tag: string, secret: string, salt: string): Promise<string> {
    const result = await this.sendCommand('compute_nullifier', { tag, secret, salt });
    return result.nullifier;
  }

  async deriveEdDSAKey(signatureHash: string): Promise<{
    privateKeyHex: string;
    pubKeyAx: string;
    pubKeyAy: string;
  }> {
    return this.sendCommand('derive_eddsa_key', { signatureHash });
  }

  async signEdDSA(privateKeyHex: string, message: string): Promise<{
    S: string;
    R8x: string;
    R8y: string;
  }> {
    return this.sendCommand('sign_eddsa', { privateKeyHex, message });
  }

  async hashOrder(inputs: string[]): Promise<string> {
    const result = await this.sendCommand('hash_order', { inputs });
    return result.hash;
  }

  /**
   * Groth16 proof 생성 (wasm/zkey를 base64로 전달)
   * 대형 회로는 60초 타임아웃
   */
  async generateProof(
    circuitInputs: Record<string, any>,
    wasmB64: string,
    zkeyB64: string,
  ): Promise<{
    proof: any;
    publicSignals: string[];
    elapsedMs: number;
  }> {
    return this.sendCommand('generate_proof', {
      circuitInputs,
      wasmB64,
      zkeyB64,
    }, 120000); // 2분 타임아웃
  }

  async verifyProof(vkey: any, publicSignals: string[], proof: any): Promise<boolean> {
    const result = await this.sendCommand('verify_proof', {
      vkey,
      publicSignals,
      proof,
    }, 30000);
    return result.valid;
  }
}

export const ZKBridgeService = new ZKBridgeServiceImpl();
