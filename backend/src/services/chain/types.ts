/**
 * One counterparty's net movement in a transaction, in the chain's base unit
 * (satoshis for Bitcoin): positive = received from it, negative = sent to it.
 * Plain numbers are safe — all bitcoin ever is 2.1e15 sats, well inside
 * Number's integer range.
 */
export interface ChainTransfer {
  counterparty: string;
  amount: number;
}

/**
 * An on-chain transaction as seen from one address. Chain specifics (UTXOs,
 * change outputs, gas) stay in the provider; sync only reads this shape.
 */
export interface ChainTx {
  txid: string;
  /** YYYY-MM-DD, UTC date of the block. */
  date: string;
  /** Fee paid by this address; 0 when it did not pay. */
  fee: number;
  transfers: ChainTransfer[];
}

export interface ChainProvider {
  /**
   * Currencies a tracked account on this chain may use, with the decimal
   * places of their base unit, e.g. { BTC: 8 } for satoshis. One chain can
   * carry several assets (TRON: TRX and USDT); an account syncs one.
   */
  currencies: Readonly<Record<string, number>>;
  /** Confirmed transactions of `address` in `currency` not in `known`, oldest first. */
  fetchNewTxs(address: string, currency: string, known: ReadonlySet<string>): Promise<ChainTx[]>;
}
