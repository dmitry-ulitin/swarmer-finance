import { query, queryOne, execute } from '../index';
import { Transaction, TransactionDTO } from '../../types';
import { CATEGORY_PATHS_CTE } from './categories';

/** What the client may ask for. `account` is an optional narrowing filter. */
export interface TransactionFilters {
  from?: string;
  to?: string;
  category?: number[];
  account?: number[];
  details?: string;
  type?: 'income' | 'expense' | 'transfer';
  offset?: number;
  limit?: number;
}

/**
 * What the query actually runs with. `account` is REQUIRED here and carries
 * the accounts the caller may reach — it is the access gate, not a filter.
 * The service builds it by intersecting any client-supplied `account` with
 * the caller's accessible set, so it can only ever narrow.
 */
export type TransactionQueryFilters = Omit<TransactionFilters, 'account'> & {
  account: number[];
};

export interface CreateTransactionData {
  categoryId?: number;
  debitAccountId?: number | null;
  creditAccountId?: number | null;
  debit: number;
  credit: number;
  date: string;
  description?: string;
  payee?: string | null;
  /** Set only by the import flow; NULL for hand-entered transactions. */
  importHash?: string | null;
}

export interface UpdateTransactionData {
  categoryId?: number;
  debitAccountId?: number;
  creditAccountId?: number;
  debit?: number;
  credit?: number;
  date?: string;
  description?: string;
  payee?: string;
}

interface TransactionRow extends Transaction {
  category_name: string | null;
  category_color: string | null;
  category_user_id: number | null;
  category_parent_id: number | null;
  category_icon: string | null;
  category_created_at: Date | null;
  category_owner_name: string | null;
  category_full_name: string | null;
  category_root_id: number | null;
  debit_account_name: string | null;
  debit_account_currency: string | null;
  debit_account_scale: number | null;
  credit_account_name: string | null;
  credit_account_currency: string | null;
  credit_account_scale: number | null;
}

function toDTO(row: TransactionRow): TransactionDTO {
  return {
    id: row.id,
    user_id: row.user_id,
    category: row.category_id != null
      ? {
          id: row.category_id,
          user_id: row.category_user_id,
          name: row.category_name!,
          parent_id: row.category_parent_id,
          color: row.category_color!,
          icon: row.category_icon!,
          created_at: row.category_created_at!,
          owner_name: row.category_owner_name,
          fullName: row.category_full_name!,
          root_id: row.category_root_id!,
        }
      : null,
    debit_account: row.debit_account_id != null
      ? { id: row.debit_account_id, name: row.debit_account_name!, currency: row.debit_account_currency!, scale: row.debit_account_scale! }
      : null,
    credit_account: row.credit_account_id != null
      ? { id: row.credit_account_id, name: row.credit_account_name!, currency: row.credit_account_currency!, scale: row.credit_account_scale! }
      : null,
    debit: row.debit,
    credit: row.credit,
    date: row.date,
    description: row.description,
    payee: row.payee,
    created_at: row.created_at,
  };
}

const WITH_DETAILS_SQL = `
  ${CATEGORY_PATHS_CTE}
  SELECT t.*,
         c.name as category_name, c.color as category_color,
         c.user_id as category_user_id, c.parent_id as category_parent_id,
         c.icon as category_icon, c.created_at as category_created_at,
         cu.name as category_owner_name,
         cp.full_name as category_full_name, cp.root_id as category_root_id,
         da.name as debit_account_name, da.currency as debit_account_currency, da.scale as debit_account_scale,
         ca.name as credit_account_name, ca.currency as credit_account_currency, ca.scale as credit_account_scale
  FROM transactions t
  LEFT JOIN categories c ON t.category_id = c.id
  LEFT JOIN users cu ON cu.id = c.user_id
  LEFT JOIN category_paths cp ON cp.id = c.id
  LEFT JOIN accounts da ON t.debit_account_id = da.id
  LEFT JOIN accounts ca ON t.credit_account_id = ca.id
`;

export const getTransactionDTOById = async (id: number): Promise<TransactionDTO | null> => {
  const row = await queryOne<TransactionRow>(
    `${WITH_DETAILS_SQL} WHERE t.id = $1`,
    [id]
  );
  return row ? toDTO(row) : null;
};

