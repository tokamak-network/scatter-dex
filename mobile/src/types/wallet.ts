export type WalletSource = 'mnemonic' | 'privateKey' | 'created';

export interface WalletMeta {
  id: string;
  address: string;
  nickname?: string;
  source: WalletSource;
  createdAt: number;
}

export interface WalletSecret {
  privateKey: string;
  mnemonic?: string;
}
