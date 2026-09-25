import * as fs from 'fs';
import * as path from 'path';
import {
  tronProvider, toBase58, trc20ToChainTxs, trxToChainTx, Trc20Transfer, TronTx, USDT_CONTRACT,
} from '../services/chain/tron';

const ADDR = 'TPJe9tgEJFsgVTQ4gLjzRTCrQ6pRJYc1aS';
const fixture = <T>(name: string): { data: T[] } =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'chain', name), 'utf8'));
const trc20 = fixture<Trc20Transfer>('tron-trc20-TPJe9t.json').data;
const trx = fixture<TronTx>('tron-trx-TPJe9t.json').data;

describe('toBase58', () => {
  it.each([
    ['41924688d76aab0d0bc11f447296157f3ede8d5955', ADDR],
    ['41a614f803b6fd780986a42c78ec9c7f77e6ded13c', USDT_CONTRACT],
  ])('encodes %s', (hex, base58) => {
    expect(toBase58(hex)).toBe(base58);
  });
});

describe('trc20ToChainTxs', () => {
  const txs = trc20ToChainTxs(trc20, ADDR);
  const byId = (prefix: string) => txs.find(t => t.txid.startsWith(prefix))!;

  it('returns one ChainTx per transaction, including the fake token one', () => {
    expect(txs).toHaveLength(8);
  });

  it('reads a USDT receipt', () => {
    expect(byId('14ab622d')).toEqual({
      txid: '14ab622d6160d3e8f2ae73b7485755d08057c1c7b6297cb92c66a1b8446503de',
      date: '2025-12-18',
      fee: 0,
      transfers: [{ counterparty: 'TPTMUUz3uvdxZDMY7WLRkz2Tre9z4kLU1b', amount: 1002000 }],
    });
  });

  it('reads a USDT payment without a fee', () => {
    expect(byId('9b32a6fc')).toMatchObject({
      fee: 0,
      transfers: [{ counterparty: 'TPTMUtEBqk3G1Pci3YKpcbEBRjnG4kLU1b', amount: -200000000 }],
    });
  });

  it('returns a fake-token tx with no transfers', () => {
    expect(byId('4b54d147').transfers).toEqual([]);
  });

  it('nets to the USDT balance on the chain', () => {
    const total = txs.flatMap(t => t.transfers).reduce((s, t) => s + t.amount, 0);
    expect(total).toBe(36985002000);
  });

  it('groups several transfers of one transaction and drops a transfer to itself', () => {
    const rec = (from: string, to: string, value: string): Trc20Transfer => ({
      transaction_id: 'multi', block_timestamp: 1766074035000, from, to, value, token_info: { address: USDT_CONTRACT },
    });
    expect(trc20ToChainTxs([rec(ADDR, 'Tx1', '5'), rec(ADDR, 'Tx2', '7'), rec(ADDR, ADDR, '9')], ADDR)).toEqual([{
      txid: 'multi', date: '2025-12-18', fee: 0,
      transfers: [{ counterparty: 'Tx1', amount: -5 }, { counterparty: 'Tx2', amount: -7 }],
    }]);
  });
});

describe('trxToChainTx', () => {
  const txs = trx.map(t => trxToChainTx(t, ADDR));
  const byId = (prefix: string) => txs.find(t => t.txid.startsWith(prefix))!;

  it('reads an incoming TRX transfer without the fee its sender paid', () => {
    expect(byId('bab598b6')).toEqual({
      txid: 'bab598b6ce77b3b8a009d262fb9cf9b7f299cd63ee6da86f6ec492197642c4b1',
      date: '2025-01-20',
      fee: 0,
      transfers: [{ counterparty: 'TAtiJ9wVYi7wS25wYf5KW3CnWuYScX9CR3', amount: 25000000 }],
    });
  });

  it('reads dust as income', () => {
    expect(byId('66ff1206').transfers).toEqual([{ counterparty: 'TJDDWheKBEuT9rtrL13jhohnUc31RSCx57', amount: 7 }]);
  });

  it('reads a USDT send as a fee-only transaction', () => {
    expect(byId('9b32a6fc')).toMatchObject({ fee: 13028500, transfers: [] });
  });

  it('nets to the TRX balance on the chain', () => {
    const total = txs.reduce((s, t) => s - t.fee + t.transfers.reduce((a, x) => a + x.amount, 0), 0);
    expect(total).toBe(11971521);
  });

  const own = (type: string, value: object, contractRet = 'SUCCESS', fee = 1000): TronTx => ({
    txID: 'own', block_timestamp: 1766074035000,
    ret: [{ contractRet, fee }],
    raw_data: { contract: [{ type, parameter: { value: { owner_address: '41924688d76aab0d0bc11f447296157f3ede8d5955', ...value } } }] },
  });

  it('reads an outgoing TRX transfer with its fee', () => {
    expect(trxToChainTx(own('TransferContract', { to_address: '41a614f803b6fd780986a42c78ec9c7f77e6ded13c', amount: 500 }), ADDR))
      .toMatchObject({ fee: 1000, transfers: [{ counterparty: USDT_CONTRACT, amount: -500 }] });
  });

  it('reads TRX sent with a contract call', () => {
    expect(trxToChainTx(own('TriggerSmartContract', { contract_address: '41a614f803b6fd780986a42c78ec9c7f77e6ded13c', call_value: 300 }), ADDR))
      .toMatchObject({ fee: 1000, transfers: [{ counterparty: USDT_CONTRACT, amount: -300 }] });
  });

  it('keeps only the fee of a failed transaction', () => {
    expect(trxToChainTx(own('TransferContract', { to_address: '41a614f803b6fd780986a42c78ec9c7f77e6ded13c', amount: 500 }, 'REVERT'), ADDR))
      .toMatchObject({ fee: 1000, transfers: [] });
  });

  it('keeps only the fee of any other contract type', () => {
    expect(trxToChainTx(own('FreezeBalanceV2Contract', { frozen_balance: 1000000 }), ADDR))
      .toMatchObject({ fee: 1000, transfers: [] });
  });
});

