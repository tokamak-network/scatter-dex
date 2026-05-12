/**
 * confirmShareSecret — two-step gate before handing a sensitive string
 * (seed material, private keys, …) to `Share.share`. The OS share
 * sheet exposes the payload to any installed target (Mail, Slack,
 * screenshot tools), so every call site should interrupt with an
 * explicit warning before firing.
 *
 * Keep the copy + destructive-style UX in one place so they stay
 * consistent across call sites.
 */
import { Alert, Share } from 'react-native';

export interface ConfirmShareSecretInput {
  /** Alert title, e.g. "Share private key?". */
  title: string;
  /** Alert body explaining the risk. */
  body: string;
  /** The message passed to the OS share sheet. Sensitive. */
  shareMessage: string;
}

export function confirmShareSecret({ title, body, shareMessage }: ConfirmShareSecretInput): void {
  Alert.alert(title, body, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Continue to Share',
      style: 'destructive',
      // Share.share resolves with `{action}` on both success and user
      // dismissal, so the resolved path is a no-op. Rejection signals a
      // real failure (system error, invalid payload) — log it and tell
      // the user so real failures are not silently hidden, matching
      // BackupModal's share-sheet handling.
      onPress: () => {
        Share.share({ message: shareMessage }).catch((err: unknown) => {
          console.error('confirmShareSecret: Share.share failed', err);
          Alert.alert('Share failed', 'Unable to open the share sheet. Please try again.');
        });
      },
    },
  ]);
}
