import { parseCsv } from './csv';
import { headerRow, Profile } from './profiles';

export interface ParsedRow {
  index: number;
  /** ISO YYYY-MM-DD. */
  date: string;
  /** Decimal, signed: positive income, negative expense. */
  amount: number;
  description: string;
  payee: string | null;
  /** The bank's own reference, when it publishes one. */
  reference: string | null;
}

function parseDate(value: string, format: Profile['dateFormat']): string {
  const v = value.trim();
  if (format === 'iso') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      throw { statusCode: 400, message: `Unreadable date '${value}'` };
    }
    return v;
  }
  const m = v.match(
    format === 'dd.mm.yyyy' ? /^(\d{2})\.(\d{2})\.(\d{4})$/ : /^(\d{2})\/(\d{2})\/(\d{4})$/
  );
  if (!m) throw { statusCode: 400, message: `Unreadable date '${value}'` };
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function parseAmount(value: string, decimal: Profile['decimal']): number {
  let v = value.trim();
  if (v === '') return 0;
  // 'comma' means "39.384,54": dots group thousands, the comma is the point.
  if (decimal === 'comma') v = v.replace(/\./g, '').replace(',', '.');
  v = v.replace(/\s/g, '');
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw { statusCode: 400, message: `Unreadable amount '${value}'` };
  }
  return n;
}

/** Rounds away float drift from the decimal parse, e.g. 0.1 + 0.2 cases. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

type Candidate = Omit<ParsedRow, 'index'> & { account: string };

/**
 * Drops pairs of rows that move money between two of the customer's own
 * accounts: same date, description and amount, opposite signs, different
 * accounts. Each row pairs at most once, so two genuine identical payments
 * are not consumed by one transfer.
 */
function dropInternalTransfers(rows: Candidate[]): Candidate[] {
  const dropped = new Set<Candidate>();
  for (const out of rows) {
    if (out.amount >= 0 || dropped.has(out)) continue;
    const mirror = rows.find(r =>
      !dropped.has(r)
      && r.amount === -out.amount
      && r.account !== out.account
      && r.date === out.date
      && r.description === out.description
    );
    if (mirror) {
      dropped.add(out);
      dropped.add(mirror);
    }
  }
  return rows.filter(r => !dropped.has(r));
}

/**
 * The statement's rows in `accountCurrency`. Rows in any other currency are
 * skipped — a multi-currency statement is imported one currency at a time —
 * but a statement with nothing in that currency is refused, since it is
 * almost certainly the wrong file.
 */
export function readStatement(
  text: string,
  profile: Profile,
  accountCurrency: string
): { rows: ParsedRow[] } {
  const grid = parseCsv(text, profile.delimiter);
  const header = headerRow(grid, profile);
  if (!header) {
    throw { statusCode: 400, message: 'Statement has no header row' };
  }
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i === -1) {
      throw { statusCode: 400, message: `Statement is missing the '${name}' column` };
    }
    return i;
  };

  const dateIdx = col(profile.columns.date);
  const descIdx = col(profile.columns.description);
  const payeeIdx = profile.columns.payee ? col(profile.columns.payee) : -1;
  const accountIdx = profile.internalTransfers ? col(profile.internalTransfers.accountColumn) : -1;

  if (profile.currency.from === 'preamble') {
    const line = grid[profile.currency.line];
    const label = profile.currency.after;
    if (!line || line[0] !== label) {
      throw { statusCode: 400, message: `Statement preamble is missing '${label}'` };
    }
    const currency = (line[1] || '').trim();
    if (!currency) {
      throw { statusCode: 400, message: 'Could not determine the statement currency' };
    }
    if (currency !== accountCurrency) {
      throw {
        statusCode: 400,
        message: `Statement is in ${currency} but the account is in ${accountCurrency}`,
      };
    }
  }

  let candidates: Candidate[] = [];
  const otherCurrencies = new Set<string>();

  grid.slice(profile.skipLines + 1).forEach(raw => {
    let amount: number;
    if (profile.amount.kind === 'signed') {
      amount = parseAmount(raw[col(profile.amount.column)] ?? '', profile.decimal);
      const dirCol = profile.amount.directionColumn;
      if (dirCol) {
        const isDebit = (raw[col(dirCol)] ?? '').trim() === profile.amount.debitFlag;
        amount = isDebit ? -Math.abs(amount) : Math.abs(amount);
      }
    } else {
      const debit = parseAmount(raw[col(profile.amount.debitColumn)] ?? '', profile.decimal);
      const credit = parseAmount(raw[col(profile.amount.creditColumn)] ?? '', profile.decimal);
      amount = credit - debit;
    }

    if (profile.currency.from === 'column') {
      const code = (raw[col(profile.currency.column)] ?? '').trim();
      const rowCurrency = profile.currency.aliases?.[code] ?? code;
      if (rowCurrency && rowCurrency !== accountCurrency) {
        otherCurrencies.add(rowCurrency);
        return;
      }
    }

    const rounded = round2(amount);
    // A zero amount is nothing importable: an empty amount cell, or (Bank of
    // Cyprus) a row with both Debit and Credit blank — an informational /
    // memo line real statements carry.
    if (rounded === 0) return;

    const reference =
      profile.identity.kind === 'reference'
        ? profile.identity.columns.map(c => (raw[col(c)] ?? '').trim()).join('|') || null
        : null;

    candidates.push({
      date: parseDate(raw[dateIdx] ?? '', profile.dateFormat),
      amount: rounded,
      description: (raw[descIdx] ?? '').trim(),
      payee: payeeIdx === -1 ? null : (raw[payeeIdx] ?? '').trim() || null,
      reference,
      account: accountIdx === -1 ? '' : (raw[accountIdx] ?? '').trim(),
    });
  });

  if (candidates.length === 0 && otherCurrencies.size > 0) {
    throw {
      statusCode: 400,
      message: `Statement is in ${[...otherCurrencies].join(', ')} but the account is in ${accountCurrency}`,
    };
  }

  if (profile.internalTransfers) candidates = dropInternalTransfers(candidates);

  // index is assigned only to rows that survive every filter above, so it
  // stays contiguous and computeImportHashes' occurrence counting sees
  // exactly the rows that are returned.
  return {
    rows: candidates.map(({ account: _account, ...row }, index) => ({ index, ...row })),
  };
}
