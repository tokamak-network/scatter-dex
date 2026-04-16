/**
 * Poseidon domain-separation tags — zk-engine re-export.
 *
 * The canonical values live in `../lib/zk/tags.ts`. This module exists
 * only so the esbuild-bundled WebView engine keeps the relative
 * `./tags` import path (`authorize-prover.ts`, `cancel-prover.ts`,
 * `commitment.ts`). Having two independent copies of these constants
 * would be a consensus-break foot-gun — drift between them would
 * silently produce preimages that don't match the circuits.
 */
export {
  TAG_ESCROW_NULL,
  TAG_NONCE_NULL,
  TAG_CLAIM_NULL,
  TAG_COMMITMENT_V2,
} from '../lib/zk/tags';
