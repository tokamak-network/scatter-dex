/**
 * WalletContext — WalletConnect v2 기반 지갑 연동
 *
 * tokamon의 wallet.js 리스너 패턴을 React Context로 래핑.
 * connect() → WalletConnect 모달 → 지갑 앱 딥링크 → 세션 수립 → ethers Signer 제공
 */
import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Alert, AppState, AppStateStatus, Linking, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { ethers } from 'ethers';
import QRCode from 'react-native-qrcode-svg';
import { ConfigService } from '../services/ConfigService';
import { ProviderService } from '../services/ProviderService';
import BaseModal from '../components/BaseModal';
import { colors } from '../styles/theme';
import EthereumProvider from '@walletconnect/ethereum-provider';
import { KeySecurityService } from '../services/KeySecurityService';

interface WalletState {
  account: string | null;
  chainId: number | null;
  provider: ethers.BrowserProvider | null;
  signer: ethers.Signer | null;
  isConnecting: boolean;
  error: string | null;
  /** True after a background auto-lock: the active session was torn down
   *  but the previously-connected address is stashed in `lockedAccount`
   *  so the UI can greet the user on return and offer a one-tap unlock
   *  that re-runs the biometric prompt. */
  isLocked: boolean;
  lockedAccount: string | null;
}

type ConnectionMode = 'none' | 'builtin' | 'walletconnect';

interface WalletContextValue extends WalletState {
  connectionMode: ConnectionMode;
  connect: () => Promise<void>;              // WalletConnect
  connectBuiltin: () => Promise<void>;       // 앱 내장 지갑
  disconnect: () => Promise<void>;
  /** Unlocks a session that was cleared by `bg-lock`. Re-runs biometric
   *  auth via `KeySecurityService.getSigner` and repopulates state. */
  unlock: () => Promise<void>;
  readProvider: ethers.JsonRpcProvider;
}

// Grace window for backgrounded built-in sessions. A shorter value trips on
// users pulling down the notification centre for a glance; much longer and
// the lock stops being meaningful against a stolen device. 30s is in line
// with common wallet-app defaults.
const BG_LOCK_MS = 30_000;

