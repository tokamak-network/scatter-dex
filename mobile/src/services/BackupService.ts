/**
 * BackupService — single-file export / import of all locally-stored
 * user state (notes, pending claims, address book).
 *
 * Mobile has no File System Access API like the web's notes-folder, so
 * we collapse the same data into a single JSON blob the user can save
 * via the Share sheet (Files app, AirDrop, email, …) and re-import by
 * pasting back. EdDSA keys and the wallet itself are intentionally
 * excluded — both are recoverable from the underlying wallet signature
 * or recovery phrase, so doubling them in the backup increases the
 * leak surface for no recovery benefit.
 *
 * Restore policy is *additive*: existing entries with the same id /
 * commitment / address are kept, never overwritten. The same backup
 * file can be safely re-imported on a phone that already has some
 * entries without clobbering them.
 */
import { NoteStorageService, StoredNote } from './NoteStorageService';
import { PendingClaimsStorage, PendingClaim, PendingClaimInput } from './PendingClaimsStorage';
import { AddressBookService, WalletEntry } from './AddressBookService';

export const BACKUP_VERSION = 1;

export interface BackupBundle {
  version: typeof BACKUP_VERSION;
  exportedAt: number;       // unix seconds
  notes: StoredNote[];
  pendingClaims: PendingClaim[];
  addressBook: WalletEntry[];
}

export interface RestoreSummary {
  notes: { added: number; skipped: number };
  pendingClaims: { added: number; skipped: number };
  /** Address book counts split: `skipped` is for entries the service
   *  rejected as duplicates (already in the book — expected and benign);
   *  `invalid` is everything else (bad address / blank label / etc.) so
   *  the UI can surface that something is actually wrong with the file. */
  addressBook: { added: number; skipped: number; invalid: number };
}

