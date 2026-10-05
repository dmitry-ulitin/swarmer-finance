import { ChainTransfer, ChainTx } from './types';

/** Tether's USDT on Ethereum; transfers of any other token are ignored. */
export const USDT_CONTRACT = '0xdac17f958d2ee523a2206206994597c13d831ec7';

/** The parts of an Etherscan-API normal or internal transaction this provider reads. */
export interface EthTx {
  hash: string;
  blockNumber: string;
  /** Unix seconds as a decimal string. */
  timeStamp: string;
  from: string;
  /** Empty for a contract creation. */
  to: string;
  /** Wei as a decimal string. */
  value: string;
  isError: string;
  /** Normal transactions only; `gasPrice` there is the effective price paid. */
  gasUsed?: string;
  gasPrice?: string;
}

/** The parts of an Etherscan-API token transfer this provider reads. */
export interface TokenTransfer {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  /** Token base units as a decimal string. */
  value: string;
  contractAddress: string;
}

const toDate = (seconds: string) => new Date(Number(seconds) * 1000).toISOString().slice(0, 10);

/**
 * Wei in the 1e-8 ETH units ETH accounts store (currencyScale.ts caps ETH
 * at 8 decimals), rounded half-up. Sub-unit amounts become 0.
 */
export const weiToScale8 = (wei: bigint): number => Number((wei + 5_000_000_000n) / 10_000_000_000n);

/**
 * USDT movements grouped by transaction. A transaction whose records are all
 * dropped (another token, a transfer to itself) still comes back, with no
 * transfers, so sync marks it seen and paging can stop on it. Values are read
 * as Numbers: one transfer would need 9e9 USDT to lose precision.
 */
export function tokenToChainTxs(records: TokenTransfer[], address: string): ChainTx[] {
  const byTx = new Map<string, ChainTx>();
  for (const r of records) {
    let tx = byTx.get(r.hash);
    if (!tx) {
      tx = { txid: r.hash, date: toDate(r.timeStamp), fee: 0, transfers: [] };
      byTx.set(r.hash, tx);
    }
    if (r.contractAddress !== USDT_CONTRACT || r.from === r.to) continue;
    const value = Number(r.value);
    if (r.to === address) tx.transfers.push({ counterparty: r.from, amount: value });
    else if (r.from === address) tx.transfers.push({ counterparty: r.to, amount: -value });
  }
  return [...byTx.values()];
}

/**
 * One movement for a transaction that both sent and received ETH (a DEX
 * refunding the excess): planTx files a transaction with anything incoming
 * as income only, which would lose what was sent.
 */
function net(transfers: ChainTransfer[]): ChainTransfer[] {
  if (!transfers.some(t => t.amount > 0) || !transfers.some(t => t.amount < 0)) return transfers;
  const amount = transfers.reduce((s, t) => s + t.amount, 0);
  if (amount === 0) return [];
  const largest = transfers
    .filter(t => Math.sign(t.amount) === Math.sign(amount))
    .reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
  return [{ counterparty: largest.counterparty, amount }];
}

/**
 * ETH movements of both lists, merged by hash, oldest first. Gas is ours
 * whenever we sent the transaction — whatever it did, USDT sends and failed
 * calls included; the sender of an incoming transfer pays its own. Internal
 * transfers count only incoming (an ordinary wallet cannot make one).
 */
export function ethToChainTxs(normal: EthTx[], internal: EthTx[], address: string): ChainTx[] {
  const byTx = new Map<string, ChainTx & { block: number }>();
  const txOf = (r: EthTx) => {
    let tx = byTx.get(r.hash);
    if (!tx) {
      tx = { txid: r.hash, block: Number(r.blockNumber), date: toDate(r.timeStamp), fee: 0, transfers: [] };
      byTx.set(r.hash, tx);
    }
    return tx;
  };
  const move = (tx: ChainTx, counterparty: string, wei: bigint, sign: 1 | -1) => {
    const amount = weiToScale8(wei);
    if (amount > 0) tx.transfers.push({ counterparty, amount: sign * amount });
  };

  for (const r of normal) {
    const tx = txOf(r);
    const value = BigInt(r.value);
    if (r.isError === '0' && value > 0n) {
      if (r.to === address && r.from !== address) move(tx, r.from, value, 1);
      else if (r.from === address && r.to !== address && r.to !== '') move(tx, r.to, value, -1);
    }
    if (r.from === address) tx.fee = weiToScale8(BigInt(r.gasUsed ?? '0') * BigInt(r.gasPrice ?? '0'));
  }
  for (const r of internal) {
    const tx = txOf(r);
    if (r.isError === '0' && r.to === address && r.from !== address) move(tx, r.from, BigInt(r.value), 1);
  }

  return [...byTx.values()]
    .sort((a, b) => a.block - b.block)
    .map(({ txid, date, fee, transfers }) => ({ txid, date, fee, transfers: net(transfers) }));
}
