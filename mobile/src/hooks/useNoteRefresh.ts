/**
 * useNoteRefresh — unify the mount / focus / notesChanged reload triad
 * that Trade, Claim, History, Deposit, and Home all need. One hook,
 * one place to add future triggers (e.g. account-switch events).
 *
 * `useFocusEffect` also fires on first mount under React Navigation, so
 * we do NOT add a standalone `useEffect(loader)` — that would run the
 * loader twice on the initial render.
 */
import { useCallback, useEffect } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { NoteStorageService } from '../services/NoteStorageService';

export function useNoteRefresh(loader: () => void | Promise<void>): void {
  useFocusEffect(useCallback(() => { void loader(); }, [loader]));
  useEffect(() => NoteStorageService.subscribeNotesChanged(() => { void loader(); }), [loader]);
}
