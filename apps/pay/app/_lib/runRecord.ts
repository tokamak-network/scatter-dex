"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadRun,
  recordSentNotification,
  recordSentNotificationsBatch,
  RunRecordCorruptError,
  type RunRecord,
  type SendNotificationInput,
} from "@zkscatter/sdk/storage";
import { useFolderStorage } from "./folderStorage";

interface RunRecordState {
  record: RunRecord | null;
  loaded: boolean;
  /** Surfaced when `zkscatter-run-<id>.json` is unparseable. Distinct
   *  from "file missing" so the UI can guide the user to repair the
   *  file instead of letting the next save overwrite it. */
  corrupt: RunRecordCorruptError | null;
  error: string | null;
  markSent(input: SendNotificationInput): Promise<boolean>;
  markSentBatch(entries: SendNotificationInput[]): Promise<boolean>;
  refresh(): Promise<void>;
}

/** Hook for a single `/payouts/[id]` page. Hydrates from
 *  `@zkscatter/sdk/storage/runs` once the folder is ready. */
export function useRunRecord(id: string | undefined): RunRecordState {
  const { ready: folderReady } = useFolderStorage();
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [corrupt, setCorrupt] = useState<RunRecordCorruptError | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) {
      setRecord(null);
      setLoaded(true);
      return;
    }
    try {
      const r = await loadRun(id);
      setRecord(r);
      setCorrupt(null);
      setError(null);
    } catch (e) {
      if (e instanceof RunRecordCorruptError) {
        setCorrupt(e);
        setRecord(null);
      } else {
        setRecord(null);
        setError(e instanceof Error ? e.message : "Failed to load run record");
      }
    } finally {
      setLoaded(true);
    }
  }, [id]);

  useEffect(() => {
    if (!folderReady) {
      setRecord(null);
      setCorrupt(null);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    void refresh();
  }, [folderReady, refresh]);

  const markSent = useCallback(
    async (input: SendNotificationInput) => {
      if (!id) return false;
      try {
        const next = await recordSentNotification({ runId: id, ...input });
        setRecord(next.record);
        setError(null);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to record notification");
        return false;
      }
    },
    [id],
  );

  const markSentBatch = useCallback(
    async (entries: SendNotificationInput[]) => {
      if (!id || entries.length === 0) return entries.length === 0;
      try {
        const next = await recordSentNotificationsBatch({ runId: id, entries });
        setRecord(next.record);
        setError(null);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to record notifications");
        return false;
      }
    },
    [id],
  );

  return { record, loaded, corrupt, error, markSent, markSentBatch, refresh };
}
