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
      wtns: { type: "mem" },
    ): Promise<{ proof: any; publicSignals: string[] }>;
    verify(
      vkey: any,
      publicSignals: string[],
      proof: any,
    ): Promise<boolean>;
  };
  export const wtns: {
    calculate(
      input: Record<string, string | string[]>,
      wasmPath: string,
      wtns: { type: "mem" },
    ): Promise<void>;
  };
}