export const getTransactions = async (
  filters: TransactionQueryFilters
): Promise<TransactionDTO[]> => {
  // An empty account list means "nothing is reachable", so nothing matches.
  // This guard is load-bearing: without it the predicate below would be
  // `= ANY('{}')`, which matches no rows only by accident of SQL semantics,
  // and any future refactor that made the predicate conditional would turn
  // an empty list into "no filter at all" — i.e. every transaction in the
  // database. Keep the guard even if the predicate looks sufficient.
  if (filters.account.length === 0) return [];

  // A transaction is visible when the user can reach at least one of its
  // accounts. t.user_id records who entered it and is NOT an access filter.
  //
  // This predicate is UNCONDITIONAL — it is the access gate. `filters.account`
  // has already been intersected with the caller's accessible set by the
  // service, so it can only narrow, never widen. Do not make it conditional.
  const conditions: string[] = [
    '(t.debit_account_id = ANY($1::int[]) OR t.credit_account_id = ANY($1::int[]))',
  ];
  const params: unknown[] = [filters.account];
  let paramIndex = 2;

  if (filters.from) {
    conditions.push(`t.date >= $${paramIndex++}`);
    params.push(filters.from);
  }

  if (filters.to) {
    conditions.push(`t.date <= $${paramIndex++}`);
    params.push(filters.to);
  }

  if (filters.category?.length) {
    conditions.push(`t.category_id = ANY($${paramIndex++}::int[])`);
    params.push(filters.category);
  }

  if (filters.details) {
    const idx = paramIndex++;
    conditions.push(`(t.description ILIKE $${idx} OR t.payee ILIKE $${idx})`);
    params.push(`%${filters.details}%`);
  }

  if (filters.type === 'expense') {
    conditions.push('t.debit_account_id IS NOT NULL AND t.credit_account_id IS NULL');
  } else if (filters.type === 'income') {
    conditions.push('t.debit_account_id IS NULL AND t.credit_account_id IS NOT NULL');
  } else if (filters.type === 'transfer') {
    conditions.push('t.debit_account_id IS NOT NULL AND t.credit_account_id IS NOT NULL');
  }

  const whereClause = conditions.join(' AND ');
  const limit = filters.limit ?? 20;
  const offset = filters.offset ?? 0;

  const rows = await query<TransactionRow>(
    `${WITH_DETAILS_SQL}
     WHERE ${whereClause}
     ORDER BY t.date DESC, t.created_at DESC, t.id DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, limit, offset]
  );

  return rows.map(toDTO);
};

export const getTransactionById = async (id: number): Promise<Transaction | null> => {
  return queryOne<Transaction>('SELECT * FROM transactions WHERE id = $1', [id]);
};

export const createTransaction = async (
  userId: number,
  data: CreateTransactionData
): Promise<TransactionDTO> => {
  const result = await query<{ id: number }>(
    `INSERT INTO transactions
       (user_id, category_id, debit_account_id, credit_account_id, debit, credit, date, description, payee, import_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      userId,
      data.categoryId ?? null,
      data.debitAccountId ?? null,
      data.creditAccountId ?? null,
      data.debit,
      data.credit,
      data.date,
      data.description || '',
      data.payee ?? null,
      data.importHash ?? null,
    ]
  );
  return (await getTransactionDTOById(result[0].id))!;
};

export const updateTransaction = async (
  id: number,
  data: UpdateTransactionData
): Promise<TransactionDTO | null> => {
  const count = await execute(
    `UPDATE transactions
     SET category_id = $1,
         debit_account_id = $2,
         credit_account_id = $3,
         debit = $4,
         credit = $5,
         date = $6,
         description = $7,
         payee = $8
     WHERE id = $9`,
    [
      data.categoryId ?? null,
      data.debitAccountId ?? null,
      data.creditAccountId ?? null,
      data.debit ?? null,
      data.credit ?? null,
      data.date ?? null,
      data.description ?? null,
      data.payee ?? null,
      id,
    ]
  );
  if (count === 0) return null;
  return getTransactionDTOById(id);
};

export const deleteTransaction = async (id: number): Promise<boolean> => {
  const count = await execute('DELETE FROM transactions WHERE id = $1', [id]);
  return count > 0;
};

export interface AccountBalanceAt {
  id: number;
  balance: number;
}

// Balance strictly before the (date, createdAt, id) cursor — matching the
// (date DESC, created_at DESC, id DESC) order transactions are listed in,
// so a cursor anchored to one page's oldest transaction excludes exactly
// the transactions already summed on earlier pages, even when several
// transactions share the same date and created_at.
export const getBalancesAt = async (
  accountIds: number[],
  date: string,
  createdAt: Date,
  id: number
): Promise<AccountBalanceAt[]> => {
  if (accountIds.length === 0) return [];
  const rows = await query<{ id: number; balance: string }>(
    `SELECT a.id,
            (a.start_balance
             + COALESCE(SUM(t.credit) FILTER (WHERE t.credit_account_id = a.id), 0)
             - COALESCE(SUM(t.debit)  FILTER (WHERE t.debit_account_id  = a.id), 0)
            )::numeric AS balance
     FROM accounts a
     LEFT JOIN transactions t
            ON (t.credit_account_id = a.id OR t.debit_account_id = a.id)
           AND (t.date, t.created_at, t.id) < ($1::date, $2::timestamptz, $3::int)
     WHERE a.id = ANY($4::int[])
     GROUP BY a.id, a.start_balance`,
    [date, createdAt, id, accountIds]
  );
  return rows.map(r => ({ id: r.id, balance: Number(r.balance) }));
};

export interface AccountBalance {
  debit_account_id: number | null;
  credit_account_id: number | null;
  debit: number;
  credit: number;
  last_date: string;
}

