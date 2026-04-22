/**
 * TradeHistoryStorage — per-order trade records, scoped per-wallet.
 *
 * StoredNote only captures the UTXO state (active/spent/pending). That's
 * enough for balance math, but it can't answer "what happened to this
 * commitment" — sell amount, change produced, who received what. We
 * persist a separate trade record keyed by the source note id so the
 * History screen can expand a spent note and show the full picture.
 *
 * Records are saved AFTER the relayer accepts the authorize proof, so
 * a record implies at least a submitted order. Settlement state is
 * backfilled later (future enhancement — scan SettledScatter events
 * and attach tx hash).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'scatterdex_trade_history_';

export interface TradeClaim {
  recipient: string;      // 0x address (stealth address for stealth mode)
  amount: string;         // wei string (buyToken units)
  releaseTime: string;    // unix seconds
  secret: string;         // field element (kept locally so the user can claim later)
  ephemeralPubKey?: string;
}

export interface TradeRecord {
  /** orderHash as decimal string — primary key */
  id: string;
  /** the spent note's id (commitment) — links Spent tab → this record */
  sourceNoteId: string;
  /** change UTXO's id, when there was a remainder */
  changeNoteId?: string;
  sellToken: string;
  sellTokenSymbol: string;
  buyToken: string;
  buyTokenSymbol: string;
  sellAmount: string;     // wei
  buyAmount: string;      // wei (gross, before relay fee)
  changeAmount: string;   // wei
  maxFeeBps: number;
  relayerAddress: string;
  relayerUrl: string;
  orderId?: string;       // returned by relayer, if any
  claims: TradeClaim[];
  /** Backfilled when we later scan SettledScatter events. */
  settleTxHash?: string;
  createdAt: number;
}

const keyFor = (address: string) => `${PREFIX}${address.toLowerCase()}`;

async function readAll(address: string): Promise<TradeRecord[]> {
  const raw = await AsyncStorage.getItem(keyFor(address));
  if (!raw) return [];
  try { return JSON.parse(raw) as TradeRecord[]; }
  catch { return []; }
}

export const TradeHistoryStorage = {
  async append(address: string, record: TradeRecord): Promise<void> {
    const all = await readAll(address);
    // Primary key is orderHash — a re-submit of the same order shouldn't
    // duplicate the record, so overwrite on match.
    const existing = all.findIndex((r) => r.id === record.id);
    if (existing >= 0) all[existing] = record;
    else all.push(record);
    await AsyncStorage.setItem(keyFor(address), JSON.stringify(all));
  },

  async getAll(address: string): Promise<TradeRecord[]> {
    return readAll(address);
  },

  /** Find the trade record whose `sourceNoteId` matches — lets the
   *  History screen show trade details for a Spent note. */
  async getBySourceNoteId(
    address: string,
    sourceNoteId: string,
  ): Promise<TradeRecord | null> {
    const all = await readAll(address);
    return all.find((r) => r.sourceNoteId === sourceNoteId) ?? null;
  },

  async setSettleTxHash(
    address: string,
    id: string,
    settleTxHash: string,
  ): Promise<void> {
    const all = await readAll(address);
    const rec = all.find((r) => r.id === id);
    if (!rec) return;
    rec.settleTxHash = settleTxHash;
    await AsyncStorage.setItem(keyFor(address), JSON.stringify(all));
  },

  async clear(address: string): Promise<void> {
    await AsyncStorage.removeItem(keyFor(address));
  },
};
