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
  /** Native currency, e.g. 'BTC'. A tracked account must use it. */
  currency: string;
  /** Decimal places of the base unit, e.g. 8 for satoshis. */
  scale: number;
  /** Confirmed transactions of `address` not in `known`, oldest first. */
  fetchNewTxs(address: string, known: ReadonlySet<string>): Promise<ChainTx[]>;
}
