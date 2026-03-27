function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is not set`);
  }
  return value;
}

export const SETTLEMENT_ADDRESS = requireEnv("NEXT_PUBLIC_SETTLEMENT_ADDRESS");
export const RELAYER_REGISTRY_ADDRESS = requireEnv("NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS");
