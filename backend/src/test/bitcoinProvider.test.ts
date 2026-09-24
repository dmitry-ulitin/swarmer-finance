import * as fs from 'fs';
import * as path from 'path';
import { bitcoinProvider, toChainTx, EsploraTx } from '../services/chain/bitcoin';

const SENDER = 'bc1qda5r9p5l9l74r2gzuz992nvda8d2lezr2wzk56';
const RECEIVER = 'bc1q3yxr3gkes4nmjvtmn5h5qasyh7jzusxzezys75';
const real: EsploraTx = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'chain', 'tx-95333b08.json'), 'utf8')
);

const S = 'bc1qself';
function tx(txid: string, vin: [string, number][], vout: [string, number][], fee = 0): EsploraTx {
  return {
    txid,
    fee,
    status: { confirmed: true, block_time: 1780040936 },
    vin: vin.map(([a, v]) => ({ prevout: { scriptpubkey_address: a, value: v } })),
    vout: vout.map(([a, v]) => ({ scriptpubkey_address: a, value: v })),
  };
}

describe('toChainTx', () => {
  it('reads a real payment from the sender side', () => {
    expect(toChainTx(real, SENDER)).toEqual({
      txid: real.txid,
      date: '2026-05-29',
      fee: 9214,
      transfers: [
        { counterparty: 'bc1qy0rlysheyqwrjhs6e8ya82urst9d479wa24mrn', amount: -10000 },
        { counterparty: RECEIVER, amount: -146435 },
        { counterparty: 'bc1q9rxk6kyv3lky39mtysl0hjjwvuauzfrt0m2mk7', amount: -238474212 },
      ],
    });
  });

  it('reads the same payment from the receiver side', () => {
    expect(toChainTx(real, RECEIVER)).toEqual({
      txid: real.txid,
      date: '2026-05-29',
      fee: 0,
      transfers: [{ counterparty: SENDER, amount: 146435 }],
    });
  });

  it('does not count change back to the address as money leaving', () => {
    const t = tx('c', [[S, 100000]], [['bc1qext', 60000], [S, 39000]], 1000);
    expect(toChainTx(t, S)).toMatchObject({ fee: 1000, transfers: [{ counterparty: 'bc1qext', amount: -60000 }] });
  });

  it('reduces a consolidation to its fee', () => {
    const t = tx('k', [[S, 60000], [S, 40000]], [[S, 99000]], 1000);
    expect(toChainTx(t, S)).toMatchObject({ fee: 1000, transfers: [] });
  });

  it('sums several outputs to the address when receiving', () => {
    const t = tx('r', [['bc1qfrom', 50000]], [[S, 1000], [S, 2000], ['bc1qother', 46000]], 1000);
    expect(toChainTx(t, S)).toMatchObject({ fee: 0, transfers: [{ counterparty: 'bc1qfrom', amount: 3000 }] });
  });
});

describe('bitcoinProvider.fetchNewTxs', () => {
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
  const page = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => tx(`${prefix}${i}`, [['bc1qfrom', 10]], [[S, 10]]));

  it('pages newest-first and returns only unknown txs, oldest first', async () => {
    const first = page('a', 25);
    const second = page('b', 3);
    fetchMock.mockImplementation((url: string) =>
      respond(200, url.endsWith(`/txs/chain/${first[24].txid}`) ? second : first)
    );

    const result = await bitcoinProvider.fetchNewTxs(S, new Set(['b2']));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://mempool.space/api/address/${S}/txs/chain`);
    expect(fetchMock.mock.calls[1][0]).toBe(`https://mempool.space/api/address/${S}/txs/chain/a24`);
    expect(result.map(t => t.txid)).toEqual(['b1', 'b0', ...first.map(t => t.txid).reverse()]);
  });

  it('stops at the first page that is entirely known', async () => {
    const first = page('a', 25);
    fetchMock.mockImplementation(() => respond(200, first));

    const known = new Set(first.map(t => t.txid));
    await expect(bitcoinProvider.fetchNewTxs(S, known)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses BITCOIN_ESPLORA_URL when set', async () => {
    process.env.BITCOIN_ESPLORA_URL = 'https://esplora.test/api';
    fetchMock.mockImplementation(() => respond(200, []));
    try {
      await bitcoinProvider.fetchNewTxs(S, new Set());
      expect(fetchMock.mock.calls[0][0]).toBe(`https://esplora.test/api/address/${S}/txs/chain`);
    } finally {
      delete process.env.BITCOIN_ESPLORA_URL;
    }
  });

  it('maps an Esplora 400 to Invalid address', async () => {
    fetchMock.mockImplementation(() => respond(400, 'Invalid Bitcoin address'));
    await expect(bitcoinProvider.fetchNewTxs('nope', new Set()))
      .rejects.toEqual({ statusCode: 400, message: 'Invalid address' });
  });

  it.each([429, 500, 503])('maps HTTP %i to 502', async status => {
    fetchMock.mockImplementation(() => respond(status, 'busy'));
    await expect(bitcoinProvider.fetchNewTxs(S, new Set()))
      .rejects.toEqual({ statusCode: 502, message: 'Blockchain API unavailable' });
  });

  it('maps a network failure or timeout to 502', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('The operation was aborted due to timeout')));
    await expect(bitcoinProvider.fetchNewTxs(S, new Set()))
      .rejects.toEqual({ statusCode: 502, message: 'Blockchain API unavailable' });
  });
});
