import * as fs from 'fs';
import * as path from 'path';
import { PROFILES } from '../services/import/profiles';
import { readStatement } from '../services/import/rows';

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
});
