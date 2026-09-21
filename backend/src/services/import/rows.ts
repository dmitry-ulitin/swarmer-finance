import { parseCsv } from './csv';
import { Profile } from './profiles';

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
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
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

export function readStatement(
  text: string,
  profile: Profile
): { rows: ParsedRow[]; currency: string } {
  const grid = parseCsv(text, profile.delimiter);
  const header = grid[profile.skipLines];
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

  let currency: string;
  if (profile.currency.from === 'column') {
    currency = '';
  } else {
    const line = grid[profile.currency.line];
    const label = profile.currency.after;
    if (!line || line[0] !== label) {
      throw { statusCode: 400, message: `Statement preamble is missing '${label}'` };
    }
    currency = (line[1] || '').trim();
  }

  const rows: ParsedRow[] = [];
  const dataRows = grid.slice(profile.skipLines + 1);

  dataRows.forEach((raw, index) => {
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
      const rowCurrency = (raw[col(profile.currency.column)] ?? '').trim();
      if (!currency) currency = rowCurrency;
      else if (rowCurrency && rowCurrency !== currency) {
        throw {
          statusCode: 400,
          message: `Statement mixes currencies (${currency} and ${rowCurrency}); import one currency at a time`,
        };
      }
    }

    const reference =
      profile.identity.kind === 'reference'
        ? profile.identity.columns.map(c => (raw[col(c)] ?? '').trim()).join('|') || null
        : null;

    rows.push({
      index,
      date: parseDate(raw[dateIdx] ?? '', profile.dateFormat),
      amount: round2(amount),
      description: (raw[descIdx] ?? '').trim(),
      payee: payeeIdx === -1 ? null : (raw[payeeIdx] ?? '').trim() || null,
      reference,
    });
  });

  if (!currency) {
    throw { statusCode: 400, message: 'Could not determine the statement currency' };
  }
  return { rows, currency };
}
