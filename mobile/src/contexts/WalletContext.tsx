/**
 * WalletContext — WalletConnect v2 기반 지갑 연동
 *
 * tokamon의 wallet.js 리스너 패턴을 React Context로 래핑.
 * connect() → WalletConnect 모달 → 지갑 앱 딥링크 → 세션 수립 → ethers Signer 제공
 */
import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { Alert, Linking, Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { ethers } from 'ethers';
import QRCode from 'react-native-qrcode-svg';
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
  const [qrUri, setQrUri] = useState<string | null>(null);

  const wcProviderRef = useRef<any>(null);
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
      setQrUri(null); // Close QR modal after connection
      await setupFromWcProvider(wcProvider);
    } catch (err: any) {
      setQrUri(null);
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
