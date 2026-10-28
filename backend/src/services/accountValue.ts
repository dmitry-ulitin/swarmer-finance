export interface AccountValueInput {
  startBalance: number;
  /** Day the account's history begins; null means no cutoff. */
  startDate: string | null;
  /** Ascending by date. */
  flows: { date: string; delta: number }[];
  /** Ascending by as_of. */
  valuations: { as_of: string; value: number }[];
}

/** First transaction date, else the day the account was created (UTC). */
export function accountStartDate(firstFlowDate: string | null, createdAt: Date): string {
  return firstFlowDate ?? createdAt.toISOString().slice(0, 10);
}

/**
 * Value of an account on `date` (null = now, counting every flow including
 * future-dated ones): the latest valuation on or before the date plus the
 * flows after it; without one, the invested amount. `invested` is the
 * opening balance plus flows up to the date, 0 before the account began.
 */
export function accountValueAt(input: AccountValueInput, date: string | null): { value: number; invested: number } {
  const upTo = (d: string) => date === null || d <= date;
  const flowsUpTo = input.flows.filter(f => upTo(f.date));
  const invested = date !== null && input.startDate !== null && date < input.startDate
    ? 0
    : input.startBalance + flowsUpTo.reduce((sum, f) => sum + f.delta, 0);
  const valuation = input.valuations.filter(v => upTo(v.as_of)).at(-1);
  if (!valuation) return { value: invested, invested };
  const after = flowsUpTo.filter(f => f.date > valuation.as_of).reduce((sum, f) => sum + f.delta, 0);
  return { value: valuation.value + after, invested };
}
