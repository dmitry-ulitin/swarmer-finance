import * as accountQueries from '../db/queries/accounts';
import * as userQueries from '../db/queries/users';
import { getAccountDailyFlows } from '../db/queries/transactions';
import { listValuations } from '../db/queries/valuations';
import { getNetWorthFlags } from '../db/queries/accountUserSettings';
import { accountStartDate, accountValueAt, AccountValueInput } from './accountValue';
import { getAccessMap } from './access';
import { isInNetWorth } from './accounts';
import { convertAmount, getRatesOn, getRatesTo, toDecimal } from './currency';
import { todayUtc } from './date';
import { Account, AccountType } from '../types';

const ACCOUNT_TYPES: AccountType[] = ['cash', 'bank', 'crypto', 'investment', 'property', 'deposit', 'debt'];

export interface NetWorthDto {
  currency: string;
  total: number;
  approximate: boolean;
  byType: { type: AccountType; value: number }[];
  byCurrency: { currency: string; value: number }[];
  accounts: {
    id: number; name: string; type: AccountType; currency: string;
    value: number; valueUser: number | null; invested: number; gain: number; gainPct: number | null;
    inNetWorth: boolean;
  }[];
  history: { date: string; total: number; byType: Record<AccountType, number>; approximate: boolean }[];
}

/** Last day of every month from the one holding `from` up to the month before `today`'s. */
function monthEnds(from: string, today: string): string[] {
  const ends: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const stop = today.slice(0, 7);
  for (;;) {
    if (`${year}-${String(month).padStart(2, '0')}` >= stop) return ends;
    ends.push(new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10));
    if (++month > 12) { month = 1; year++; }
  }
}

const emptyByType = () => Object.fromEntries(ACCOUNT_TYPES.map(t => [t, 0])) as Record<AccountType, number>;

export const getNetWorth = async (userId: number): Promise<NetWorthDto> => {
  const user = await userQueries.getUserById(userId);
  if (!user) throw { statusCode: 401, message: 'User not found' };
  const target = user.currency;
  const userScale = user.currency_scale;
  const today = todayUtc();

  const accessMap = await getAccessMap(userId);
  const accounts: Account[] = await accountQueries.getAccountsByIds([...accessMap.keys()]);
  const ids = accounts.map(a => a.id);
  const [flags, valuations, flows] = await Promise.all([
    getNetWorthFlags(userId, ids), listValuations(ids), getAccountDailyFlows(ids),
  ]);

  const inputs = new Map<number, AccountValueInput>();
  for (const account of accounts) {
    const own = flows.filter(f => f.account_id === account.id);
    inputs.set(account.id, {
      startBalance: Number(account.start_balance),
      startDate: accountStartDate(own[0]?.date ?? null, account.created_at),
      flows: own,
      valuations: valuations.filter(v => v.account_id === account.id).map(v => ({ as_of: v.as_of, value: Number(v.value) })),
    });
  }
  const selectedOf = (a: Account) => isInNetWorth(flags.get(a.id), accessMap.get(a.id)!);
  const visible = accounts.filter(a => !a.deleted);
  const selected = accounts.filter(selectedOf);

  // Today: the same value and rate as the accounts list, so the totals agree.
  const todayRates = await getRatesTo(target, visible.map(a => a.currency));
  const rows = visible.map(account => {
    const { value, invested } = accountValueAt(inputs.get(account.id)!, null);
    const valueUser = convertAmount(value, account.scale, todayRates.get(account.currency) ?? null, userScale);
    return { account, value, invested, valueUser, inNetWorth: selectedOf(account) };
  });

  let total = 0;
  let approximate = false;
  const byType = new Map<AccountType, number>();
  const byCurrency = new Map<string, number>();
  for (const row of rows.filter(r => r.inNetWorth)) {
    if (row.valueUser === null) { approximate = true; continue; }
    total += row.valueUser;
    byType.set(row.account.type, (byType.get(row.account.type) ?? 0) + row.valueUser);
    byCurrency.set(row.account.currency, (byCurrency.get(row.account.currency) ?? 0) + row.valueUser);
  }

  // Past month-ends, then today.
  const starts = selected.flatMap(a => [inputs.get(a.id)!.startDate!, ...inputs.get(a.id)!.valuations.map(v => v.as_of)]);
  const dates = starts.length ? monthEnds(starts.sort()[0], today) : [];
  // A deleted account was emptied before it was deleted: it adds nothing
  // after its last flow or valuation, whatever a stale valuation says.
  const closedAfter = (a: Account): string | null => {
    if (!a.deleted) return null;
    const input = inputs.get(a.id)!;
    return [input.flows.at(-1)?.date, input.valuations.at(-1)?.as_of].filter(Boolean).sort().at(-1) ?? null;
  };
  const values = new Map<string, number>(); // `${account}|${date}`, non-zero only
  const datesOf = new Map<string, Set<string>>(); // currency -> dates needing a rate
  for (const account of selected) {
    const closed = closedAfter(account);
    for (const date of dates) {
      if (closed !== null && date > closed) continue;
      const { value } = accountValueAt(inputs.get(account.id)!, date);
      if (value === 0) continue;
      values.set(`${account.id}|${date}`, value);
      if (!datesOf.has(account.currency)) datesOf.set(account.currency, new Set());
      datesOf.get(account.currency)!.add(date);
    }
  }
  const pastRates = new Map<string, Map<string, { rate: number; approximate: boolean } | null>>();
  for (const [currency, set] of datesOf) {
    const got = await getRatesOn(target, [currency], [...set]);
    pastRates.set(currency, got.get(currency)!);
  }
  const history: NetWorthDto['history'] = dates.map(date => {
    const point = { total: 0, byType: emptyByType(), approximate: false };
    for (const account of selected) {
      const value = values.get(`${account.id}|${date}`);
      if (value === undefined) continue;
      const rate = pastRates.get(account.currency)?.get(date) ?? null;
      if (!rate) { point.approximate = true; continue; }
      if (rate.approximate) point.approximate = true;
      const converted = convertAmount(value, account.scale, rate.rate, userScale)!;
      point.total += converted;
      point.byType[account.type] += converted;
    }
    return {
      date, approximate: point.approximate, total: toDecimal(point.total, userScale),
      byType: Object.fromEntries(ACCOUNT_TYPES.map(t => [t, toDecimal(point.byType[t], userScale)])) as Record<AccountType, number>,
    };
  });
  history.push({
    date: today, approximate, total: toDecimal(total, userScale),
    byType: Object.fromEntries(ACCOUNT_TYPES.map(t => [t, toDecimal(byType.get(t) ?? 0, userScale)])) as Record<AccountType, number>,
  });

  return {
    currency: target,
    total: toDecimal(total, userScale),
    approximate,
    byType: [...byType].map(([type, value]) => ({ type, value: toDecimal(value, userScale) })),
    byCurrency: [...byCurrency].map(([currency, value]) => ({ currency, value: toDecimal(value, userScale) })),
    accounts: rows.map(({ account, value, invested, valueUser, inNetWorth }) => {
      const hasValuation = inputs.get(account.id)!.valuations.length > 0;
      return {
      id: account.id, name: account.name, type: account.type, currency: account.currency,
      value: toDecimal(value, account.scale),
      valueUser: valueUser === null ? null : toDecimal(valueUser, userScale),
      invested: toDecimal(invested, account.scale),
      gain: toDecimal(value - invested, account.scale),
      gainPct: hasValuation && invested > 0 ? Math.round((value - invested) / invested * 10000) / 100 : null,
      inNetWorth,
    }; }),
    history,
  };
};
