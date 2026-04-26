// Type shims for JS-only deps used by the ZK modules. The call sites
// narrow these at use time, so the public SDK surface stays typed.
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
    prove(
      zkeyPath: string,
      witness: { type: "mem" } | string | Uint8Array,
      logger?: unknown,
      options?: { singleThread?: boolean },
    ): Promise<{ proof: object; publicSignals: string[] }>;
    verify(
      vkey: object,
      publicSignals: string[],
      proof: object,
    ): Promise<boolean>;
  };
}
