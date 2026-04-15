// External JS-only libs without typings — `any` is intentional here
// because the call sites narrow at use time.
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
      wasmPath: string,
      zkeyPath: string,
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
  export const wtns: {
    calculate(
      input: Record<string, string | string[]>,
      wasmPath: string,
      output: { type: "mem" } | string,
    ): Promise<void>;
  };
}

