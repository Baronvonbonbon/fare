// snarkjs ships no type declarations; we only touch groth16.fullProve/verify.
declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmPath: string,
      zkeyPath: string
    ): Promise<{ proof: any; publicSignals: string[] }>;
    verify(vk: any, publicSignals: string[], proof: any): Promise<boolean>;
  };
}
