import { createHash } from 'crypto';
import { ChainProvider, ChainTransfer, ChainTx } from './types';

/** Tether's USDT on TRON; transfers of any other token are ignored. */
export const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

/** The parts of a TronGrid TRC20 transfer record this provider reads. */
export interface Trc20Transfer {
  transaction_id: string;
  block_timestamp: number;
  from: string;
  to: string;
  /** Base units as a decimal string. */
  value: string;
  token_info: { address: string };
}

/** The parts of a TronGrid transaction this provider reads. */
export interface TronTx {
  txID: string;
  block_timestamp: number;
  ret: { contractRet?: string; fee?: number }[];
  raw_data: {
    contract: {
      type: string;
      parameter: {
        value: {
          owner_address: string;
          to_address?: string;
          amount?: number;
          contract_address?: string;
          call_value?: number;
        };
      };
    }[];
  };
}

interface Page<T> {
  data: T[];
  meta?: { fingerprint?: string };
}

const PAGE_SIZE = 200;
const TIMEOUT_MS = 10_000;
// Keyless TronGrid allows one request per second and suspends the caller
// for 5 s on a breach; pages (and back-to-back syncs) keep to that.
const KEYLESS_INTERVAL_MS = 1_100;
// Base58check form users see; the API also accepts hex, but every
// comparison here is against base58, so a hex address would match nothing.
const ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const baseUrl = () => process.env.TRON_API_URL || 'https://api.trongrid.io';
const unavailable = () => ({ statusCode: 502, message: 'Blockchain API unavailable' });
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest();

/**
 * A hex address as TronGrid's transaction list gives it (`41` + 20 bytes)
 * in the base58check form users see (`T…`). TRON addresses never start
 * with a zero byte, so there are no leading '1's to restore.
 */
export function toBase58(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  const checked = Buffer.concat([bytes, sha256(sha256(bytes)).subarray(0, 4)]);
  let n = BigInt(`0x${checked.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

let nextKeylessAt = 0;

async function getJson<T>(path: string): Promise<T> {
  const key = process.env.TRONGRID_API_KEY;
  if (!key) {
    const wait = nextKeylessAt - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    nextKeylessAt = Date.now() + KEYLESS_INTERVAL_MS;
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(key ? { headers: { 'TRON-PRO-API-KEY': key } } : {}),
    });
  } catch {
    throw unavailable();
  }
  // TronGrid answers 400 for a malformed address; anything else that is not
  // OK (403/429 rate limit, 5xx) is the API's problem.
  if (res.status === 400) throw { statusCode: 400, message: 'Invalid address' };
  if (!res.ok) throw unavailable();
  return (await res.json()) as T;
}

/**
 * Every record of `path` whose id is not in `known`, oldest first. Pages
 * run newest first, and a sync records all of its txs as seen or none, so a
 * page with nothing new means everything older was seen too.
 */
async function fetchUnseen<T>(path: string, idOf: (r: T) => string, known: ReadonlySet<string>): Promise<T[]> {
  const first = `${path}limit=${PAGE_SIZE}&only_confirmed=true`;
  const fresh: T[] = [];
  let url = first;
  for (;;) {
    const page = await getJson<Page<T>>(url);
    const unseen = page.data.filter(r => !known.has(idOf(r)));
    fresh.push(...unseen);
    const next = page.meta?.fingerprint;
    if (!next || unseen.length === 0) break;
    url = `${first}&fingerprint=${encodeURIComponent(next)}`;
  }
  return fresh.reverse();
}

/**
 * USDT movements grouped by transaction. A transaction whose records are
 * all dropped (another token, a transfer to itself) still comes back, with
 * no transfers, so sync marks it seen and paging can stop on it. Values are
 * read as Numbers: one transfer would need 9e9 USDT to lose precision.
 */
export function trc20ToChainTxs(records: Trc20Transfer[], address: string): ChainTx[] {
  const byTx = new Map<string, ChainTx>();
  for (const r of records) {
    let tx = byTx.get(r.transaction_id);
    if (!tx) {
      tx = { txid: r.transaction_id, date: toDate(r.block_timestamp), fee: 0, transfers: [] };
      byTx.set(r.transaction_id, tx);
    }
    if (r.token_info.address !== USDT_CONTRACT || r.from === r.to) continue;
    const value = Number(r.value);
    if (r.to === address) tx.transfers.push({ counterparty: r.from, amount: value });
    else if (r.from === address) tx.transfers.push({ counterparty: r.to, amount: -value });
  }
  return [...byTx.values()];
}

/**
 * A TRX-denominated view of one transaction. Its fee is ours whenever we
 * signed it — whatever it did, USDT sends included, since TRON gas is
 * always TRX; the sender of an incoming transfer pays its own. Only plain
 * TRX transfers and TRX sent along with a contract call move money here;
 * staking, votes and the like keep just their fee (out of scope).
 */
export function trxToChainTx(tx: TronTx, address: string): ChainTx {
  const contract = tx.raw_data.contract[0];
  const v = contract.parameter.value;
  const owner = toBase58(v.owner_address);
  const ok = tx.ret[0]?.contractRet === 'SUCCESS';
  const transfers: ChainTransfer[] = [];

  if (ok && contract.type === 'TransferContract' && v.to_address && v.amount) {
    const to = toBase58(v.to_address);
    if (to === address && owner !== address) transfers.push({ counterparty: owner, amount: v.amount });
    else if (owner === address && to !== address) transfers.push({ counterparty: to, amount: -v.amount });
  } else if (ok && contract.type === 'TriggerSmartContract' && owner === address && v.contract_address && v.call_value) {
    transfers.push({ counterparty: toBase58(v.contract_address), amount: -v.call_value });
  }

  return {
    txid: tx.txID,
    date: toDate(tx.block_timestamp),
    fee: owner === address ? tx.ret[0]?.fee ?? 0 : 0,
    transfers,
  };
}

export const tronProvider: ChainProvider = {
  currencies: { TRX: 6, USDT: 6 },

  async fetchNewTxs(address, currency, known) {
    if (!ADDRESS.test(address)) throw { statusCode: 400, message: 'Invalid address' };
    const base = `/v1/accounts/${encodeURIComponent(address)}`;
    if (currency === 'USDT') {
      const records = await fetchUnseen<Trc20Transfer>(
        `${base}/transactions/trc20?contract_address=${USDT_CONTRACT}&`, r => r.transaction_id, known
      );
      return trc20ToChainTxs(records, address);
    }
    const txs = await fetchUnseen<TronTx>(`${base}/transactions?search_internal=false&`, t => t.txID, known);
    return txs.map(t => trxToChainTx(t, address));
  },
};
