/**
 * Minimal EIP-7702 batch-send helper.
 *
 * Usage pattern:
 *   1. Build the per-step `Execution[]` (wrap / approve / deposit).
 *   2. Call `sendBatchVia7702(signer, executorAddress, calls, { totalValue })`.
 *   3. If the wallet / chain doesn't support 7702 the function throws
 *      `Eip7702Unsupported`; the caller should fall back to sending the
 *      steps as individual transactions.
 *
 * The helper doesn't introspect wallet capabilities up front — detection
 * via RPC is unreliable across MetaMask versions and other EIP-1193
 * providers. Instead we attempt the send and classify the resulting
 * error. This keeps the call path simple and matches how wallet vendors
 * recommend detecting support today.
 */
import { ethers } from "ethers";

/** One call inside an ERC-7579 batch. */
export interface Execution {
  target: string;
  value: bigint;
  callData: string;
}

/**
 * Thrown when the signer or chain rejects the EIP-7702 tx. The caller
 * should catch this and drop back to the legacy sequential flow.
 */
export class Eip7702Unsupported extends Error {
  constructor(readonly cause: unknown) {
    super("Wallet or chain does not support EIP-7702 batch delegation.");
    this.name = "Eip7702Unsupported";
  }
}

// ERC-7579 mode = (callType=batch=0x01, execType=default=0x00, ...)
// Only the first two bytes are read by BatchExecutor; the rest are zero.
const BATCH_MODE = "0x01" + "00".repeat(31);

const EXECUTOR_IFACE = new ethers.Interface([
  "function execute(bytes32 mode, bytes executionCalldata)",
]);

function encodeExecuteCalldata(calls: Execution[]): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(address target, uint256 value, bytes callData)[]"],
    [calls.map((c) => [c.target, c.value, c.callData])],
  );
  return EXECUTOR_IFACE.encodeFunctionData("execute", [BATCH_MODE, encoded]);
}

/**
 * Patterns from provider / wallet / node error messages that specifically
 * indicate 7702 isn't understood. We match only on 7702-specific phrases
 * so that unrelated revert reasons (e.g. a bad calldata, a user reject)
 * don't get misclassified as "unsupported" and trigger a silent fallback
 * with another popup prompt.
 */
function looksLikeUnsupported(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return [
    "authorizationlist",
    "authorization list",
    "unsupported transaction",
    "transaction type not supported",
    "invalid transaction type",
    "type 4",
    "eip-7702",
    "eip7702",
    "setcodetx",
    "set_code_tx",
    "0x04 ",  // raw tx-type mention
  ].some((needle) => msg.includes(needle));
}

/**
 * Send a batch of calls via EIP-7702 delegation. The signer's EOA is
 * temporarily delegated to `executorAddress` for this single tx; inside
 * the tx, `BatchExecutor.execute(mode, calldata)` runs at the EOA's
 * address and forwards each `Execution`.
 *
 * `totalValue` is the tx-level ETH sent with the call (becomes `msg.value`
 * inside execute). It must equal the sum of `calls[i].value` where any
 * forwarded ETH is drawn from; the common pattern is one wrap step
 * taking `parsed` wei and other steps with value=0.
 */
export async function sendBatchVia7702(
  signer: ethers.Signer,
  executorAddress: string,
  calls: Execution[],
  { totalValue = 0n }: { totalValue?: bigint } = {},
): Promise<ethers.TransactionResponse> {
  if (!signer.provider) throw new Error("sendBatchVia7702: signer has no provider");

  // Normalize + validate the executor address before we touch the wallet.
  // A malformed env var would otherwise surface as an opaque "invalid
  // address" error that `looksLikeUnsupported` wouldn't catch, blocking
  // the sequential fallback. Treat bad input as "disabled".
  if (!ethers.isAddress(executorAddress)) {
    throw new Eip7702Unsupported(
      new Error(`invalid executor address: ${executorAddress}`),
    );
  }
  const executor = ethers.getAddress(executorAddress);

  const eoa = await signer.getAddress();
  const net = await signer.provider.getNetwork();
  // chainId stays as bigint. `Number(net.chainId)` would silently lose
  // precision for chains > 2^53-1 and produce an invalid authorization
  // signature; ethers' authorize/sendTransaction accept bigint directly.
  const chainId = net.chainId;

  // The authorization nonce is the EOA's expected nonce at the moment
  // the authorization is processed. For a tx the EOA itself sends, the
  // tx consumes nonce N and the authorization is checked against N+1
  // (post-increment). If the wallet signs the authorization itself it
  // will fill this in — but we pre-compute for clarity and so non-MM
  // signers that don't auto-fill still work.
  const baseNonce = await signer.provider.getTransactionCount(eoa);

  // ethers v6.16 Signers expose `authorize({ address, chainId, nonce })`
  // which returns a signed Authorization. Fall back to requesting it
  // directly on the signer if the method exists; otherwise rely on the
  // wallet to sign the authorizationList entry when we send.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const maybeAuthorize = (signer as any).authorize?.bind(signer);

  const authRequest = { address: executor, chainId, nonce: baseNonce + 1 };
  let authorizationEntry: unknown;
  try {
    authorizationEntry = maybeAuthorize
      ? await maybeAuthorize(authRequest)
      : authRequest; // wallet will sign at send time
  } catch (err) {
    // Only classify as "unsupported" when the error pattern-matches a
    // 7702 capability gap. User-rejected signs and other unrelated
    // failures must propagate so the caller can surface them instead
    // of silently falling back and prompting the user a second time.
    if (looksLikeUnsupported(err)) throw new Eip7702Unsupported(err);
    throw err;
  }

  const data = encodeExecuteCalldata(calls);

  try {
    // Self-call: destination is the EOA's own address so that the
    // authorized code (BatchExecutor's `execute`) runs under `address(this)`.
    return await signer.sendTransaction({
      to: eoa,
      data,
      value: totalValue,
      // ethers v6 accepts authorizationList on TransactionRequest when
      // the provider supports 7702. The cast keeps us compatible with
      // providers that don't declare the field yet.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authorizationList: [authorizationEntry],
    } as ethers.TransactionRequest & { authorizationList: unknown });
  } catch (err) {
    if (looksLikeUnsupported(err)) throw new Eip7702Unsupported(err);
    throw err;
  }
}
