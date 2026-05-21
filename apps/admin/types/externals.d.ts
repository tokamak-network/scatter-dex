// Mirrors packages/sdk/src/types/externals.d.ts so the typecheck of
// SDK source files (resolved via the file: link to packages/sdk/src)
// can find these JS-only modules. Without it, tsc inside apps/admin
// fails on the SDK's `import "snarkjs"` / `import "circomlibjs"`
// even though the SDK's own tsconfig has the same shim.
//
// Keep this file in sync with apps/operators/types/externals.d.ts and
// packages/sdk/src/types/externals.d.ts. When the SDK ships a built
// dist/ (.d.ts emission), these duplicates go away.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "circomlibjs" {
  export function buildPoseidon(): Promise<any>;
  export function buildEddsa(): Promise<any>;
  export function buildBabyjub(): Promise<any>;
}

declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, string | string[]>,
      wasmPath: string | ArrayBuffer | Uint8Array,
      zkeyPath: string | ArrayBuffer | Uint8Array,
    ): Promise<{ proof: any; publicSignals: string[] }>;
  };
}