export const getAccountBalances = async (
  accountIds: number[]
): Promise<AccountBalance[]> => {
  // An empty list means no accounts, so no balances. The previous
  // `array_length(...) IS NULL` branch meant "all of this user's
  // transactions"; with user_id gone it would mean every transaction in the
  // database, so it is removed and callers always pass an explicit list.
  if (accountIds.length === 0) return [];
  const rows = await query<Omit<AccountBalance, 'debit' | 'credit'> & { debit: string; credit: string }>(
    `SELECT
       debit_account_id,
       credit_account_id,
       SUM(debit) AS debit,
       SUM(credit) AS credit,
       MAX(date) AS last_date
     FROM transactions
     WHERE debit_account_id = ANY($1::int[])
        OR credit_account_id = ANY($1::int[])
     GROUP BY debit_account_id, credit_account_id
     ORDER BY last_date DESC`,
    [accountIds]
  );
  return rows.map(row => ({ ...row, debit: Number(row.debit), credit: Number(row.credit) }));
};

/**
 * Which of `hashes` already exist on this account.
 *
 * Scoped by account id alone — access is settled in the service layer, and a
 * hash is only unique within an account anyway.
 */
export const findExistingImportHashes = async (
  accountId: number,
  hashes: string[]
): Promise<string[]> => {
  if (hashes.length === 0) return [];
  const rows = await query<{ import_hash: string }>(
    `SELECT DISTINCT import_hash
     FROM transactions
     WHERE import_hash = ANY($1::text[])
       AND (debit_account_id = $2 OR credit_account_id = $2)`,
    [hashes, accountId]
  );
  return rows.map(r => r.import_hash);
};

/**
 * Transactions on this account falling on any of `dates`, for the heuristic
 * duplicate check. Returns amounts in cents; the service matches them.
 */
export const findByDates = async (
  accountId: number,
  dates: string[]
): Promise<{
  id: number;
  date: string;
  debit: string;
  credit: string;
  debit_account_id: number | null;
  credit_account_id: number | null;
}[]> => {
  if (dates.length === 0) return [];
  return query<{
    id: number;
    date: string;
    debit: string;
    credit: string;
    debit_account_id: number | null;
    credit_account_id: number | null;
  }>(
    `SELECT id, date, debit, credit, debit_account_id, credit_account_id
     FROM transactions
     WHERE date = ANY($1::date[])
       AND (debit_account_id = $2 OR credit_account_id = $2)`,
    [dates, accountId]
  );
};

/**
 * Categorised expenses and incomes on these accounts, the history import
 * learns category suggestions from. Transfers and the Uncategorized
 * categories (3, 4) are left out: neither says anything about a merchant.
 */
export const findCategorizedHistory = async (
  accountIds: number[]
): Promise<{
  categoryId: number;
  side: 'expense' | 'income';
  payee: string | null;
  description: string;
}[]> => {
  if (accountIds.length === 0) return [];
  return query<{
    categoryId: number;
    side: 'expense' | 'income';
    payee: string | null;
    description: string;
  }>(
    `SELECT category_id AS "categoryId",
            CASE WHEN debit_account_id IS NOT NULL THEN 'expense' ELSE 'income' END AS side,
            payee,
            COALESCE(description, '') AS description
     FROM transactions
     WHERE category_id IS NOT NULL
       AND category_id NOT IN (3, 4)
       AND ((debit_account_id = ANY($1::int[]) AND credit_account_id IS NULL)
         OR (credit_account_id = ANY($1::int[]) AND debit_account_id IS NULL))`,
    [accountIds]
  );
};

export interface ImportedTransactionData extends CreateTransactionData {
  importHash: string;
}

/**
 * Bulk insert in one statement. ON CONFLICT DO NOTHING against the partial
 * unique indexes makes a double-submit a no-op rather than a duplicate, so
 * the count returned is what actually landed.
 *
 * Includes `payee` (deviating from the original brief draft, which omitted
 * it): the single-row createTransaction already stores payee, LHV supplies a
 * real counterparty name, and dropping it only in the bulk path would make
 * imported transactions strictly worse than hand-entered ones.
 */
export const createImportedTransactions = async (
  userId: number,
  rows: ImportedTransactionData[]
): Promise<number> => {
  if (rows.length === 0) return 0;

  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    const b = i * 10;
    values.push(
      userId,
      r.categoryId ?? null,
      r.debitAccountId ?? null,
      r.creditAccountId ?? null,
      r.debit,
      r.credit,
      r.date,
      r.description || '',
      r.payee ?? null,
      r.importHash
    );
    return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7}, $${b+8}, $${b+9}, $${b+10})`;
  });

  // Two partial indexes cover this table, one per account column, so a single
  // ON CONFLICT target cannot name both; DO NOTHING without a target lets
  // either index absorb the conflict.
  const inserted = await query<{ id: number }>(
    `INSERT INTO transactions
       (user_id, category_id, debit_account_id, credit_account_id, debit, credit, date, description, payee, import_hash)
     VALUES ${tuples.join(', ')}
     ON CONFLICT DO NOTHING
     RETURNING id`,
    values
  );
  return inserted.length;
};
