/**
 * WalletContext — WalletConnect v2 기반 지갑 연동
 *
 * tokamon의 wallet.js 리스너 패턴을 React Context로 래핑.
 * connect() → WalletConnect 모달 → 지갑 앱 딥링크 → 세션 수립 → ethers Signer 제공
 */
import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Alert, Linking, Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { ethers } from 'ethers';
import QRCode from 'react-native-qrcode-svg';
import { ConfigService } from '../services/ConfigService';
import { ProviderService } from '../services/ProviderService';
import EthereumProvider from '@walletconnect/ethereum-provider';
import { KeySecurityService } from '../services/KeySecurityService';

interface WalletState {
  account: string | null;
  chainId: number | null;
  provider: ethers.BrowserProvider | null;
  signer: ethers.Signer | null;
  isConnecting: boolean;
  error: string | null;
}

type ConnectionMode = 'none' | 'builtin' | 'walletconnect';

interface WalletContextValue extends WalletState {
  connectionMode: ConnectionMode;
  connect: () => Promise<void>;              // WalletConnect
  connectBuiltin: () => Promise<void>;       // 앱 내장 지갑
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
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('none');
  const [qrUri, setQrUri] = useState<string | null>(null);

  const wcProviderRef = useRef<any>(null);

  // Re-read from ProviderService/ConfigService whenever the provider singleton
  // is reset (happens on network switch or restoreSavedNetwork). This keeps
  // readProvider and targetChainId in sync without requiring an app restart.
  const [providerVersion, setProviderVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = ProviderService.subscribeReset(() =>
      setProviderVersion((v) => v + 1),
    );
    // Force a refresh right after subscribing so any reset that fired before
    // this effect ran (e.g. App.tsx's restoreSavedNetwork) does not leave the
    // initial memoized provider/config stale for the lifetime of the app.
    setProviderVersion((v) => v + 1);
    return unsubscribe;
  }, []);
  const readProvider = useMemo(
    () => ProviderService.getReadProvider(),
    [providerVersion],
  );
  const targetChainId = useMemo(
    () => ConfigService.getChainId(),
    [providerVersion],
  );

  // A signer created against the old readProvider would keep signing against
  // the old network after a switch. Force a disconnect so the user reconnects
  // against the new provider — covers both built-in and WalletConnect modes.
  const prevProviderVersionRef = useRef(providerVersion);
  useEffect(() => {
    if (prevProviderVersionRef.current === providerVersion) return;
    prevProviderVersionRef.current = providerVersion;
    setState((s) => (s.signer ? INITIAL_STATE : s));
    if (wcProviderRef.current) {
      try { wcProviderRef.current.disconnect(); } catch { /* ignore */ }
      wcProviderRef.current = null;
    }
  }, [providerVersion]);

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
      // Disconnect any existing provider before creating a new one
      if (wcProviderRef.current) {
        try { await wcProviderRef.current.disconnect(); } catch { /* ignore */ }
        wcProviderRef.current = null;
      }

      const projectId = ConfigService.getWalletConnectProjectId();
      if (!projectId) {
        throw new Error('WALLETCONNECT_PROJECT_ID is not configured');
      }

      console.log('WC: init start, projectId =', projectId.slice(0, 8) + '...');
      const wcProvider = await EthereumProvider.init({
        projectId,
        chains: [targetChainId],
        showQrModal: false,
        metadata: {
          name: 'ScatterDEX',
          description: 'Privacy-Preserving DEX',
          url: 'https://scatterdex.io',
          icons: ['https://scatterdex.io/icon.png'],
        },
      });
      console.log('WC: init done, calling connect...');

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

      // Show QR code for wallet connection
      wcProvider.on('display_uri', (uri: string) => {
        console.log('WalletConnect URI:', uri);
        // Try deep link to wallet app first (works on real devices)
        const metamaskLink = `metamask://wc?uri=${encodeURIComponent(uri)}`;
        Linking.canOpenURL(metamaskLink).then((supported) => {
          if (supported) {
            Linking.openURL(metamaskLink);
          } else {
            // Show QR code modal (for simulator or when no wallet app installed)
            setQrUri(uri);
          }
        });
      });

      console.log('WC: calling connect...');
      await wcProvider.connect();
      console.log('WC: connected! setting up provider...');
      setQrUri(null);
      await setupFromWcProvider(wcProvider);
      setConnectionMode('walletconnect');
    } catch (err: any) {
      setQrUri(null);
      setState((s) => ({
        ...s,
        isConnecting: false,
        error: err?.message || 'Failed to connect wallet',
      }));
    }
  }, [targetChainId, setupFromWcProvider]);

  // ─── 앱 내장 지갑 연결 ──────────────────────────────
  const connectBuiltin = useCallback(async () => {
    setState((s) => ({ ...s, isConnecting: true, error: null }));
    try {
      // Tear down existing WalletConnect session if any
      if (wcProviderRef.current) {
        try { await wcProviderRef.current.disconnect(); } catch { /* ignore */ }
        wcProviderRef.current = null;
      }

      const hasWallet = await KeySecurityService.hasWallet();
      if (!hasWallet) {
        throw new Error('NO_WALLET');
      }

      const signer = await KeySecurityService.getSigner(readProvider);
      if (!signer) {
        throw new Error('Authentication failed');
      }

      const address = await signer.getAddress();
      const network = await readProvider.getNetwork();

      setState({
        account: address,
        chainId: Number(network.chainId),
        provider: null, // 내장 지갑은 BrowserProvider 없음
        signer,
        isConnecting: false,
        error: null,
      });
      setConnectionMode('builtin');
    } catch (err: any) {
      setState((s) => ({
        ...s,
        isConnecting: false,
        error: err?.message === 'NO_WALLET' ? null : (err?.message || 'Failed to connect'),
      }));
      if (err?.message === 'NO_WALLET') {
        // 지갑이 없으면 에러가 아니라 생성 필요 상태
        throw err; // 호출자가 처리
      }
    }
  }, [readProvider]);

  const disconnect = useCallback(async () => {
    if (wcProviderRef.current) {
      await wcProviderRef.current.disconnect();
      wcProviderRef.current = null;
    }
    setState(INITIAL_STATE);
    setConnectionMode('none');
  }, []);

  return (
    <WalletContext.Provider value={{ ...state, connectionMode, connect, connectBuiltin, disconnect, readProvider }}>
      {children}

      {/* QR Code Modal for WalletConnect */}
      <Modal visible={!!qrUri} transparent animationType="fade">
        <View style={wcStyles.overlay}>
          <View style={wcStyles.modal}>
            <Text style={wcStyles.title}>Scan with Wallet</Text>
            <Text style={wcStyles.desc}>
              Open MetaMask on your phone and scan this QR code
            </Text>
            <View style={wcStyles.qrBox}>
              {qrUri && <QRCode value={qrUri} size={240} backgroundColor="#fff" />}
            </View>
            <TouchableOpacity
              style={wcStyles.cancelBtn}
              onPress={() => { setQrUri(null); setState((s) => ({ ...s, isConnecting: false })); }}
            >
              <Text style={wcStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </WalletContext.Provider>
  );
}

const wcStyles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center', justifyContent: 'center',
  },
  modal: {
    backgroundColor: '#1a1f2e', borderRadius: 20, padding: 24,
    alignItems: 'center', width: 320,
  },
  title: { fontSize: 20, fontWeight: '700', color: '#fff', marginBottom: 8 },
  desc: { fontSize: 14, color: '#8899bb', textAlign: 'center', marginBottom: 20 },
  qrBox: {
    backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 20,
  },
  cancelBtn: {
    paddingVertical: 12, paddingHorizontal: 40,
    borderRadius: 8, borderWidth: 1, borderColor: '#374151',
  },
  cancelText: { color: '#9ca3af', fontSize: 15, fontWeight: '600' },
});

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
