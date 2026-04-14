/**
 * confirmShareSecret — two-step gate before handing a sensitive string
 * (stealth private key, spending/viewing keys, seed material, …) to
 * `Share.share`. The OS share sheet exposes the payload to any
 * installed target (Mail, Slack, screenshot tools), so every call site
 * should interrupt with an explicit warning before firing.
 *
 * Used by SettingsScreen (reveal keys → Share) and ClaimScreen
 * (stealth privkey → Share). Keep this in one place so the copy and
 * the destructive-style UX stay consistent.
 */
import { Alert, Share } from 'react-native';

export interface ConfirmShareSecretInput {
  /** Alert title, e.g. "Share stealth private key?". */
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
      // Swallow share errors — user cancelling the share sheet rejects
      // the promise and is not actionable for us.
      onPress: () => Share.share({ message: shareMessage }).catch(() => {}),
    },
  ]);
}
