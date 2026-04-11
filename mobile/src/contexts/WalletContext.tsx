/**
 * WalletContext — WalletConnect v2 기반 지갑 연동
 *
 * tokamon의 wallet.js 리스너 패턴을 React Context로 래핑.
 * connect() → WalletConnect 모달 → 지갑 앱 딥링크 → 세션 수립 → ethers Signer 제공
 */
import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import { ConfigService } from '../services/ConfigService';
import EthereumProvider from '@walletconnect/ethereum-provider';

const WALLETCONNECT_PROJECT_ID = 'scatter_dex_mobile'; // TODO: cloud.walletconnect.com에서 발급

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

const INITIAL_STATE: WalletState = {
  account: null,
  chainId: null,
  provider: null,
  signer: null,
  isConnecting: false,
  error: null,
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WalletState>(INITIAL_STATE);

  const wcProviderRef = useRef<InstanceType<typeof EthereumProvider> | null>(null);
  const readProvider = useRef(
    new ethers.JsonRpcProvider(ConfigService.getRpcUrl()),
  ).current;

  const targetChainId = ConfigService.getChainId();

  const setupFromWcProvider = useCallback(async (wcProvider: InstanceType<typeof EthereumProvider>) => {
    const ethersProvider = new ethers.BrowserProvider(wcProvider);
    const signer = await ethersProvider.getSigner();
    const account = await signer.getAddress();
    const network = await ethersProvider.getNetwork();

    setState({
      account,
      chainId: Number(network.chainId),
      provider: ethersProvider,
      signer,
      isConnecting: false,
      error: null,
    });
  }, []);

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, isConnecting: true, error: null }));
    try {
      const wcProvider = await EthereumProvider.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        chains: [targetChainId],
        showQrModal: true,
        metadata: {
          name: 'ScatterDEX',
          description: 'Privacy-Preserving DEX',
          url: 'https://scatterdex.io',
          icons: ['https://scatterdex.io/icon.png'],
        },
        // React Native specific
        qrModalOptions: {
          themeMode: 'dark' as const,
        },
      });

      wcProviderRef.current = wcProvider;

      // 이벤트 바인딩
      wcProvider.on('disconnect', () => {
        setState(INITIAL_STATE);
        wcProviderRef.current = null;
      });

      wcProvider.on('chainChanged', (chainId: string) => {
        setState((s) => ({ ...s, chainId: Number(chainId) }));
      });

      wcProvider.on('accountsChanged', async (accounts: string[]) => {
        if (accounts.length === 0) {
          setState((s) => ({ ...s, account: null, signer: null }));
        } else {
          const ethersProvider = new ethers.BrowserProvider(wcProvider);
          const signer = await ethersProvider.getSigner();
          setState((s) => ({ ...s, account: accounts[0], signer, provider: ethersProvider }));
        }
      });

      await wcProvider.connect();
      await setupFromWcProvider(wcProvider);
    } catch (err: any) {
      setState((s) => ({
        ...s,
        isConnecting: false,
        error: err?.message || 'Failed to connect wallet',
      }));
    }
  }, [targetChainId, setupFromWcProvider]);

  const disconnect = useCallback(async () => {
    if (wcProviderRef.current) {
      await wcProviderRef.current.disconnect();
      wcProviderRef.current = null;
    }
    setState(INITIAL_STATE);
  }, []);

  return (
    <WalletContext.Provider value={{ ...state, connect, disconnect, readProvider }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
