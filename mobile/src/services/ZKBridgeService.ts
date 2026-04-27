/**
 * ZKBridgeService — Poseidon / EdDSA helper façade.
 *
 * Phase C-5 collapsed this to a thin wrapper around the native
 * `mopro-ffi` exports (Poseidon-BN254 + BabyJubJub EdDSA). Earlier
 * phases ran every method through a HiddenWebView/snarkjs round-trip
 * with the native call as a fast-path; both that fallback and the
 * WebView component itself are now gone — every consumer goes through
 * the native helpers directly.
 *
 * The class shape is preserved (singleton + `await ZKBridgeService.x(...)`)
 * so callers in `OrderService`, `CancelService`, etc. don't need a
 * sweeping rename. `waitReady()` resolves immediately since the
 * native lib is bound at JS-engine boot, and `reload()` is a no-op.
 */

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

export type ZKReadyStatus =
  | { status: 'ready' }
  | { status: 'failed'; error: string };

const HEX_BIGINT = /^0x[0-9a-fA-F]+$/;

/** circom-prover (and downstream `light-poseidon`) parses BigInt
 *  inputs as decimal strings only. Some callers (merkle zero-hash
 *  defaults from `lib/merkleTree.ts` to match Solidity `_zeros(d)`)
 *  pass hex; normalize at the boundary so the Rust side stays strict. */
function toDecimal(s: string): string {
  return HEX_BIGINT.test(s) ? BigInt(s).toString(10) : s;
}

class ZKBridgeServiceImpl {
  // Readiness means *every* helper this façade exposes is bound, not
  // just `poseidonHash`. A partial bind (e.g. mopro renames `signEddsa`
  // and we miss the rebind) would otherwise let App.tsx report "ready"
  // and then crash much later inside `signEdDSA`. The error string
  // names the specific missing functions so the boot UI can be
  // diagnostic instead of vague.
  private readonly missingNativeHelpers: Array<keyof NativeFns> = (
    Object.keys(_native) as Array<keyof NativeFns>
  ).filter((name) => !_native[name]);
  private readonly nativeReady: boolean = this.missingNativeHelpers.length === 0;
  private readonly readyStatus: ZKReadyStatus = this.nativeReady
    ? { status: 'ready' }
    : {
        status: 'failed',
        error: `mopro-ffi native module missing required helpers: ${this.missingNativeHelpers.join(', ')}`,
      };

  /** True once the native helpers are bound — i.e. always, on any
   *  build that ships the mopro-ffi jniLib. Kept as a method for
   *  parity with the prior WebView-bound implementation. */
  isReady(): boolean {
    return this.nativeReady;
  }

  /** Resolves immediately — the native lib loads synchronously at JS
   *  engine init. The signature stays Promise-based so existing
   *  `await ZKBridgeService.waitReady()` callers keep compiling.
   *  `timeoutMs` is ignored. */
  async waitReady(_timeoutMs: number = 60000): Promise<ZKReadyStatus> {
    return this.readyStatus;
  }

  /** No-op — reload existed when the bridge talked to a WebView whose
   *  content process could be killed mid-flight. The native helpers
   *  have nothing to reload. Retained for App.tsx parity. */
  reload(): void {}

  async poseidonHash(inputs: string[]): Promise<string> {
    if (!_native.poseidonHash) {
      throw new Error('poseidonHash: native helper unavailable (mopro-ffi not bound)');
    }
    return _native.poseidonHash(inputs.map(toDecimal));
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
    return this.poseidonHash([
      params.tag,
      params.secret,
      params.token,
      params.balance,
      params.salt,
      params.pubKeyAx,
      params.pubKeyAy,
    ]);
  }

  async computeNullifier(tag: string, secret: string, salt: string): Promise<string> {
    return this.poseidonHash([tag, secret, salt]);
  }

  async hashOrder(inputs: string[]): Promise<string> {
    // Same Poseidon as `poseidonHash` — kept as a separate name so
    // call-site grep'ing can distinguish "hash a generic Poseidon
    // tuple" from "hash an order tuple".
    return this.poseidonHash(inputs);
  }

  async deriveEdDSAKey(signatureHash: string): Promise<{
    privateKeyHex: string;
    pubKeyAx: string;
    pubKeyAy: string;
  }> {
    if (!_native.deriveEddsaKey) {
      throw new Error('deriveEdDSAKey: native helper unavailable (mopro-ffi not bound)');
    }
    return _native.deriveEddsaKey(signatureHash);
  }

  async signEdDSA(privateKeyHex: string, message: string): Promise<{
    S: string;
    R8x: string;
    R8y: string;
  }> {
    if (!_native.signEddsa) {
      throw new Error('signEdDSA: native helper unavailable (mopro-ffi not bound)');
    }
    // babyjubjub-rs's `sign` parses `message` as decimal BigUint.
    // OrderService/MarketOrderService occasionally pass an `orderHash`
    // produced by circomlibjs callers as 0x-hex; normalize at the
    // boundary so the rust side stays strict.
    const decimalMsg = toDecimal(message);
    const sig = _native.signEddsa(privateKeyHex, decimalMsg);
    // Native uses lower-case (s/r8x/r8y); the public API has always
    // returned upper-case (S/R8x/R8y) for compatibility with the
    // circomlibjs WebView path that originally backed this method.
    return { S: sig.s, R8x: sig.r8x, R8y: sig.r8y };
  }
}

export const ZKBridgeService = new ZKBridgeServiceImpl();
