import * as fs from 'fs';
import * as path from 'path';
import { PROFILES, Profile } from '../services/import/profiles';
import { readStatement, ParsedRow } from '../services/import/rows';
import { computeImportHashes } from '../services/import/hash';

const fixture = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p), 'utf8');

const contentProfile: Profile = { ...PROFILES.lhv, identity: { kind: 'content' } };

describe('computeImportHashes', () => {
  it('gives every row a distinct hash even when the bank reuses a reference', () => {
    // LHV reuses "Transaction reference" across every posting in one batch:
    // interest and its tax share one, and a term deposit's close, interest
    // and tax share another. Identifying rows by that column collapsed seven
    // real transactions into three hashes on a live statement — four rows,
    // including a 100,000 EUR deposit close, were silently dropped on import.
    // "Account servicer reference" is unique per row, which is why the
    // profile uses it.
    const { rows } = readStatement(fixture('lhv', 'statement.csv'), PROFILES.lhv);
    const hashes = computeImportHashes(rows, PROFILES.lhv);

    expect(new Set(hashes).size).toBe(rows.length);
  });

  it('would collapse rows if identity used the batch-level reference', () => {
    // Guards the reason for the column choice above: this is the same file
    // read through a profile that identifies rows the way the original one
    // did, and it must NOT produce a distinct hash per row.
    const batchRefProfile: Profile = {
      ...PROFILES.lhv,
      identity: { kind: 'reference', columns: ['Transaction reference'] },
    };
    const { rows } = readStatement(fixture('lhv', 'statement.csv'), batchRefProfile);
    const hashes = computeImportHashes(rows, batchRefProfile);

    expect(new Set(hashes).size).toBeLessThan(rows.length);
  });

  it('is stable across runs over the same file', () => {
    const { rows } = readStatement(fixture('lhv', 'statement.csv'), PROFILES.lhv);
    expect(computeImportHashes(rows, PROFILES.lhv))
      .toEqual(computeImportHashes(rows, PROFILES.lhv));
  });

  it('gives every LHV row a distinct hash, via its bank reference', () => {
    const { rows } = readStatement(fixture('lhv', 'statement.csv'), PROFILES.lhv);
    const hashes = computeImportHashes(rows, PROFILES.lhv);
    expect(new Set(hashes).size).toBe(143);
  });

  it('distinguishes identical rows by occurrence when hashing content', () => {
    // The fixture holds four rows booked 2026-07-29 at -10.00 that are
    // identical in every field the file exposes. A content hash must still
    // tell them apart, or a re-import would collapse four charges into one.
    const { rows } = readStatement(fixture('lhv', 'statement.csv'), contentProfile);
    const hashes = computeImportHashes(rows, contentProfile);
    expect(new Set(hashes).size).toBe(rows.length);
  });

  it('matches the same content row across two parses of the same file', () => {
    const a = readStatement(fixture('lhv', 'statement.csv'), contentProfile);
    const b = readStatement(fixture('lhv', 'statement.csv'), contentProfile);
    expect(computeImportHashes(a.rows, contentProfile))
      .toEqual(computeImportHashes(b.rows, contentProfile));
  });

  it('separates rows that differ only in amount', () => {
    const rows: ParsedRow[] = [
      { index: 0, date: '2026-07-01', amount: -5, description: 'x', payee: null, reference: null },
      { index: 1, date: '2026-07-01', amount: -6, description: 'x', payee: null, reference: null },
    ];
    const [h1, h2] = computeImportHashes(rows, contentProfile);
    expect(h1).not.toBe(h2);
  });

  it('separates identical content under different profiles', () => {
    const rows: ParsedRow[] = [
      { index: 0, date: '2026-07-01', amount: -5, description: 'x', payee: null, reference: null },
    ];
    const other: Profile = { ...contentProfile, id: 'boc' };
    expect(computeImportHashes(rows, contentProfile)[0])
      .not.toBe(computeImportHashes(rows, other)[0]);
  });
});
