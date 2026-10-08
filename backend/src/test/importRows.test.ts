import * as fs from 'fs';
import * as path from 'path';
import { PROFILES } from '../services/import/profiles';
import { readStatement } from '../services/import/rows';

// Every column the LHV profile reads, including "Account servicer
// reference" — the per-row unique id it identifies rows by. ("Transaction
// reference" is the batch-level one and is deliberately not the identity.)
const LHV_HEADER =
  'Date,Sender/receiver name,Debit/Credit (D/C),Amount,Description,Currency,Transaction reference,Account servicer reference';

const lhvCsv = (...rows: string[]) => [LHV_HEADER, ...rows].join('\n');

const fixture = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p), 'utf8');

describe('readStatement — LHV', () => {
  const result = () => readStatement(fixture('lhv', 'statement.csv'), PROFILES.lhv, 'EUR');

  it('reads every data row', () => {
    expect(result().rows).toHaveLength(143);
  });

  it('refuses a statement with no row in the account currency', () => {
    expect(() => readStatement(fixture('lhv', 'statement.csv'), PROFILES.lhv, 'USD')).toThrow(
      expect.objectContaining({ statusCode: 400, message: 'Statement is in EUR but the account is in USD' })
    );
  });

  it('skips rows in a currency other than the account\'s', () => {
    const csv = lhvCsv(
      '2026-07-01,MERCHANT 001,D,10.00,Description 1,EUR,1400000000,ASR0000001',
      '2026-07-02,MERCHANT 002,D,20.00,Description 2,USD,1400000001,ASR0000002',
      '2026-07-03,MERCHANT 003,D,30.00,Description 3,EUR,1400000002,ASR0000003'
    );
    const { rows } = readStatement(csv, PROFILES.lhv, 'EUR');
    expect(rows.map(r => r.amount)).toEqual([-10, -30]);
    expect(rows.map(r => r.index)).toEqual([0, 1]);
  });

  it('parses the first row, an income', () => {
    const row = result().rows[0];
    expect(row.date).toBe('2026-07-01');
    expect(row.amount).toBe(1305.28);
    expect(row.description).toBe('Description 1');
    expect(row.payee).toBe('MERCHANT 001');
  });

  it('signs debits negative and credits positive', () => {
    const { rows } = result();
    expect(rows.filter(r => r.amount > 0)).toHaveLength(10);
    expect(rows.filter(r => r.amount < 0)).toHaveLength(133);
  });

  it('carries the per-row bank reference for identity', () => {
    // Account servicer reference, not Transaction reference: the latter is
    // shared across a batch of postings and cannot identify a single row.
    expect(result().rows[0].reference).toBe('00000000C375F111BB470A0159F9DEBB');
  });
});

const BOC_PREAMBLE = [
  'Period:,Last 10 Transactions,,,,,,,,',
  'Account number:,100000000000,,,,,,,,',
  'Account name:,ACCOUNT HOLDER,,,,,,,,',
  'Account type:,Sight Account,,,,,,,,',
  'Account currency:,EUR,,,,,,,,',
];
const BOC_HEADER =
  'Date,Description,Transaction type,Reference number,Debit,Credit,Indicative balance,Value date,Bank reference number,Branch code';

const bocCsv = (...rows: string[]) => [...BOC_PREAMBLE, BOC_HEADER, ...rows].join('\n');

describe('readStatement — Bank of Cyprus', () => {
  const result = () => readStatement(fixture('bank_of_cyprus', 'statement.csv'), PROFILES.boc, 'EUR');

  it('skips the preamble and reads the data rows', () => {
    expect(result().rows).toHaveLength(10);
  });

  it('refuses a statement whose preamble currency is not the account\'s', () => {
    expect(() => readStatement(fixture('bank_of_cyprus', 'statement.csv'), PROFILES.boc, 'USD')).toThrow(
      expect.objectContaining({ statusCode: 400, message: 'Statement is in EUR but the account is in USD' })
    );
  });

  it('converts dd/mm/yyyy to ISO', () => {
    expect(result().rows[0].date).toBe('2026-09-21');
  });

  it('reads comma decimals with dot thousands separators', () => {
    // "6,00" in the Debit column -> -6.00
    expect(result().rows[0].amount).toBe(-6);
  });

  it('leaves payee null when the bank has no such column', () => {
    expect(result().rows[0].payee).toBeNull();
  });

  it('drops a row whose Debit and Credit are both blank (an informational/memo line)', () => {
    const csv = bocCsv(
      '21/09/2026,Real purchase,Card Purchase - Foreign,,"6,00",,"39.384,54",21/09/2026,1260000000000FR0000000,0104',
      '20/09/2026,Memo line with no amount,Info,,,,"39.384,54",20/09/2026,1260000000001FR0000000,0104',
      '18/09/2026,Another real purchase,Card Purchase - Foreign,,"7,80",,"39.390,54",18/09/2026,1260000000002FR0000000,0104'
    );
    const { rows } = readStatement(csv, PROFILES.boc, 'EUR');
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.reference)).toEqual([
      '1260000000000FR0000000',
      '1260000000002FR0000000',
    ]);
    // index stays contiguous across the dropped row.
    expect(rows.map(r => r.index)).toEqual([0, 1]);
  });
});

