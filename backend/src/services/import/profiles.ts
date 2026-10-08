export type ProfileId = 'lhv' | 'boc' | 'alfa' | 'caixa';

/**
 * One bank's layout, as data. Everything that differs between statements is
 * a field here, so adding a bank is a data change rather than a code change.
 */
export interface Profile {
  id: ProfileId;
  name: string;
  /** Container format: CSV text, or an Excel workbook (its first sheet). */
  reader: 'csv' | 'xls';
  encoding: 'utf8';
  delimiter: string;
  /** Lines of preamble before the header row. */
  skipLines: number;
  /** Columns that together identify this format when none was given. */
  headerSignature: string[];
  /**
   * Localised header names mapped to the canonical ones used everywhere
   * else in the profile. Lets one profile (and one hash namespace) cover a
   * bank that exports the same layout in several languages.
   */
  headerAliases?: Record<string, string>;
  /** 'excel' is a workbook date cell's serial day number. */
  dateFormat: 'iso' | 'dd/mm/yyyy' | 'dd.mm.yyyy' | 'excel';
  /** 'comma' implies '.' groups thousands, as in "39.384,54". */
  decimal: 'dot' | 'comma';
  amount:
    | { kind: 'signed'; column: string; directionColumn?: string; debitFlag?: string }
    | { kind: 'split'; debitColumn: string; creditColumn: string };
  columns: { date: string; description: string; payee?: string };
  /**
   * A preamble currency follows `after` in the line's first cell, or sits
   * in the next cell when `after` fills the first. `aliases` maps the
   * bank's names to our codes, e.g. the obsolete RUR to RUB.
   */
  currency:
    | { from: 'column'; column: string; aliases?: Record<string, string> }
    | { from: 'preamble'; line: number; after: string; aliases?: Record<string, string> };
  identity:
    | { kind: 'reference'; columns: string[] }
    | { kind: 'content' };
  /**
   * For a statement covering several of the customer's accounts at one
   * bank: rows that are two sides of a move between those accounts (same
   * date, description and amount, opposite signs, different values in
   * `accountColumn`) are dropped, since they net to zero on the one account
   * the statement is imported into.
   */
  internalTransfers?: { accountColumn: string };
}

