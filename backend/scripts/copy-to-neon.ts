/**
 * One-off copy of users 1 and 2 (and everything that belongs to them) from
 * the local dev database (DATABASE_URL in backend/.env) into an empty,
 * migrated target, keeping ids.
 *
 *   npx tsx scripts/copy-to-neon.ts <TARGET>
 *
 * TARGET is a postgres URL or the name of a variable in backend/.env that
 * holds one (e.g. NEON_DATABASE_URL_UNPOOLED). The source is only read.
 */
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const USER_IDS = [1, 2];

// Copy order respects foreign keys. Each filter selects the rows that belong
// to USER_IDS ($1); the same filter counts them on both sides afterwards.
const ACCOUNTS = 'SELECT id FROM accounts WHERE user_id = ANY($1)';
const TABLES: { name: string; where: string }[] = [
  { name: 'users', where: 'id = ANY($1)' },
  { name: 'accounts', where: 'user_id = ANY($1)' },
  { name: 'account_shares', where: `account_id IN (${ACCOUNTS})` },
  { name: 'categories', where: 'user_id = ANY($1)' },
  {
    name: 'transactions',
    where: `debit_account_id IN (${ACCOUNTS}) OR credit_account_id IN (${ACCOUNTS})`,
  },
  { name: 'chain_seen_txids', where: `account_id IN (${ACCOUNTS})` },
  { name: 'exchange_rates', where: 'TRUE' },
];
const params = (where: string) => (where.includes('$1') ? [USER_IDS] : []);
const SEQUENCED = ['users', 'accounts', 'categories', 'transactions', 'exchange_rates'];

const BALANCES = `
  SELECT a.id, a.start_balance
    + COALESCE((SELECT SUM(credit) FROM transactions WHERE credit_account_id = a.id), 0)
    - COALESCE((SELECT SUM(debit) FROM transactions WHERE debit_account_id = a.id), 0) AS balance
  FROM accounts a WHERE a.user_id = ANY($1) ORDER BY a.id`;

function resolveTarget(arg: string | undefined): string {
  if (!arg) throw new Error('usage: npx tsx scripts/copy-to-neon.ts <TARGET url or .env variable>');
  const url = /^postgres(ql)?:\/\//.test(arg) ? arg : process.env[arg];
  if (!url) throw new Error(`${arg} is not set in backend/.env`);
  return url;
}

function sameDatabase(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  return ua.hostname === ub.hostname && (ua.port || '5432') === (ub.port || '5432') && ua.pathname === ub.pathname;
}

async function migrations(c: Client): Promise<string> {
  const rows = await c.query<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename');
  return rows.rows.map((r) => r.filename).join(',');
}

async function checkTargetEmpty(source: Client, target: Client): Promise<void> {
  if ((await migrations(source)) !== (await migrations(target))) {
    throw new Error('target schema_migrations differ from the source — run the migrations first');
  }
  for (const t of ['users', 'accounts', 'transactions', 'account_shares', 'chain_seen_txids', 'exchange_rates']) {
    const { rows } = await target.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`);
    if (rows[0].n !== '0') throw new Error(`target is not empty: ${t} has ${rows[0].n} rows`);
  }
  const { rows } = await target.query<{ n: string }>('SELECT count(*) AS n FROM categories WHERE user_id IS NOT NULL');
  if (rows[0].n !== '0') throw new Error(`target is not empty: categories has ${rows[0].n} user rows`);
}

async function counts(c: Client): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of TABLES) {
    const { rows } = await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${t.name} WHERE ${t.where}`, params(t.where));
    out[t.name] = rows[0].n;
  }
  return out;
}

async function balances(c: Client): Promise<Map<string, string>> {
  const { rows } = await c.query<{ id: number; balance: string }>(BALANCES, [USER_IDS]);
  return new Map(rows.map((r) => [String(r.id), r.balance]));
}

async function main() {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error('DATABASE_URL is not set in backend/.env');
  const targetUrl = resolveTarget(process.argv[2]);
  if (sameDatabase(sourceUrl, targetUrl)) throw new Error('source and target are the same database');

  const source = new Client({ connectionString: sourceUrl });
  const target = new Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();
  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await checkTargetEmpty(source, target);

    await target.query('BEGIN');
    try {
      for (const t of TABLES) {
        // Postgres serializes the rows itself, so dates and timestamps
        // round-trip exactly; one INSERT per table lets a category point at a
        // parent in the same batch (non-deferred FKs are checked per statement).
        const { rows } = await source.query<{ json: string }>(
          `SELECT COALESCE(json_agg(t), '[]')::text AS json FROM (SELECT * FROM ${t.name} WHERE ${t.where}) t`,
          params(t.where),
        );
        await target.query(`INSERT INTO ${t.name} SELECT * FROM json_populate_recordset(NULL::${t.name}, $1::json)`, [
          rows[0].json,
        ]);
      }
      for (const t of SEQUENCED) {
        await target.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), (SELECT max(id) FROM ${t}))`);
      }
      await target.query('COMMIT');
    } catch (err) {
      await target.query('ROLLBACK');
      throw err;
    }

    const [sc, tc, sb, tb] = await Promise.all([counts(source), counts(target), balances(source), balances(target)]);
    let ok = true;
    console.log('table              source   target');
    for (const t of TABLES) {
      const match = sc[t.name] === tc[t.name];
      ok &&= match;
      console.log(`${t.name.padEnd(18)} ${sc[t.name].padStart(6)}   ${tc[t.name].padStart(6)}${match ? '' : '   MISMATCH'}`);
    }
    const ids = new Set([...sb.keys(), ...tb.keys()]);
    const bad = [...ids].filter((id) => sb.get(id) !== tb.get(id));
    ok &&= bad.length === 0;
    console.log(`account balances: ${ids.size - bad.length}/${ids.size} match${bad.length ? ` — mismatched: ${bad.join(', ')}` : ''}`);
    await source.query('COMMIT');
    if (!ok) {
      console.error('Verification FAILED');
      process.exitCode = 1;
    } else {
      console.log('Copy verified');
    }
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
