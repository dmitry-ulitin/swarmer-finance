import {
  HistoryRow,
  categoryKeys,
  normalizeKey,
  suggestCategories,
} from '../services/import/categorize';

const BOC_CARD =
  'EE 5812 KADRIORU LOSSIKOHVIK PURCHASE Card 4***2037 2026-09-19 6.00 EUR Auth 339449 Trace 599652';
const BOC_CARD_NO_MCC =
  'SECOND CUP PURCHASE CY Card 4***2037 2026-07-08 11.55 EUR Auth 362898 Trace 838125';
const LHV_CARD =
  '(..8306) 2023-03-03 19:08 KFC KRISTIINE \\ENDLA 45 \\TALLINN \\10615 ESTEST';

const expense = (categoryId: number, payee: string | null, description = ''): HistoryRow =>
  ({ categoryId, side: 'expense', payee, description });
const income = (categoryId: number, payee: string | null, description = ''): HistoryRow =>
  ({ categoryId, side: 'income', payee, description });

describe('normalizeKey', () => {
  it('ignores case, spaces and punctuation', () => {
    expect(normalizeKey('GOOGLE*YOUTUBEPREMIUM')).toBe(normalizeKey('GOOGLE *YouTubePremium'));
  });

  it('keeps Cyrillic letters', () => {
    expect(normalizeKey('Прочие расходы')).toBe('ПРОЧИЕРАСХОДЫ');
  });

  it('returns null when nothing but punctuation is left', () => {
    expect(normalizeKey(' *-* ')).toBeNull();
  });
});

describe('categoryKeys', () => {
  it('takes the payee when there is one, even if the description also matches a pattern', () => {
    expect(categoryKeys('Kohvik OU', BOC_CARD).merchant).toBe('KOHVIKOU');
  });

  it('extracts the merchant from a BoC card line with an MCC', () => {
    expect(categoryKeys(null, BOC_CARD)).toEqual({ merchant: 'KADRIORULOSSIKOHVIK', mcc: '5812' });
  });

  it('extracts the merchant from a BoC card line without an MCC', () => {
    expect(categoryKeys(null, BOC_CARD_NO_MCC)).toEqual({ merchant: 'SECONDCUP', mcc: null });
  });

  it('extracts the merchant from an LHV card line', () => {
    expect(categoryKeys('', LHV_CARD)).toEqual({ merchant: 'KFCKRISTIINE', mcc: null });
  });

  it('falls back to the whole description', () => {
    expect(categoryKeys(null, 'IBU-Maintenance Fees').merchant).toBe('IBUMAINTENANCEFEES');
  });

  it('gives no merchant key for an all-punctuation payee', () => {
    expect(categoryKeys('***', 'anything').merchant).toBeNull();
  });

  it('gives no merchant key for an empty row', () => {
    expect(categoryKeys(null, '')).toEqual({ merchant: null, mcc: null });
  });
});

describe('suggestCategories', () => {
  it('suggests the only category a merchant was ever filed under', () => {
    const [s] = suggestCategories(
      [{ amount: -5, payee: 'MERCADONA CALAHONDA', description: '' }],
      [expense(10, 'Mercadona Calahonda')]
    );
    expect(s).toEqual({ categoryId: 10, source: 'payee' });
  });

  it('matches a BoC description against an LHV payee for the same merchant', () => {
    const [s] = suggestCategories(
      [{ amount: -6, payee: null, description: BOC_CARD }],
      [expense(22, 'KADRIORU LOSSIKOHVIK')]
    );
    expect(s).toEqual({ categoryId: 22, source: 'payee' });
  });

  it('suggests at exactly the 0.6 threshold', () => {
    const history = [10, 10, 10, 11, 11].map(id => expense(id, 'PORT DESINA'));
    const [s] = suggestCategories([{ amount: -1, payee: 'PORT DESINA', description: '' }], history);
    expect(s.categoryId).toBe(10);
  });

  it('does not suggest for a key split below the threshold', () => {
    const history = [10, 10, 11, 12, 13].map(id => expense(id, 'Прочие расходы'));
    const [s] = suggestCategories([{ amount: -1, payee: 'Прочие расходы', description: '' }], history);
    expect(s).toEqual({ categoryId: null, source: null });
  });

  it('never uses expense history for an income row', () => {
    const [s] = suggestCategories(
      [{ amount: 100, payee: 'ACME', description: '' }],
      [expense(10, 'ACME')]
    );
    expect(s.categoryId).toBeNull();
  });

  it('uses income history for an income row', () => {
    const [s] = suggestCategories(
      [{ amount: 100, payee: 'ACME', description: '' }],
      [expense(10, 'ACME'), income(20, 'ACME')]
    );
    expect(s.categoryId).toBe(20);
  });

  it('falls back to the MCC when the merchant is unknown', () => {
    const [s] = suggestCategories(
      [{ amount: -6, payee: null, description: BOC_CARD }],
      [expense(30, null, 'EE 5812 OTHER CAFE PURCHASE Card 4***2037 2026-01-01 3.00 EUR')]
    );
    expect(s).toEqual({ categoryId: 30, source: 'mcc' });
  });

  it('prefers the merchant over the MCC when both match', () => {
    const [s] = suggestCategories(
      [{ amount: -6, payee: null, description: BOC_CARD }],
      [
        expense(30, null, 'EE 5812 OTHER CAFE PURCHASE Card 4***2037 2026-01-01 3.00 EUR'),
        expense(22, 'KADRIORU LOSSIKOHVIK'),
      ]
    );
    expect(s).toEqual({ categoryId: 22, source: 'payee' });
  });

  it('falls back to the MCC when the merchant key is below the threshold', () => {
    const [s] = suggestCategories(
      [{ amount: -6, payee: null, description: BOC_CARD }],
      [
        expense(22, 'KADRIORU LOSSIKOHVIK'),
        expense(23, 'KADRIORU LOSSIKOHVIK'),
        expense(30, null, 'EE 5812 OTHER CAFE PURCHASE Card 4***2037 2026-01-01 3.00 EUR'),
      ]
    );
    expect(s).toEqual({ categoryId: 30, source: 'mcc' });
  });

  it('returns one result per row, in order', () => {
    const result = suggestCategories(
      [
        { amount: -1, payee: 'A', description: '' },
        { amount: -1, payee: 'UNKNOWN', description: '' },
        { amount: -1, payee: 'B', description: '' },
      ],
      [expense(1, 'A'), expense(2, 'B')]
    );
    expect(result.map(s => s.categoryId)).toEqual([1, null, 2]);
  });
});
