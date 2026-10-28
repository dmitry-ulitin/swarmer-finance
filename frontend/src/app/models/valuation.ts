export interface Valuation {
  id: number;
  account_id: number;
  /** Date (YYYY-MM-DD) the value is as of. */
  as_of: string;
  value: number;
  user_id: number;
  created_at: string;
}

export interface ValuationPayload {
  asOf: string;
  value: number;
}