export const PROFILES: Record<ProfileId, Profile> = {
  lhv: {
    id: 'lhv',
    name: 'LHV',
    reader: 'csv',
    encoding: 'utf8',
    delimiter: ',',
    skipLines: 0,
    headerSignature: ['Customer account no', 'Debit/Credit (D/C)', 'Amount'],
    // The Russian- and Estonian-language exports: same columns, same order,
    // same values.
    headerAliases: {
      'Счёт клиента': 'Customer account no',
      'Номер документа': 'Document no',
      'Дата': 'Date',
      'Счёт плательщика/получателя': 'Sender/receiver account',
      'Имя плательщика/получателя': 'Sender/receiver name',
      'Дебет/Кредит (D/C)': 'Debit/Credit (D/C)',
      'Сумма': 'Amount',
      'Номер ссылки': 'Reference number',
      'Признак архивирования': 'Archiving code',
      'Пояснение': 'Description',
      'Валюта': 'Currency',
      'Личный код или регистрационный код': 'Personal code or register code',
      'BIC банка получателя/плательщика': 'Sender/receiver bank BIC',
      'Имя инициатора платежа': 'Ultimate debtor name',
      'Ссылка проводки': 'Transaction reference',
      'Ссылка поставщика счета': 'Account servicer reference',
      'Kliendi konto': 'Customer account no',
      'Dokumendi number': 'Document no',
      'Kuupäev': 'Date',
      'Saaja/maksja konto': 'Sender/receiver account',
      'Saaja/maksja nimi': 'Sender/receiver name',
      'Deebet/Kreedit (D/C)': 'Debit/Credit (D/C)',
      'Summa': 'Amount',
      'Viitenumber': 'Reference number',
      'Arhiveerimistunnus': 'Archiving code',
      'Selgitus': 'Description',
      'Valuuta': 'Currency',
      'Isikukood või registrikood': 'Personal code or register code',
      'Saaja/maksja panga BIC': 'Sender/receiver bank BIC',
      'Makse algataja nimi': 'Ultimate debtor name',
      'Kande viide': 'Transaction reference',
      'Konto teenusepakkuja viide': 'Account servicer reference',
    },
    dateFormat: 'iso',
    decimal: 'dot',
    // LHV's Amount is already signed consistently with its D/C column, but
    // the explicit flag is the authority: a bank exporting unsigned amounts
    // with a direction column is common, and trusting the flag fails safe.
    amount: { kind: 'signed', column: 'Amount', directionColumn: 'Debit/Credit (D/C)', debitFlag: 'D' },
    columns: {
      date: 'Date',
      description: 'Description',
      payee: 'Sender/receiver name',
    },
    currency: { from: 'column', column: 'Currency' },
    // NOT "Transaction reference": LHV reuses that across every posting in
    // one batch, so interest and its tax — or a term deposit's close,
    // interest and tax — share a value and would collapse to one hash,
    // silently dropping real transactions. "Account servicer reference" is
    // unique per row (verified across a real 143-row statement: 143 distinct,
    // none empty).
    identity: { kind: 'reference', columns: ['Account servicer reference'] },
  },
  boc: {
    id: 'boc',
    name: 'Bank of Cyprus',
    reader: 'csv',
    encoding: 'utf8',
    delimiter: ',',
    skipLines: 5,
    headerSignature: ['Date', 'Description', 'Debit', 'Credit', 'Indicative balance'],
    dateFormat: 'dd/mm/yyyy',
    decimal: 'comma',
    amount: { kind: 'split', debitColumn: 'Debit', creditColumn: 'Credit' },
    // No payee column: the merchant is buried in the description blob, and
    // regex-guessing it is a separate concern.
    columns: { date: 'Date', description: 'Description' },
    currency: { from: 'preamble', line: 4, after: 'Account currency:' },
    identity: { kind: 'reference', columns: ['Bank reference number'] },
  },
  alfa: {
    id: 'alfa',
    name: 'Alfa-Bank',
    reader: 'csv',
    encoding: 'utf8',
    delimiter: ',',
    skipLines: 0,
    headerSignature: ['operationDate', 'accountNumber', 'merchant', 'amount', 'type'],
    dateFormat: 'dd.mm.yyyy',
    decimal: 'dot',
    // Amounts are unsigned; "type" says which way the money went.
    amount: { kind: 'signed', column: 'amount', directionColumn: 'type', debitFlag: 'Списание' },
    // "category" is the bank's own spending category ("Коммунальные услуги");
    // there is no payee column, and it is what the category suggestions key
    // on. "merchant" holds the merchant or the payment's wording.
    columns: { date: 'operationDate', description: 'merchant', payee: 'category' },
    currency: { from: 'column', column: 'currency', aliases: { RUR: 'RUB' } },
    // No per-row reference in the export.
    identity: { kind: 'content' },
    // One export spans every account the customer holds (current, savings,
    // deposits, metal), which are imported into one account.
    internalTransfers: { accountColumn: 'accountNumber' },
  },
  caixa: {
    id: 'caixa',
    name: 'CaixaBank',
    reader: 'xls',
    encoding: 'utf8',
    delimiter: ',',
    skipLines: 2,
    headerSignature: ['Date', 'Value date', 'Transaction', 'More data', 'Amount', 'Balance'],
    dateFormat: 'excel',
    decimal: 'dot',
    amount: { kind: 'signed', column: 'Amount' },
    // "Transaction" names the counterparty or the kind of charge ("ONEBILL
    // MYBOX", "CUOTA T. Visa Déb"); "More data" is its free-text detail.
    columns: { date: 'Date', description: 'More data', payee: 'Transaction' },
    currency: { from: 'preamble', line: 1, after: 'Amounts expressed in', aliases: { euros: 'EUR' } },
    // No per-row reference in the export.
    identity: { kind: 'content' },
  },
};

/** The profile's header row, with localised names mapped to canonical ones. */
export function headerRow(grid: string[][], profile: Profile): string[] | undefined {
  const header = grid[profile.skipLines];
  const aliases = profile.headerAliases;
  return header && aliases ? header.map(h => aliases[h] ?? h) : header;
}

/** The profile whose header signature appears at its declared offset. */
export function detectProfile(grid: string[][]): Profile | null {
  for (const profile of Object.values(PROFILES)) {
    const header = headerRow(grid, profile);
    if (!header) continue;
    if (profile.headerSignature.every(col => header.includes(col))) return profile;
  }
  return null;
}

export function getProfile(id: string): Profile {
  const profile = PROFILES[id as ProfileId];
  if (!profile) {
    throw {
      statusCode: 400,
      message: `Unknown statement format '${id}'. Supported: ${Object.keys(PROFILES).join(', ')}`,
    };
  }
  return profile;
}
