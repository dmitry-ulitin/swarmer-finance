import { ChainProvider, ChainTransfer, ChainTx } from './types';

/** The parts of an Esplora transaction this provider reads. */
export interface EsploraTx {
  txid: string;
  fee: number;
  status: { confirmed: boolean; block_time?: number };
  // prevout is null for a coinbase input.
  vin: { prevout: { scriptpubkey_address?: string; value: number } | null }[];
  vout: { scriptpubkey_address?: string; value: number }[];
}

// Esplora's fixed page size for /txs/chain.
const PAGE_SIZE = 25;
const TIMEOUT_MS = 10_000;

const baseUrl = () => process.env.BITCOIN_ESPLORA_URL || 'https://mempool.space/api';
const unavailable = () => ({ statusCode: 502, message: 'Blockchain API unavailable' });

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw unavailable();
  }
  // Esplora answers 400 "Invalid Bitcoin address" for a malformed address;
  // anything else that is not OK (429 rate limit, 5xx) is the API's problem.
  if (res.status === 400) throw { statusCode: 400, message: 'Invalid address' };
  if (!res.ok) throw unavailable();
  return (await res.json()) as T;
}

/**
 * A confirmed transaction as seen from `address`.
 *
 * Bitcoin has no "from/to": a transaction spends inputs and creates outputs.
 * If none of the inputs is ours we received — the sum of outputs to us, from
 * the first input's address (a UTXO cannot say which input paid which
 * output). If any input is ours we paid, and every output not back to us is
 * money leaving; outputs back to us are change, not a movement.
 */
export function toChainTx(tx: EsploraTx, address: string): ChainTx {
  const date = new Date(tx.status.block_time! * 1000).toISOString().slice(0, 10);
  const spent = tx.vin.some(i => i.prevout?.scriptpubkey_address === address);

  if (!spent) {
    const received = tx.vout
      .filter(o => o.scriptpubkey_address === address)
      .reduce((sum, o) => sum + o.value, 0);
    const from = tx.vin.find(i => i.prevout?.scriptpubkey_address)?.prevout?.scriptpubkey_address ?? '';
    return { txid: tx.txid, date, fee: 0, transfers: [{ counterparty: from, amount: received }] };
  }

  const transfers: ChainTransfer[] = tx.vout
    .filter(o => o.scriptpubkey_address !== address && o.value > 0)
    .map(o => ({ counterparty: o.scriptpubkey_address ?? '', amount: -o.value }));
  return { txid: tx.txid, date, fee: tx.fee, transfers };
}

export const bitcoinProvider: ChainProvider = {
  currency: 'BTC',
  scale: 8,

  async fetchNewTxs(address, known) {
    const base = `/address/${encodeURIComponent(address)}/txs/chain`;
    const fresh: EsploraTx[] = [];
    let path = base;
    for (;;) {
      const page = await getJson<EsploraTx[]>(path);
      const unseen = page.filter(t => !known.has(t.txid));
      fresh.push(...unseen);
      // Pages run newest first, and a sync records all of its txs as seen or
      // none, so a page with nothing new means everything older was seen too.
      if (page.length < PAGE_SIZE || unseen.length === 0) break;
      path = `${base}/${page[page.length - 1].txid}`;
    }
    // Oldest first, so rows are inserted in the order they happened.
    return fresh.reverse().map(t => toChainTx(t, address));
  },
};
