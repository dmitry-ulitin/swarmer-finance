import { describe, it, expect } from 'vitest';
import { describeImport } from './import-summary';

// describeImport lives in its own module so this spec never loads
// import-dialog.service.ts, which injects TransactionsState and
// AccountsState and through them the HTTP stack. Pulling that graph into a
// test module destabilises the HTTP-facing specs in other files — the same
// reason transaction-dialog.service.spec.ts tests buildCreateDefaults rather
// than the service itself.
describe('describeImport', () => {
  it('reports the created count', () => {
    expect(describeImport({ created: 3, skipped: 0 })).toBe('3 transactions imported');
  });

  it('uses the singular for one transaction', () => {
    expect(describeImport({ created: 1, skipped: 0 })).toBe('1 transaction imported');
  });

  it('mentions rows that were already present', () => {
    expect(describeImport({ created: 2, skipped: 5 })).toBe(
      '2 transactions imported, 5 already present'
    );
  });

  it('stays silent about skipped rows when there were none', () => {
    expect(describeImport({ created: 4, skipped: 0 })).not.toContain('already present');
  });

  it('handles an import where everything was already present', () => {
    // Re-importing the same statement is the case the whole feature exists to
    // make safe: nothing is created, and the message has to say so.
    expect(describeImport({ created: 0, skipped: 143 })).toBe(
      '0 transactions imported, 143 already present'
    );
  });
});
