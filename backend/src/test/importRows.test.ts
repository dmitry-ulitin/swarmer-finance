import * as fs from 'fs';
import * as path from 'path';
import { PROFILES } from '../services/import/profiles';
import { readStatement } from '../services/import/rows';

const LHV_HEADER =
  'Date,Sender/receiver name,Debit/Credit (D/C),Amount,Description,Currency,Transaction reference';

const lhvCsv = (...rows: string[]) => [LHV_HEADER, ...rows].join('\n');

const fixture = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p), 'utf8');

describe('readStatement — LHV', () => {
  const result = () => readStatement(fixture('lhv', 'statement.csv'), PROFILES.lhv);

  it('reads every data row', () => {
    expect(result().rows).toHaveLength(143);
  });

  it('reads the currency from the per-row column', () => {
    expect(result().currency).toBe('EUR');
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

  it('carries the bank reference for identity', () => {
    expect(result().rows[0].reference).toBe('1400000000');
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
  const result = () => readStatement(fixture('bank_of_cyprus', 'statement.csv'), PROFILES.boc);

  it('skips the preamble and reads the data rows', () => {
    expect(result().rows).toHaveLength(10);
  });

  it('reads the currency from the preamble', () => {
    expect(result().currency).toBe('EUR');
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
    const { rows } = readStatement(csv, PROFILES.boc);
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
    const csv = lhvCsv('2026-07-01,MERCHANT 001,D,1305.28,Description 1,EUR,1400000000');
    const { rows } = readStatement(csv, PROFILES.lhv);
    expect(rows[0].amount).toBe(-1305.28);
  });

  it('flips a negative amount positive when D/C says C', () => {
    const csv = lhvCsv('2026-07-01,MERCHANT 001,C,-1305.28,Description 1,EUR,1400000000');
    const { rows } = readStatement(csv, PROFILES.lhv);
    expect(rows[0].amount).toBe(1305.28);
  });

  it('preserves the amount sign as-is when no directionColumn is declared', () => {
    const profile = { ...PROFILES.lhv, amount: { kind: 'signed' as const, column: 'Amount' } };
    const csv = lhvCsv('2026-07-01,MERCHANT 001,D,-1305.28,Description 1,EUR,1400000000');
    const { rows } = readStatement(csv, profile);
    expect(rows[0].amount).toBe(-1305.28);
  });
});
