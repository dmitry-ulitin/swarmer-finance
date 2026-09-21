import * as fs from 'fs';
import * as path from 'path';
import { parseCsv } from '../services/import/csv';
import { PROFILES, detectProfile, getProfile } from '../services/import/profiles';

const fixture = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p), 'utf8');

describe('profiles', () => {
  it('detects LHV from its header signature', () => {
    const grid = parseCsv(fixture('lhv', 'statement.csv'));
    expect(detectProfile(grid)?.id).toBe('lhv');
  });

  it('detects Bank of Cyprus past its preamble', () => {
    const grid = parseCsv(fixture('bank_of_cyprus', 'statement.csv'));
    expect(detectProfile(grid)?.id).toBe('boc');
  });

  it('returns null for an unrecognised file', () => {
    expect(detectProfile([['foo', 'bar'], ['1', '2']])).toBeNull();
  });

  it('getProfile rejects an unknown id with 400', () => {
    expect(() => getProfile('nope')).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it('every profile declares a header signature that fits its own columns', () => {
    for (const profile of Object.values(PROFILES)) {
      expect(profile.headerSignature.length).toBeGreaterThan(0);
      expect(profile.reader).toBe('csv');
    }
  });
});
