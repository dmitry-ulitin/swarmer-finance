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

  it('drops digits, so branches and references of one merchant share a key', () => {
    expect(normalizeKey('PYATEROCHKA 11')).toBe(normalizeKey('PYATEROCHKA 1234'));
    expect(normalizeKey('YANDEX 4121 GO')).toBe('YANDEXGO');
  });

  it('keeps digits when fewer than three letters would be left', () => {
    expect(normalizeKey('A93135218103')).toBe('A93135218103');
    expect(normalizeKey('230724604333')).toBe('230724604333');
  });
});

describe('categoryKeys', () => {
  it('keys the payee and the description separately', () => {
    expect(categoryKeys('Kohvik OU', BOC_CARD)).toEqual({
      payee: 'KOHVIKOU',
      description: 'KADRIORULOSSIKOHVIK',
      mcc: '5812',
    });
  });

  it('extracts the merchant from a BoC card line without an MCC', () => {
    expect(categoryKeys(null, BOC_CARD_NO_MCC)).toEqual({ payee: null, description: 'SECONDCUP', mcc: null });
  });

  it('extracts the merchant from an LHV card line', () => {
    expect(categoryKeys('', LHV_CARD)).toEqual({ payee: null, description: 'KFCKRISTIINE', mcc: null });
  });

  it('falls back to the whole description', () => {
    expect(categoryKeys(null, 'IBU-Maintenance Fees').description).toBe('IBUMAINTENANCEFEES');
  });

  it('gives no payee key for an all-punctuation payee', () => {
    expect(categoryKeys('***', 'anything').payee).toBeNull();
  });

  it('gives no keys for an empty row', () => {
    expect(categoryKeys(null, '')).toEqual({ payee: null, description: null, mcc: null });
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

  it('matches a BoC card line against an LHV card line for the same merchant', () => {
    const [s] = suggestCategories(
      [{ amount: -6, payee: null, description: BOC_CARD }],
      [expense(22, 'KADRIORU LOSSIKOHVIK', '(..8306) 2026-03-03 19:08 KADRIORU LOSSIKOHVIK\\WEIZENBERGI 37')]
    );
    expect(s).toEqual({ categoryId: 22, source: 'description' });
  });

  it('does not match a payee against a description', () => {
    const [s] = suggestCategories(
      [{ amount: -1, payee: null, description: 'Мегафон' }],
      [expense(22, 'Мегафон')]
    );
    expect(s.categoryId).toBeNull();
  });

  it('tries the keys in the given order', () => {
    const row = { amount: -1, payee: 'Переводы', description: 'Наталия У.' };
    const history = [expense(10, 'Переводы', 'Алексей Ч.'), expense(20, 'Переводы', 'Наталия У.')];
    history.push(expense(10, 'Переводы', 'Юрий Щ.'));
    expect(suggestCategories([row], history)[0]).toEqual({ categoryId: 10, source: 'payee' });
    expect(suggestCategories([row], history, ['description', 'payee'])[0]).toEqual({
      categoryId: 20,
      source: 'description',
    });
  });

  it('falls back to the next key when the first is unknown', () => {
    const [s] = suggestCategories(
      [{ amount: -1, payee: 'Накопления', description: 'Выплата проц по деп.№ AVEL9509236I1' }],
      [expense(30, 'Накопления', 'Выплата проц по деп.№ OTHER')],
      ['description', 'payee']
    );
    expect(s).toEqual({ categoryId: 30, source: 'payee' });
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
        expense(22, null, 'KADRIORU LOSSIKOHVIK PURCHASE'),
      ]
    );
    expect(s).toEqual({ categoryId: 22, source: 'description' });
  });

  it('falls back to the MCC when the merchant key is below the threshold', () => {
    const [s] = suggestCategories(
      [{ amount: -6, payee: null, description: BOC_CARD }],
      [
        expense(22, null, 'KADRIORU LOSSIKOHVIK PURCHASE'),
        expense(23, null, 'KADRIORU LOSSIKOHVIK PURCHASE'),
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
