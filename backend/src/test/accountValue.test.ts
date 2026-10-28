import { accountValueAt, accountStartDate } from '../services/accountValue';

describe('accountValueAt', () => {
  const base = { startBalance: 100, startDate: '2026-01-01', flows: [] as { date: string; delta: number }[], valuations: [] as { as_of: string; value: number }[] };

  it('without valuations value equals invested', () => {
    const input = { ...base, flows: [{ date: '2026-02-01', delta: 50 }, { date: '2026-02-05', delta: -20 }] };
    expect(accountValueAt(input, null)).toEqual({ value: 130, invested: 130 });
  });

  it('adds flows after the latest valuation', () => {
    const input = {
      ...base,
      flows: [{ date: '2026-03-31', delta: 100 }, { date: '2026-04-10', delta: 200 }],
      valuations: [{ as_of: '2026-03-31', value: 500 }],
    };
    expect(accountValueAt(input, '2026-04-30')).toEqual({ value: 700, invested: 400 });
  });

  it('before the valuation value equals invested', () => {
    const input = {
      ...base,
      flows: [{ date: '2026-03-31', delta: 100 }],
      valuations: [{ as_of: '2026-03-31', value: 500 }],
    };
    expect(accountValueAt(input, '2026-03-15')).toEqual({ value: 100, invested: 100 });
  });

  it('is zero before the start date unless a valuation exists', () => {
    expect(accountValueAt(base, '2025-12-31')).toEqual({ value: 0, invested: 0 });
    const valued = { ...base, valuations: [{ as_of: '2025-12-30', value: 40 }] };
    expect(accountValueAt(valued, '2025-12-31')).toEqual({ value: 40, invested: 0 });
  });

  it('null date includes future-dated flows', () => {
    const input = { ...base, flows: [{ date: '2099-01-01', delta: 5 }] };
    expect(accountValueAt(input, null)).toEqual({ value: 105, invested: 105 });
  });
});

describe('accountStartDate', () => {
  it('prefers the first flow, else the creation day in UTC', () => {
    expect(accountStartDate('2026-02-03', new Date('2026-05-01T00:00:00Z'))).toBe('2026-02-03');
    expect(accountStartDate(null, new Date('2026-05-01T23:30:00Z'))).toBe('2026-05-01');
  });
});
