/**
 * WalletContext — WalletConnect v2 기반 지갑 연동
 */
import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import { ConfigService } from '../services/ConfigService';
import EthereumProvider from '@walletconnect/ethereum-provider';

interface WalletState {
  account: string | null;
  chainId: number | null;
  provider: ethers.BrowserProvider | null;
  signer: ethers.Signer | null;
  isConnecting: boolean;
  error: string | null;
}

interface WalletContextValue extends WalletState {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  readProvider: ethers.JsonRpcProvider;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WalletState>({
    account: null, chainId: null, provider: null, signer: null,
    isConnecting: false, error: null,
  });
  const wcProviderRef = useRef<InstanceType<typeof EthereumProvider> | null>(null);
  const readProvider = useRef(new ethers.JsonRpcProvider(ConfigService.getRpcUrl())).current;
  const targetChainId = ConfigService.getChainId();

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, isConnecting: true, error: null }));
    try {
      const projectId = ConfigService.getWalletConnectProjectId();
      if (!projectId) {
        throw new Error('WALLETCONNECT_PROJECT_ID is not configured');
      }

      const wc = await EthereumProvider.init({
        projectId, chains: [targetChainId], showQrModal: true,
        metadata: { name: 'ScatterDEX', description: 'Privacy-Preserving DEX', url: 'https://scatterdex.io', icons: ['https://scatterdex.io/icon.png'] },
        qrModalOptions: { themeMode: 'dark' as const },
      });
      wcProviderRef.current = wc;
      wc.on('disconnect', () => { setState({ account: null, chainId: null, provider: null, signer: null, isConnecting: false, error: null }); wcProviderRef.current = null; });
      wc.on('chainChanged', (c: string) => setState((s) => ({ ...s, chainId: Number(c) })));
      wc.on('accountsChanged', async (accs: string[]) => {
        if (!accs.length) { setState((s) => ({ ...s, account: null, signer: null })); return; }
        const ep = new ethers.BrowserProvider(wc); const si = await ep.getSigner();
        setState((s) => ({ ...s, account: accs[0], signer: si, provider: ep }));
      });
      await wc.connect();
      const ep = new ethers.BrowserProvider(wc); const si = await ep.getSigner();
      const acc = await si.getAddress(); const net = await ep.getNetwork();
      setState({ account: acc, chainId: Number(net.chainId), provider: ep, signer: si, isConnecting: false, error: null });
    } catch (err: any) {
      setState((s) => ({ ...s, isConnecting: false, error: err?.message || 'Failed to connect' }));
    }
  }, [targetChainId]);

  const disconnect = useCallback(async () => {
    if (wcProviderRef.current) { await wcProviderRef.current.disconnect(); wcProviderRef.current = null; }
    setState({ account: null, chainId: null, provider: null, signer: null, isConnecting: false, error: null });
  }, []);

  return <WalletContext.Provider value={{ ...state, connect, disconnect, readProvider }}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
