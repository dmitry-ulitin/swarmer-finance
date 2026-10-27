import { createHash } from 'crypto';
import { EbTransaction } from '../services/bank/client';
import { computeBankHashes, toParsedRows } from '../services/bank/rows';
import { hashRows } from '../services/import/hash';

const tx = (o: Partial<EbTransaction> = {}): EbTransaction => ({
  transaction_amount: { amount: '12.30', currency: 'EUR' },
  credit_debit_indicator: 'DBIT',
  status: 'BOOK',
  booking_date: '2026-10-12',
  ...o,
});
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hashBase = (r: { date: string; amount: number; description: string; payee: string | null }) =>
  ['eb|EE|LHV Pank', r.date, r.amount.toFixed(2), r.description.toLowerCase(), (r.payee ?? '').toLowerCase()].join('|');
const aspsp = { name: 'LHV Pank', country: 'EE' };

describe('toParsedRows', () => {
  it('maps a DBIT card row', () => {
    const rows = toParsedRows(
      [tx({ remittance_information: ['(..7101) 2026-10-11 KFC', 'TALLINN'] })],
      'EUR'
    );
    expect(rows).toEqual([
      { index: 0, date: '2026-10-12', amount: -12.3, description: '(..7101) 2026-10-11 KFC TALLINN', payee: null, reference: null },
    ]);
  });

  it('takes the payee from the counterparty side', () => {
    const [d, c] = toParsedRows(
      [
        tx({ creditor: { name: 'Elektrilevi' }, debtor: { name: 'Me' } }),
        tx({ credit_debit_indicator: 'CRDT', debtor: { name: 'Employer OÜ' }, creditor: { name: 'Me' } }),
      ],
      'EUR'
    );
    expect(d.payee).toBe('Elektrilevi');
    expect(c.payee).toBe('Employer OÜ');
    expect(c.amount).toBe(12.3);
  });

  it('falls back from booking_date to value_date then transaction_date', () => {
    const rows = toParsedRows(
      [
        tx({ booking_date: null, value_date: '2026-10-10', transaction_date: '2026-10-09' }),
        tx({ booking_date: null, value_date: null, transaction_date: '2026-10-09' }),
      ],
      'EUR'
    );
    expect(rows.map(r => r.date)).toEqual(['2026-10-10', '2026-10-09']);
  });

  it('drops PDNG rows and other currencies', () => {
    const rows = toParsedRows(
      [
        tx(),
        tx({ transaction_amount: { amount: '5.00', currency: 'USD' } }),
        tx({ status: 'PDNG' }),
      ],
      'USD'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].index).toBe(0);
    expect(rows[0].amount).toBe(-5);
  });

  describe('unreadable booked rows', () => {
    const bad = { statusCode: 502, message: 'Bank returned an unreadable transaction' };
    const cases: [string, Partial<EbTransaction>][] = [
      ['missing date', { booking_date: null, value_date: null, transaction_date: null }],
      ['datetime date', { booking_date: '2026-10-12T10:00:00Z' }],
      ['empty amount', { transaction_amount: { amount: '', currency: 'EUR' } }],
      ['non-numeric amount', { transaction_amount: { amount: 'abc', currency: 'EUR' } }],
      ['unknown indicator', { credit_debit_indicator: 'XXXX' as never }],
    ];
    it.each(cases)('rejects %s', (_n, o) => {
      expect(() => toParsedRows([tx(o)], 'EUR')).toThrow(expect.objectContaining(bad));
    });

    it('skips a PDNG row with a missing date', () => {
      expect(toParsedRows([tx({ status: 'PDNG', booking_date: null })], 'EUR')).toEqual([]);
    });
  });

  it('drops zero amounts and keeps index contiguous', () => {
    const rows = toParsedRows(
      [tx({ transaction_amount: { amount: '0.00', currency: 'EUR' } }), tx()],
      'EUR'
    );
    expect(rows.map(r => r.index)).toEqual([0]);
  });
});

describe('computeBankHashes', () => {
  it('hashes by entry_reference', () => {
    const rows = toParsedRows([tx({ entry_reference: 'ref-1' })], 'EUR');
    expect(computeBankHashes(rows, aspsp)).toEqual([sha('eb|EE|LHV Pank|ref-1')]);
  });

  it('uses transaction_id when there is no entry_reference', () => {
    const rows = toParsedRows([tx({ transaction_id: 'tid-9' })], 'EUR');
    expect(computeBankHashes(rows, aspsp)).toEqual([sha('eb|EE|LHV Pank|tid-9')]);
  });

  it('falls back to content with an occurrence index', () => {
    const rows = toParsedRows([tx(), tx()], 'EUR');
    const [a, b] = computeBankHashes(rows, aspsp);
    expect(a).not.toBe(b);
    expect(a).toBe(hashRows([rows[0]], 'eb|EE|LHV Pank', true)[0]);
    expect(b).toBe(sha(`${hashBase(rows[0])}|1`));
  });
});
