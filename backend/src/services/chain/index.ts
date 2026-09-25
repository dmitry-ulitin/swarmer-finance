import type { Account } from '../../types';
import type { ChainProvider } from './types';
import { bitcoinProvider } from './bitcoin';
import { tronProvider } from './tron';

export type { ChainProvider, ChainTx, ChainTransfer } from './types';

// Keyed by the value stored in accounts.settings.blockchain.
const PROVIDERS = new Map<string, ChainProvider>([
  ['bitcoin', bitcoinProvider],
  ['tron', tronProvider],
]);

/** The provider for a `settings.blockchain` value, or null when unsupported. */
export function getProvider(blockchain: unknown): ChainProvider | null {
  return typeof blockchain === 'string' ? PROVIDERS.get(blockchain) ?? null : null;
}

/**
 * A crypto account whose transactions come from the blockchain: it names an
 * address on a chain we have a provider for. Anything else — including a
 * crypto account without an address, such as an exchange balance — is an
 * ordinary, hand-edited account.
 */
export function isTracked(account: Pick<Account, 'type' | 'settings'>): boolean {
  const { address, blockchain } = account.settings as { address?: unknown; blockchain?: unknown };
  return account.type === 'crypto'
    && typeof address === 'string'
    && address !== ''
    && getProvider(blockchain) !== null;
}