export const BackupService = {
  /**
   * Snapshot every locally-stored row into a single JSON-serializable
   * bundle. Caller is responsible for transport (Share sheet, clipboard,
   * etc.).
   */
  async exportAll(): Promise<BackupBundle> {
    // Don't swallow address-book errors: silently substituting an empty
    // array would produce a backup file the user thinks is complete but
    // is actually missing labels. Wrap with context so the UI can name
    // which section failed.
    const [notes, pendingClaims, addressBook] = await Promise.all([
      NoteStorageService.getAllNotes(),
      PendingClaimsStorage.list(),
      AddressBookService.list().catch((err: unknown) => {
        const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
        throw new Error(`Failed to read address book for backup${detail}`);
      }),
    ]);
    return {
      version: BACKUP_VERSION,
      exportedAt: Math.floor(Date.now() / 1000),
      notes,
      pendingClaims,
      addressBook,
    };
  },

  /** Convenience helper for the UI — prettifies and includes a header. */
  serialize(bundle: BackupBundle): string {
    return JSON.stringify(bundle, null, 2);
  },

  /**
   * Parse an exported bundle. Throws on missing / wrong-version /
   * unparseable input so the UI can surface a precise error rather than
   * partially restoring garbage.
   */
  parse(json: string): BackupBundle {
    let parsed: any;
    try { parsed = JSON.parse(json); } catch (e) {
      throw new Error(`Backup is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}`);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Backup is not an object');
    }
    if (parsed.version !== BACKUP_VERSION) {
      const hint = typeof parsed.version === 'number' && parsed.version > BACKUP_VERSION
        ? 'Update the app to import this newer backup.'
        : `Expected version ${BACKUP_VERSION}.`;
      throw new Error(`Backup version ${parsed.version} is not supported. ${hint}`);
    }
    if (!Array.isArray(parsed.notes) || !Array.isArray(parsed.pendingClaims) || !Array.isArray(parsed.addressBook)) {
      throw new Error('Backup is missing one of: notes, pendingClaims, addressBook');
    }
    return parsed as BackupBundle;
  },

  /**
   * Restore a bundle additively. Entries colliding with what's already
   * stored are skipped — the user can re-import the same file safely.
   * Returns per-category counts so the UI can report what changed.
   */
  async restore(bundle: BackupBundle): Promise<RestoreSummary> {
    const summary: RestoreSummary = {
      notes: { added: 0, skipped: 0 },
      pendingClaims: { added: 0, skipped: 0 },
      addressBook: { added: 0, skipped: 0, invalid: 0 },
    };

    // Notes — keyed by id (= commitment). Pre-filter against existing ids
    // AND against duplicates within the bundle itself (same id appearing
    // twice must not overwrite the first copy silently), then hand the
    // filtered batch to `saveNotesBulk` — parallel per-key writes with a
    // single index update at the end. The sequential `saveNote` loop this
    // replaces also raced on the index read-modify-write.
    //
    // Use `getNoteIds` (AsyncStorage one-shot) instead of `getAllNotes` —
    // we only need the ids for the dedup check, and `getAllNotes` would
    // otherwise pay for N parallel SecureStore reads to hydrate full note
    // bodies we immediately discard.
    const seenNoteIds = new Set(await NoteStorageService.getNoteIds());
    const notesToSave: StoredNote[] = [];
    for (const note of bundle.notes) {
      if (seenNoteIds.has(note.id)) {
        summary.notes.skipped++;
        continue;
      }
      seenNoteIds.add(note.id);
      notesToSave.push(note);
    }
    if (notesToSave.length > 0) {
      const results = await NoteStorageService.saveNotesBulk(notesToSave);
      for (const r of results) {
        if (r.ok) summary.notes.added++;
        else summary.notes.skipped++;
      }
    }

    // Pending claims — no natural dedup key on the row itself (the secret
    // is the unique value but we don't surface it as a key). Use the
    // tuple (settlementId, leafIndex, amount) which is stable per-order.
    // `settlementId = orderId || txHash` — pre-split entries stored the
    // orderId in the `txHash` slot, so falling back keeps old backups
    // deduping against new storage. New `id`s are generated by `append`,
    // so a re-import gets fresh ids and we dedup on content. Validate the
    // row shape up front so a malformed entry can't cause `append` to
    // throw mid-write — that would leave orphan secrets/meta after some
    // have already landed.
    const existingClaims = await PendingClaimsStorage.list();
    const claimKey = (c: { orderId?: string; txHash: string; leafIndex: number; amount: string }): string =>
      `${c.orderId || c.txHash}#${c.leafIndex}#${c.amount}`;
    const existingClaimKey = new Set(existingClaims.map(claimKey));
    const claimsToAdd: PendingClaimInput[] = [];
    for (const c of bundle.pendingClaims) {
      // Up-front validation — every field that `PendingClaimsStorage.append`
      // assumes present. Bail before any write so we don't get a half-
      // committed batch.
      if (
        typeof c?.secret !== 'string'
        || typeof c?.recipient !== 'string'
        || typeof c?.token !== 'string'
        || typeof c?.amount !== 'string'
        || typeof c?.releaseTime !== 'string'
        || typeof c?.txHash !== 'string'
        || typeof c?.leafIndex !== 'number'
        || !Array.isArray(c?.allLeaves)
      ) {
        summary.pendingClaims.skipped++;
        continue;
      }
      const key = claimKey(c);
      if (existingClaimKey.has(key)) {
        summary.pendingClaims.skipped++;
        continue;
      }
      // Also dedup within the bundle so two entries with the same key
      // don't both get written.
      existingClaimKey.add(key);
      claimsToAdd.push({
        secret: c.secret,
        recipient: c.recipient,
        token: c.token,
        amount: c.amount,
        releaseTime: c.releaseTime,
        leafIndex: c.leafIndex,
        allLeaves: c.allLeaves,
        txHash: c.txHash,
        // `bundle.pendingClaims` is parsed from external JSON — guard both
        // the runtime type and truthiness so a malformed number/null/''
        // never lands in storage.
        ...(typeof c.orderId === 'string' && c.orderId ? { orderId: c.orderId } : {}),
        ...(typeof c.ephemeralPubKey === 'string' && c.ephemeralPubKey
          ? { ephemeralPubKey: c.ephemeralPubKey } : {}),
      });
    }
    if (claimsToAdd.length > 0) {
      await PendingClaimsStorage.append(claimsToAdd);
      summary.pendingClaims.added = claimsToAdd.length;
    }

    // Address book — `addMany` takes the mutation lock once and writes
    // the book in a single read-all / write-all round-trip. Iterating
    // `add` per entry was O(N²) I/O because each call re-read and
    // re-wrote the whole book under its own lock.
    if (bundle.addressBook.length > 0) {
      const results = await AddressBookService.addMany(
        bundle.addressBook.map((entry) => ({
          label: entry.label,
          address: entry.address,
          kind: entry.kind,
          memo: entry.memo,
        })),
      );
      for (const r of results) {
        if (r.ok) summary.addressBook.added++;
        else if (r.reason === 'duplicate') summary.addressBook.skipped++;
        else summary.addressBook.invalid++;
      }
    }

    return summary;
  },
};
