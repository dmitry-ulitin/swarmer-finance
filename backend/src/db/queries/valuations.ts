import { query, queryOne, execute } from '../index';

export interface ValuationRow {
  id: number;
  account_id: number;
  as_of: string;
  value: number;
  user_id: number;
  created_at: Date;
}

const num = (r: ValuationRow): ValuationRow => ({ ...r, value: Number(r.value) });

export const listValuations = async (accountIds: number[]): Promise<ValuationRow[]> => {
  if (accountIds.length === 0) return [];
  const rows = await query<ValuationRow>(
    'SELECT * FROM account_valuations WHERE account_id = ANY($1) ORDER BY account_id, as_of',
    [accountIds]
  );
  return rows.map(num);
};

export const insertValuation = async (
  accountId: number,
  asOf: string,
  value: number,
  userId: number
): Promise<ValuationRow> => {
  const row = await queryOne<ValuationRow>(
    `INSERT INTO account_valuations (account_id, as_of, value, user_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [accountId, asOf, value, userId]
  );
  return num(row!);
};

export const updateValuation = async (
  accountId: number,
  valuationId: number,
  asOf: string,
  value: number
): Promise<ValuationRow | null> => {
  const row = await queryOne<ValuationRow>(
    `UPDATE account_valuations SET as_of = $3, value = $4
     WHERE id = $1 AND account_id = $2 RETURNING *`,
    [valuationId, accountId, asOf, value]
  );
  return row ? num(row) : null;
};

export const deleteValuation = async (accountId: number, valuationId: number): Promise<boolean> => {
  const count = await execute(
    'DELETE FROM account_valuations WHERE id = $1 AND account_id = $2',
    [valuationId, accountId]
  );
  return count > 0;
};
