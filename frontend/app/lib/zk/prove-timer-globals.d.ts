// `declare global` requires the containing file to be a module — kept
// here in a dedicated `.d.ts` rather than `externals.d.ts` because that
// file is an ambient script (its `declare module "..."` blocks must stay
// global). Adding any top-level export there flips it to a module and
// breaks snarkjs / circomlibjs resolution everywhere.

import type { ProveTiming } from "./prove-timer";

declare global {
  interface WindowEventMap {
    "zk-perf:prove": CustomEvent<ProveTiming>;
  }
}