const INITIAL_STATE: WalletState = {
  account: null,
  chainId: null,
  provider: null,
  signer: null,
  isConnecting: false,
  error: null,
  isLocked: false,
  lockedAccount: null,
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
      ...INITIAL_STATE,
      account,
      chainId: Number(network.chainId),
      provider: ethersProvider,
      signer,
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

  // Shared by `connectBuiltin` and `unlock` — both need to re-run the
  // biometric prompt and pin the resulting signer into state. Spreading
  // `INITIAL_STATE` ensures every new field (e.g. `isLocked`) gets
  // reset without each call site having to remember to clear it.
  const hydrateBuiltinSession = useCallback(async () => {
    const signer = await KeySecurityService.getSigner(readProvider);
    if (!signer) throw new Error('Authentication failed');
    const address = await signer.getAddress();
    const network = await readProvider.getNetwork();
    setState({
      ...INITIAL_STATE,
      account: address,
      chainId: Number(network.chainId),
      signer,
    });
    setConnectionMode('builtin');
  }, [readProvider]);

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

      await hydrateBuiltinSession();
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
  }, [hydrateBuiltinSession]);

  // Background-reauth: clear the cached signer if the app was backgrounded
  // for longer than `BG_LOCK_MS`. Only applies to the built-in wallet mode
  // — WalletConnect sessions are gated by the external wallet app, which
  // does its own session handling. The user lands back on the connect
  // screen and re-taps to go through the biometric prompt again.
  const hasBuiltinSigner = connectionMode === 'builtin' && !!state.signer;
  const backgroundedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!hasBuiltinSigner) return;

    // Only `background` stamps the timestamp — `inactive` fires on
    // transient iOS interruptions (notification pull-down, app-switcher
    // peek) that shouldn't start the lock timer. If the user actually
    // leaves the app those `inactive` events are followed by
    // `background`, which DOES stamp.
    //
    // Listener is declared sync so `AppState`'s non-Promise-aware
    // dispatcher doesn't swallow rejections — the async work is
    // fire-and-forget inside, with an explicit catch for SecureStore
    // hiccups so a rejection never lands as an unhandled promise.
    const handleChange = (next: AppStateStatus): void => {
      if (next === 'background') {
        backgroundedAtRef.current = Date.now();
        return;
      }
      if (next !== 'active' || backgroundedAtRef.current == null) return;
      const elapsed = Date.now() - backgroundedAtRef.current;
      backgroundedAtRef.current = null;
      if (elapsed < BG_LOCK_MS) return;

      void (async () => {
        try {
          // Re-check the opt-in at the moment we'd act on it — the user
          // may have toggled biometric off in Settings while we were
          // subscribed, and caching the value at subscribe time would
          // keep locking their session against their preference.
          const enabled = await KeySecurityService.isBiometricEnabled();
          if (!enabled) return;
          // If the app slipped back to background during the
          // `isBiometricEnabled` await, a fresh `active` handler will
          // re-evaluate the elapsed time — don't race it by locking now.
          if (AppState.currentState !== 'active') return;
          // Transition to locked state — clear the active-session bits
          // (account / signer / provider / connectionMode) so screens
          // keyed on `account !== null` treat the app as disconnected,
          // but remember the address that was connected so the Locked
          // screen can greet the user with "Welcome back, 0x…" and
          // offer a one-tap unlock.
          setState((s) => ({
            ...INITIAL_STATE,
            isLocked: true,
            lockedAccount: s.account,
          }));
          setConnectionMode('none');
        } catch (err) {
          // SecureStore can reject on device edge cases (Keychain
          // locked, hardware fault). Swallow so we don't redbox in
          // production; the session simply stays unlocked — the user
          // can still disconnect manually if they notice.
          if (__DEV__) console.warn('bg-reauth: biometric check failed:', err);
        }
      })();
    };

    const subscription = AppState.addEventListener('change', handleChange);
    return () => {
      subscription.remove();
      backgroundedAtRef.current = null;
    };
  }, [hasBuiltinSigner]);

  const disconnect = useCallback(async () => {
    if (wcProviderRef.current) {
      await wcProviderRef.current.disconnect();
      wcProviderRef.current = null;
    }
    setState(INITIAL_STATE);
    setConnectionMode('none');
  }, []);

  // Unlock from the `isLocked` state — re-runs the biometric prompt and
  // restores the session. Only the built-in wallet mode can be locked
  // (WalletConnect sessions aren't tracked by us), so the unlock always
  // goes through `hydrateBuiltinSession`. On failure we keep the locked
  // state intact so the user can retry — clearing `isLocked` would drop
  // them into the cold Connect flow and lose the welcome-back context.
  const unlock = useCallback(async () => {
    setState((s) => ({ ...s, isConnecting: true, error: null }));
    try {
      await hydrateBuiltinSession();
    } catch (err: any) {
      setState((s) => ({
        ...s,
        isConnecting: false,
        error: err?.message || 'Unlock failed',
      }));
    }
  }, [hydrateBuiltinSession]);

  // Memoize the context value — otherwise every render of WalletProvider
  // hands consumers a fresh object identity and re-renders every screen
  // that reads from `useWallet()`, even when nothing they care about
  // actually changed.
  const ctxValue = useMemo<WalletContextValue>(
    () => ({ ...state, connectionMode, connect, connectBuiltin, disconnect, unlock, readProvider }),
    [state, connectionMode, connect, connectBuiltin, disconnect, unlock, readProvider],
  );

  return (
    <WalletContext.Provider value={ctxValue}>
      {children}

      <BaseModal
        visible={!!qrUri}
        onClose={() => { setQrUri(null); setState((s) => ({ ...s, isConnecting: false })); }}
        title="Scan with Wallet"
      >
        <Text style={wcStyles.desc}>Open MetaMask on your phone and scan this QR code</Text>
        <View style={wcStyles.qrBox}>
          {qrUri && <QRCode value={qrUri} size={240} backgroundColor="#fff" />}
        </View>
        <TouchableOpacity
          style={wcStyles.cancelBtn}
          onPress={() => { setQrUri(null); setState((s) => ({ ...s, isConnecting: false })); }}
        >
          <Text style={wcStyles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </BaseModal>
    </WalletContext.Provider>
  );
}

const wcStyles = StyleSheet.create({
  desc: { fontSize: 14, color: colors.gray500, textAlign: 'center' },
  qrBox: {
    backgroundColor: '#fff', borderRadius: 12, padding: 16, alignSelf: 'center',
  },
  cancelBtn: {
    paddingVertical: 12, paddingHorizontal: 40, alignSelf: 'center',
    borderRadius: 10, borderWidth: 1, borderColor: colors.borderMedium,
  },
  cancelText: { color: colors.textSecondary, fontSize: 15, fontWeight: '600' },
});

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
