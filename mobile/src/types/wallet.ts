export type WalletSource = 'mnemonic' | 'privateKey' | 'created';

export interface WalletMeta {
  id: string;
  address: string;
  nickname?: string;
  source: WalletSource;
  createdAt: number; // unix ms

  // HD derivation grouping. `seedId` ties multiple WalletMeta entries to the
  // same BIP-39 mnemonic (so the user only ever has one recovery phrase to
  // back up, not one per account). `derivationIndex` is the BIP-44 account
  // index inside that seed (m/44'/60'/0'/0/<index>).
  //
  // Legacy single-wallet installs predate these fields and load with
  // `seedId`/`derivationIndex` undefined — callers treat that as
  // "standalone seed, index 0".
  seedId?: string;
  derivationIndex?: number;
}

export interface WalletSecret {
  privateKey: string;
  mnemonic?: string;
}
