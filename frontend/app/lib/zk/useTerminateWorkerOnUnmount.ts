import { useEffect } from "react";
import type { TerminateOptions } from "./prover-worker-client-runtime";

// Reclaims a circuit worker's snarkjs/circomlibjs heap (~10-15MB) when
// the page that uses it unmounts. The worker is re-created lazily on
// the next prove. Always passes `{ silent: true }` so a mid-prove
// unmount drops the orphaned promise instead of rejecting it — the
// page is gone, no setState in the catch handler, no React warning.
export function useTerminateWorkerOnUnmount(
  terminate: (options?: TerminateOptions) => void,
): void {
  useEffect(() => () => terminate({ silent: true }), [terminate]);
}
