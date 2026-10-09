/**
 * Category suggestions for imported rows, learned from the user's own
 * categorised history. Pure: the caller loads the history.
 *
 * A row is keyed by payee, by description (the merchant in it, when a known
 * pattern finds one) and by MCC; each key votes, separately, with the
 * categories history filed it under. The keys are tried in a per-bank order
 * and the first one with a clear winner decides: usually the payee first,
 * as the most specific, and the MCC ("5812 = restaurants") last.
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

export type KeyField = 'payee' | 'description' | 'mcc';

export const DEFAULT_KEY_ORDER: KeyField[] = ['payee', 'description', 'mcc'];

export type SuggestionSource = KeyField;

export interface Suggestion {
  categoryId: number | null;
  source: SuggestionSource | null;
}

/**
 * Where a merchant hides in a description, first
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

/** Fewer letters than this and the digits are the identity, e.g. a tax id. */
const MIN_KEY_LETTERS = 3;

/**
 * Upper-cased letters only, so "GOOGLE *YouTube" = "GOOGLE*YOUTUBE" and
 * "PYATEROCHKA 11" = "PYATEROCHKA 1234". Digits stay when too few letters
 * would be left without them ("A93135218103").
 */
export function normalizeKey(text: string): string | null {
  const key = text.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  const letters = key.replace(/\p{N}/gu, '');
  return (letters.length >= MIN_KEY_LETTERS ? letters : key) || null;
}

export function categoryKeys(payee: string | null, description: string): Record<KeyField, string | null> {
  const desc = description.trim();
  let merchant = desc;
  for (const pattern of MERCHANT_PATTERNS) {
    const m = desc.match(pattern);
    if (m) {
      merchant = m[1];
      break;
    }
  }
  return {
    payee: payee ? normalizeKey(payee) : null,
    description: normalizeKey(merchant),
    mcc: desc.match(MCC_PATTERN)?.[1] ?? null,
  };
}

/** field|side|key → categoryId → number of history rows. */
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

export function suggestCategories(
  rows: SuggestionInput[],
  history: HistoryRow[],
  order: KeyField[] = DEFAULT_KEY_ORDER
): Suggestion[] {
  const votes: Votes = new Map();
  for (const h of history) {
    const keys = categoryKeys(h.payee, h.description);
    for (const field of order) {
      if (keys[field]) vote(votes, `${field}|${h.side}|${keys[field]}`, h.categoryId);
    }
  }

  return rows.map(row => {
    const side: Side = row.amount < 0 ? 'expense' : 'income';
    const keys = categoryKeys(row.payee, row.description);
    for (const field of order) {
      const categoryId = keys[field] ? winner(votes.get(`${field}|${side}|${keys[field]}`)) : null;
      if (categoryId !== null) return { categoryId, source: field };
    }
    return { categoryId: null, source: null };
  });
}