describe('tronProvider.fetchNewTxs', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  const respond = (status: number, body: unknown) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

  it('syncs TRX and USDT at scale 6', () => {
    expect(tronProvider.currencies).toEqual({ TRX: 6, USDT: 6 });
  });

  it('reads the USDT list of the official contract, oldest first', async () => {
    fetchMock.mockImplementation(() => respond(200, { data: trc20, meta: {} }));
    const txs = await tronProvider.fetchNewTxs(ADDR, 'USDT', new Set());
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.trongrid.io/v1/accounts/${ADDR}/transactions/trc20?contract_address=${USDT_CONTRACT}&limit=200&only_confirmed=true`
    );
    expect(txs[0].txid.startsWith('985e9ec1')).toBe(true);
    expect(txs).toHaveLength(8);
  });

  it('reads the TRX list without internal transactions', async () => {
    fetchMock.mockImplementation(() => respond(200, { data: trx, meta: {} }));
    const txs = await tronProvider.fetchNewTxs(ADDR, 'TRX', new Set());
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.trongrid.io/v1/accounts/${ADDR}/transactions?search_internal=false&limit=200&only_confirmed=true`
    );
    expect(txs.map(t => t.txid.slice(0, 8))).toEqual(trx.map(t => t.txID.slice(0, 8)).reverse());
  });

  it('follows the fingerprint and stops at a page with nothing new', async () => {
    const first = trx.slice(0, 4);
    const second = trx.slice(4);
    fetchMock.mockImplementation((url: string) =>
      respond(200, url.includes('fingerprint=fp%2B1')
        ? { data: second, meta: { fingerprint: 'fp2' } }
        : { data: first, meta: { fingerprint: 'fp+1' } })
    );
    // Everything on the second page is known, so paging stops there even
    // though it has a fingerprint.
    const txs = await tronProvider.fetchNewTxs(ADDR, 'TRX', new Set(second.map(t => t.txID)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('&fingerprint=fp%2B1');
    expect(txs.map(t => t.txid)).toEqual(first.map(t => t.txID).reverse());
  });

  it('stops without a fingerprint', async () => {
    fetchMock.mockImplementation(() => respond(200, { data: trx, meta: {} }));
    await tronProvider.fetchNewTxs(ADDR, 'TRX', new Set());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses TRON_API_URL and TRONGRID_API_KEY when set', async () => {
    process.env.TRON_API_URL = 'https://tron.test';
    process.env.TRONGRID_API_KEY = 'k1';
    fetchMock.mockImplementation(() => respond(200, { data: [], meta: {} }));
    try {
      await tronProvider.fetchNewTxs(ADDR, 'TRX', new Set());
      expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/tron\.test\/v1\/accounts\//);
      expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'TRON-PRO-API-KEY': 'k1' });
    } finally {
      delete process.env.TRON_API_URL;
      delete process.env.TRONGRID_API_KEY;
    }
  });

  it('maps a 400 to Invalid address', async () => {
    fetchMock.mockImplementation(() => respond(400, { success: false, error: 'A valid account address is required.' }));
    await expect(tronProvider.fetchNewTxs('nope', 'TRX', new Set()))
      .rejects.toEqual({ statusCode: 400, message: 'Invalid address' });
  });

  it.each([403, 429, 500])('maps HTTP %i to 502', async status => {
    fetchMock.mockImplementation(() => respond(status, {}));
    await expect(tronProvider.fetchNewTxs(ADDR, 'USDT', new Set()))
      .rejects.toEqual({ statusCode: 502, message: 'Blockchain API unavailable' });
  });

  it('maps a network error to 502', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(tronProvider.fetchNewTxs(ADDR, 'TRX', new Set()))
      .rejects.toEqual({ statusCode: 502, message: 'Blockchain API unavailable' });
  });
});
