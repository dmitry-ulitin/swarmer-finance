import { createHash } from 'crypto';
import { Profile } from './profiles';
import { ParsedRow } from './rows';

const sha256 = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

/** Collapses whitespace so trivial spacing changes do not break a match. */
const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * One hash per row, positionally aligned with `rows`.
 *
 * Where the bank publishes a reference, that alone identifies the row: it
 * survives the bank rewording a description. Where it does not, the row's
 * own content identifies it — plus an occurrence index, because a content
 * hash otherwise cannot tell two genuinely identical charges apart, and real
 * statements contain them.
 */
export function hashRows(rows: ParsedRow[], namespace: string, useReference: boolean): string[] {
  const seen = new Map<string, number>();

  return rows.map(row => {
    if (useReference && row.reference) {
      return sha256(`${namespace}|${row.reference}`);
    }
    const base = [
      namespace,
      row.date,
      row.amount.toFixed(2),
      normalize(row.description),
      normalize(row.payee ?? ''),
    ].join('|');
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return sha256(`${base}|${occurrence}`);
  });
}

export function computeImportHashes(rows: ParsedRow[], profile: Profile): string[] {
  return hashRows(rows, profile.id, profile.identity.kind === 'reference');
}