describe('readStatement — LHV direction-column override', () => {
  it('flips a positive amount negative when D/C says D', () => {
    const csv = lhvCsv('2026-07-01,MERCHANT 001,D,1305.28,Description 1,EUR,1400000000,ASR0000001');
    const { rows } = readStatement(csv, PROFILES.lhv, 'EUR');
    expect(rows[0].amount).toBe(-1305.28);
  });

  it('flips a negative amount positive when D/C says C', () => {
    const csv = lhvCsv('2026-07-01,MERCHANT 001,C,-1305.28,Description 1,EUR,1400000000,ASR0000002');
    const { rows } = readStatement(csv, PROFILES.lhv, 'EUR');
    expect(rows[0].amount).toBe(1305.28);
  });

  it('preserves the amount sign as-is when no directionColumn is declared', () => {
    const profile = { ...PROFILES.lhv, amount: { kind: 'signed' as const, column: 'Amount' } };
    const csv = lhvCsv('2026-07-01,MERCHANT 001,D,-1305.28,Description 1,EUR,1400000000,ASR0000003');
    const { rows } = readStatement(csv, profile, 'EUR');
    expect(rows[0].amount).toBe(-1305.28);
  });
});

describe('readStatement — LHV in Russian', () => {
  const result = () => readStatement(fixture('lhv', 'statement_ru.csv'), PROFILES.lhv, 'USD');

  it('reads the rows through the Russian headers', () => {
    const { rows } = result();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      index: 1,
      date: '2025-04-17',
      amount: -10000,
      description: 'Description 1',
      payee: 'MERCHANT 001',
      reference: '00000001651BF011B464001DD8D11D14',
    });
  });
});

describe('readStatement — LHV in Estonian', () => {
  const result = () => readStatement(fixture('lhv', 'statement_et.csv'), PROFILES.lhv, 'EUR');

  it('reads the rows through the Estonian headers', () => {
    const { rows } = result();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      index: 1,
      date: '2026-09-02',
      amount: -96,
      description: 'Description 2',
      payee: 'MERCHANT 002',
      reference: '00000001AA11F111BB470A0159F9DEBB',
    });
  });
});

describe('readStatement — Alfa-Bank', () => {
  const result = () => readStatement(fixture('alfabank', 'statement.csv'), PROFILES.alfa, 'RUB');

  it('reads RUR rows into a RUB account, skipping the gold (A98) row', () => {
    expect(result().rows.map(r => r.amount)).toEqual([-600, 3940.49, -2120.5, -218261.52, -95.52, -95.52]);
  });

  it('drops moves between the customer\'s own accounts, pairing each row once', () => {
    const descriptions = result().rows.map(r => r.description);
    expect(descriptions).not.toContain('Между своими счетами');
    expect(descriptions).not.toContain('Уменьшение суммы депозита DEP0000001');
  });

  it('keeps two identical payments from one account', () => {
    expect(result().rows.filter(r => r.description === 'MERCHANT 003')).toHaveLength(2);
  });

  it('reads dd.mm.yyyy operation dates, the bank category as payee, and indexes contiguously', () => {
    const { rows } = result();
    expect(rows[2]).toEqual({
      index: 2,
      date: '2026-09-25',
      amount: -2120.5,
      description: 'MERCHANT 002\\CITY RU',
      payee: 'Коммунальные услуги',
      reference: null,
    });
    expect(rows.map(r => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('readStatement — CaixaBank (Excel)', () => {
  const bytes = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', 'caixabank', 'statement.xls'));
  const result = () => readStatement(bytes(), PROFILES.caixa, 'EUR');

  it('reads the data rows past the two-line preamble', () => {
    expect(result().rows.map(r => r.amount)).toEqual([-306, -36, -53.31, -23.3, 1250.5]);
  });

  it('turns Excel date serials into ISO dates', () => {
    expect(result().rows.map(r => r.date)).toEqual([
      '2026-09-01', '2026-05-12', '2025-12-31', '2025-12-31', '2025-12-19',
    ]);
  });

  it('reads "Transaction" as payee and "More data" as description', () => {
    expect(result().rows[0]).toMatchObject({ payee: 'MERCHANT 001', description: 'Description 1' });
    expect(result().rows[1]).toMatchObject({ payee: 'MERCHANT 002', description: '' });
  });

  it('reads the currency from "Amounts expressed in euros"', () => {
    expect(() => readStatement(bytes(), PROFILES.caixa, 'USD')).toThrow(
      expect.objectContaining({ statusCode: 400, message: 'Statement is in EUR but the account is in USD' })
    );
  });
});
