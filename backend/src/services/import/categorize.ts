/**
 * Category suggestions for imported rows, learned from the user's own
 * categorised history. Pure: the caller loads the history.
 *
 * A row is keyed by merchant and by MCC; each key votes with the categories
 * history filed it under. The merchant key is tried first because it is
 * specific; the MCC ("5812 = restaurants") only when the merchant is unknown
 * or ambiguous.
 */

/** A key's leading category must hold at least this share of its votes. */
export const SUGGESTION_MIN_SHARE = 0.6;

export type Side = 'expense' | 'income';

export interface HistoryRow {
  categoryId: number;
  side: Side;
  payee: string | null;
  description: string;
}

export interface SuggestionInput {
  /** Signed: negative is an expense. */
  amount: number;
  payee: string | null;
  description: string;
}

export type SuggestionSource = 'payee' | 'mcc';

export interface Suggestion {
  categoryId: number | null;
  source: SuggestionSource | null;
}

/**
 * Where a merchant hides in a description when there is no payee, first
 * match wins. BoC card lines ("EE 5812 KADRIORU LOSSIKOHVIK PURCHASE Card…",
 * or without the country/MCC prefix), then LHV card lines as older history
 * stores them ("(..8306) 2023-03-03 19:08 KFC KRISTIINE \ENDLA 45…").
 */
const MERCHANT_PATTERNS = [
  /^[A-Z]{2} \d{4} (.+?) PURCHASE\b/,
  /^(.+?) PURCHASE\b/,
  /^\(\.\.\d{4}\) \d{4}-\d{2}-\d{2} \d{2}:\d{2} ([^\\]+)/,
];

const MCC_PATTERN = /^[A-Z]{2} (\d{4}) /;

/** Upper-cased letters and digits only, so "GOOGLE *YouTube" = "GOOGLE*YOUTUBE". */
export function normalizeKey(text: string): string | null {
  const key = text.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  return key || null;
}

export function categoryKeys(
  payee: string | null,
  description: string
): { merchant: string | null; mcc: string | null } {
  const desc = description.trim();
  let merchant = payee?.trim() ?? '';
  if (!merchant) {
    for (const pattern of MERCHANT_PATTERNS) {
      const m = desc.match(pattern);
      if (m) {
        merchant = m[1];
        break;
      }
    }
  }
  if (!merchant) merchant = desc;
  return { merchant: normalizeKey(merchant), mcc: desc.match(MCC_PATTERN)?.[1] ?? null };
}

/** key → categoryId → number of history rows. */
type Votes = Map<string, Map<number, number>>;

function vote(votes: Votes, key: string, categoryId: number): void {
  let byCategory = votes.get(key);
  if (!byCategory) {
    byCategory = new Map();
    votes.set(key, byCategory);
  }
  byCategory.set(categoryId, (byCategory.get(categoryId) ?? 0) + 1);
}

/**
 * The leading category, if it clears the threshold. No tie-break: two
 * categories tied on count each hold at most half, below the threshold.
 */
function winner(byCategory: Map<number, number> | undefined): number | null {
  if (!byCategory) return null;
  let total = 0;
  let best: number | null = null;
  let bestCount = 0;
  for (const [categoryId, count] of byCategory) {
    total += count;
    if (count > bestCount) {
      best = categoryId;
      bestCount = count;
    }
  }
  return bestCount / total >= SUGGESTION_MIN_SHARE ? best : null;
}

export function suggestCategories(rows: SuggestionInput[], history: HistoryRow[]): Suggestion[] {
  const byMerchant: Votes = new Map();
  const byMcc: Votes = new Map();
  for (const h of history) {
    const keys = categoryKeys(h.payee, h.description);
    if (keys.merchant) vote(byMerchant, `${h.side}|${keys.merchant}`, h.categoryId);
    if (keys.mcc) vote(byMcc, `${h.side}|${keys.mcc}`, h.categoryId);
  }

  return rows.map(row => {
    const side: Side = row.amount < 0 ? 'expense' : 'income';
    const keys = categoryKeys(row.payee, row.description);

    const merchant = keys.merchant ? winner(byMerchant.get(`${side}|${keys.merchant}`)) : null;
    if (merchant !== null) return { categoryId: merchant, source: 'payee' };

    const mcc = keys.mcc ? winner(byMcc.get(`${side}|${keys.mcc}`)) : null;
    if (mcc !== null) return { categoryId: mcc, source: 'mcc' };

    return { categoryId: null, source: null };
  });
}
