// Shim for @react-native-community/netinfo
// WalletConnect imports this but it crashes on Expo SDK 54.
// Provides a no-op implementation so WalletConnect can load without error.
export default {
  configure: () => {},
  addEventListener: () => () => {},
  removeEventListener: () => {},
  fetch: () => Promise.resolve({ isConnected: true, isInternetReachable: true, type: 'wifi' }),
};
export const useNetInfo = () => ({ isConnected: true, isInternetReachable: true, type: 'wifi' });
