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
import { NoteStorageService } from '../services/NoteStorageService';
import { WalletMeta } from '../types/wallet';

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
  // ─── Multi-wallet (built-in only) ─────────────────────────────
  /** All locally-stored built-in wallets, ordered by creation time. WalletConnect
   *  sessions are NOT represented here — the external app owns their identity. */
  wallets: WalletMeta[];
  /** The stable `WalletMeta.id` of the built-in wallet currently signing,
   *  or null when the user is on WalletConnect / disconnected / no wallet
   *  has been created yet. */
  activeWalletId: string | null;
  /** Re-read the wallet list from storage (e.g. after SettingsScreen adds
   *  or removes a wallet externally). */
  refreshWallets: () => Promise<void>;
  /** Switch the active built-in wallet. Re-runs biometric auth for the
   *  new wallet's signer, re-hydrates `account/signer/provider`, and
   *  notifies NoteStorageService subscribers so note-keyed screens
   *  reload. Throws if the id is not in the list. */
  switchWallet: (id: string) => Promise<void>;
  /** Create a new app-generated wallet. The return is a discriminated
   *  union so the caller cannot accidentally re-surface a recovery
   *  phrase the user already saved:
   *
   *  - `reusedSeed: true` — derived from an existing seed-backed wallet
   *    at the next BIP-44 account index. `mnemonic` is intentionally
   *    omitted from the result (not held in JS memory), because the
   *    user has already been shown that phrase on the first create /
   *    first import.
   *  - `reusedSeed: false` — a fresh mnemonic was minted (empty vault,
   *    or only privateKey-imports previously). `mnemonic` is present
   *    and should be surfaced to the user so they can back it up.
   *
   *  The wallet is persisted before returning so a crash between the
   *  call and the caller surfacing the mnemonic cannot silently stash
   *  funds at an unrecoverable address. */
  addWalletFromCreate: (nickname?: string) => Promise<
    | { id: string; address: string; mnemonic: string; reusedSeed: false }
    | { id: string; address: string; reusedSeed: true }
  >;
  /** Import a BIP-39 mnemonic. If the device already manages the same
   *  mnemonic, the next BIP-44 account index is derived (reusedSeed=true);
   *  if it manages a *different* mnemonic, the call rejects — the caller
   *  should delete existing seed-backed wallets first. Returns the newly
   *  created wallet's address. */
  addWalletFromMnemonic: (mnemonic: string, nickname?: string) => Promise<{ address: string; reusedSeed: boolean }>;
  addWalletFromPrivateKey: (privateKey: string, nickname?: string) => Promise<string>;
  /** Delete a built-in wallet. If it was active, the next remaining
   *  wallet is promoted; if none remains, disconnects. */
  removeWallet: (id: string) => Promise<void>;
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
  const [wallets, setWallets] = useState<WalletMeta[]>([]);
  const [activeWalletId, setActiveWalletId] = useState<string | null>(null);

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

  // A signer created against the old readProvider would keep signing
  // against the old network after a switch. Behaviour differs by mode:
  //
  // - **WalletConnect**: sessions are chain-scoped; tear down so the user
  //   re-connects against the new chain via the external wallet app.
  // - **Built-in**: the SecureStore-backed private key is chain-agnostic —
  //   the user's key pair is the same regardless of which RPC we point
  //   at. Rebuilding the signer against the new provider is cheap and
  //   doesn't need new credentials. Rather than kicking the user back
  //   to the Connect flow (old behaviour — they'd re-enter biometric
  //   AND re-pick a wallet from the list), transition to `isLocked`
  //   and let `unlock()` re-hydrate: one biometric tap, same
  //   activeWalletId, same addresses — the notes/claims namespaces
  //   stay put because the address didn't change.
  const prevProviderVersionRef = useRef(providerVersion);
  useEffect(() => {
    if (prevProviderVersionRef.current === providerVersion) return;
    prevProviderVersionRef.current = providerVersion;

    if (connectionMode === 'walletconnect') {
      if (wcProviderRef.current) {
        try { wcProviderRef.current.disconnect(); } catch { /* ignore */ }
        wcProviderRef.current = null;
      }
      setState(INITIAL_STATE);
      setConnectionMode('none');
      // Matches the manual `disconnect()` / `removeWallet()` teardown
      // paths — screens subscribing to `NoteStorageService` (TradeScreen /
      // ClaimScreen / HistoryScreen / HomeScreen) need this signal to
      // eagerly clear note-keyed state before their `[account]` effects
      // run. Without it the UI briefly paints the old wallet's notes
      // while `account` is still transitioning to null.
      NoteStorageService.notifyWalletSwitch(null);
      return;
    }

    if (connectionMode === 'builtin' && state.signer) {
      // Soft lock: drop the signer (binds to the old provider) but
      // keep `lockedAccount` + `activeWalletId` so unlock() can
      // rehydrate against the new provider without asking the user
      // to pick a wallet again.
      setState((s) => ({
        ...INITIAL_STATE,
        isLocked: true,
        lockedAccount: s.account,
      }));
      setConnectionMode('none');
      // NOTE: no `notifyWalletSwitch` — the address is unchanged, so
      // the per-address note/claim namespaces and subscribers are
      // still correct. Firing the hook would force subscribers to
      // clear-and-reload for no reason.
    }
  }, [providerVersion, connectionMode, state.signer]);

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
          name: 'zkScatterDEX',
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
          setActiveWalletId(null);
          NoteStorageService.notifyWalletSwitch(null);
        } else {
          const ethersProvider = new ethers.BrowserProvider(wcProvider);
          const signer = await ethersProvider.getSigner();
          setState((s) => ({ ...s, account: accounts[0], signer, provider: ethersProvider }));
          // A WC session has no built-in wallet id — leaving an old
          // built-in `activeWalletId` in context would contradict the
          // "null when on WalletConnect" contract and confuse UI that
          // keys off it.
          setActiveWalletId(null);
          // WC session switched accounts — note-keyed screens read from
          // per-address storage, so they need to reload for the new account.
          NoteStorageService.notifyWalletSwitch(accounts[0]);
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
      // WC has no built-in wallet identity — clear any leftover id
      // from a previous built-in session so `activeWalletId`
      // honours its "null when on WC" contract.
      setActiveWalletId(null);
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

  // Shared by `connectBuiltin`, `unlock`, and `switchWallet` — all need
  // to re-run the biometric prompt for a specific wallet id and pin the
  // resulting signer into state. Spreading `INITIAL_STATE` ensures
  // every new field (e.g. `isLocked`) gets reset without each call site
  // having to remember to clear it. Passing `id` explicitly rather than
  // re-reading `activeWalletId` avoids a race when switchWallet sets
  // the id and hydrates in the same tick.
  const hydrateBuiltinSession = useCallback(async (id: string) => {
    const signer = await KeySecurityService.getSignerForWallet(id, readProvider);
    if (!signer) throw new Error('Authentication failed');
    const address = await signer.getAddress();
    const network = await readProvider.getNetwork();
    setState({
      ...INITIAL_STATE,
      account: address,
      chainId: Number(network.chainId),
      signer,
    });
    setActiveWalletId(id);
    setConnectionMode('builtin');
    // Subscribers must use the emitted `address`, not re-read
    // `useWallet().account` — the setState above is async so the
    // context value lags one tick behind this emit.
    NoteStorageService.notifyWalletSwitch(address);
  }, [readProvider]);

  // Resolve the id to hydrate when connecting the built-in wallet:
  // prefer the explicit `activeWalletId` the service tracks, else fall
  // back to the oldest wallet (first in the index). Keeps a fresh
  // install that hasn't called `setActiveWalletId` yet from failing
  // the connect.
  const resolveTargetWalletId = useCallback(async (): Promise<string | null> => {
    const activeId = await KeySecurityService.getActiveWalletId();
    if (activeId) return activeId;
    const list = await KeySecurityService.listWallets();
    return list[0]?.id ?? null;
  }, []);

  // ─── 앱 내장 지갑 연결 ──────────────────────────────
  const connectBuiltin = useCallback(async () => {
    setState((s) => ({ ...s, isConnecting: true, error: null }));
    try {
      // Tear down existing WalletConnect session if any
      if (wcProviderRef.current) {
        try { await wcProviderRef.current.disconnect(); } catch { /* ignore */ }
        wcProviderRef.current = null;
      }

      const targetId = await resolveTargetWalletId();
      if (!targetId) {
        throw new Error('NO_WALLET');
      }

      await hydrateBuiltinSession(targetId);
      const list = await KeySecurityService.listWallets();
      setWallets(list);
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
  }, [hydrateBuiltinSession, resolveTargetWalletId]);

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
    setActiveWalletId(null);
    NoteStorageService.notifyWalletSwitch(null);
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
      const targetId = await resolveTargetWalletId();
      if (!targetId) throw new Error('NO_WALLET');
      await hydrateBuiltinSession(targetId);
      const list = await KeySecurityService.listWallets();
      setWallets(list);
    } catch (err: any) {
      setState((s) => ({
        ...s,
        isConnecting: false,
        error: err?.message || 'Unlock failed',
      }));
    }
  }, [hydrateBuiltinSession, resolveTargetWalletId]);

  // ─── Multi-wallet methods ─────────────────────────────────────
  const refreshWallets = useCallback(async () => {
    const [list, activeId] = await Promise.all([
      KeySecurityService.listWallets(),
      KeySecurityService.getActiveWalletId(),
    ]);
    setWallets(list);
    // The storage active-id reflects the built-in wallet state. When
    // the user is currently on a WalletConnect session, the context
    // contract says `activeWalletId` is null — don't let a refresh
    // overwrite that with the stale built-in id.
    setActiveWalletId(connectionMode === 'builtin' ? activeId : null);
  }, [connectionMode]);

  // Hydrate the wallets list on mount so Home can render the correct
  // connect card (Connect Wallet vs Create New Wallet) before the user
  // first taps anything. Without this, a returning user with wallets
  // already in Keychain briefly sees the "no wallet" prompt.
  useEffect(() => { refreshWallets().catch(() => {}); }, [refreshWallets]);

  const switchWallet = useCallback(async (id: string) => {
    const list = await KeySecurityService.listWallets();
    if (!list.some((w) => w.id === id)) {
      throw new Error(`Wallet id not found: ${id}`);
    }
    // Hydrate (biometric + signer) BEFORE persisting the new active
    // id. If the user cancels the biometric prompt or auth throws,
    // stored state stays on the previous wallet so the next
    // connectBuiltin doesn't resume into an un-hydrated session.
    // `getSignerForWallet` works from the id directly, so the write
    // ordering doesn't constrain it.
    await hydrateBuiltinSession(id);
    await KeySecurityService.setActiveWalletId(id);
    setWallets(list);
  }, [hydrateBuiltinSession]);

  // Shared tail for every add-* path: persist the new wallet via the
  // provided service call, then re-sync the cached list. Collapses the
  // three identical post-add dances into one site.
  const addAndRefreshList = useCallback(async <T,>(addFn: () => Promise<T>): Promise<T> => {
    const result = await addFn();
    const list = await KeySecurityService.listWallets();
    setWallets(list);
    return result;
  }, []);

  const addWalletFromCreate = useCallback((nickname?: string) =>
    addAndRefreshList(() => KeySecurityService.createWallet(nickname)),
  [addAndRefreshList]);

  const addWalletFromMnemonic = useCallback((mnemonic: string, nickname?: string) =>
    addAndRefreshList(() => KeySecurityService.importFromMnemonic(mnemonic, nickname)),
  [addAndRefreshList]);

  const addWalletFromPrivateKey = useCallback((privateKey: string, nickname?: string) =>
    addAndRefreshList(() => KeySecurityService.importFromPrivateKey(privateKey, nickname)),
  [addAndRefreshList]);

  const removeWallet = useCallback(async (id: string) => {
    // Read active-id from storage rather than React state so a
    // concurrent switchWallet whose setState hasn't flushed yet can't
    // trick us into the non-active branch.
    const activeBefore = await KeySecurityService.getActiveWalletId();
    const wasActive = id === activeBefore;
    await KeySecurityService.deleteWallet(id);
    const list = await KeySecurityService.listWallets();
    setWallets(list);
    if (!wasActive) return;
    // Active wallet removed — KeySecurityService has already promoted
    // the next wallet (or cleared the mirror). Re-hydrate so state
    // matches storage, or disconnect if nothing remains.
    const nextActiveId = await KeySecurityService.getActiveWalletId();
    if (nextActiveId) {
      await hydrateBuiltinSession(nextActiveId);
    } else {
      setState(INITIAL_STATE);
      setConnectionMode('none');
      setActiveWalletId(null);
      NoteStorageService.notifyWalletSwitch(null);
    }
  }, [hydrateBuiltinSession]);

  // Memoize the context value — otherwise every render of WalletProvider
  // hands consumers a fresh object identity and re-renders every screen
  // that reads from `useWallet()`, even when nothing they care about
  // actually changed.
  const ctxValue = useMemo<WalletContextValue>(
    () => ({
      ...state,
      connectionMode,
      connect,
      connectBuiltin,
      disconnect,
      unlock,
      readProvider,
      wallets,
      activeWalletId,
      refreshWallets,
      switchWallet,
      addWalletFromCreate,
      addWalletFromMnemonic,
      addWalletFromPrivateKey,
      removeWallet,
    }),
    [
      state, connectionMode, connect, connectBuiltin, disconnect, unlock, readProvider,
      wallets, activeWalletId, refreshWallets, switchWallet,
      addWalletFromCreate, addWalletFromMnemonic, addWalletFromPrivateKey, removeWallet,
    ],
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
