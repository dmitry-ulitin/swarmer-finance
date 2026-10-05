import * as fs from 'fs';
import * as path from 'path';
import { getProvider } from '../services/chain';
import {
  ethereumProvider, ethToChainTxs, tokenToChainTxs, weiToScale8, EthTx, TokenTransfer, USDT_CONTRACT,
} from '../services/chain/ethereum';

const ADDR = '0xf4f8d6fb5117cec024d135d91c012636b814cc07';
const fixture = <T>(name: string): { status: string; message: string; result: T[] } =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'chain', name), 'utf8'));
// Recorded newest first (sort=desc); the mapping functions take oldest first.
const normal = fixture<EthTx>('eth-txlist-0xf4f8.json').result.slice().reverse();
const internal = fixture<EthTx>('eth-internal-0xf4f8.json').result.slice().reverse();
const usdt = fixture<TokenTransfer>('eth-usdt-0xf4f8.json').result.slice().reverse();

const ROUTER = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
const ethTx = (over: Partial<EthTx>): EthTx => ({
  hash: '0xsynthetic', blockNumber: '26000000', timeStamp: '1789700000',
  from: ADDR, to: ROUTER, value: '0', isError: '0', gasUsed: '100000', gasPrice: '1000000000', ...over,
});

describe('weiToScale8', () => {
  it.each([
    [15000000000n, 2],
    [14999999999n, 1],
    [4999999999n, 0],
    [1000000000000000000n, 100000000],
  ])('rounds %s wei half-up to %i', (wei, units) => {
    expect(weiToScale8(wei)).toBe(units);
  });
});

describe('tokenToChainTxs', () => {
  const txs = tokenToChainTxs(usdt, ADDR);
  const byId = (prefix: string) => txs.find(t => t.txid.startsWith(prefix))!;

  it('returns one ChainTx per transaction, oldest first', () => {
    expect(txs).toHaveLength(20);
    expect(txs[0].txid).toBe('0x5e5a9762fc8948821a6d3fcd505bfbb316798486e5f983e69399afed33ff472a');
  });

  it('reads a USDT receipt', () => {
    expect(byId('0x2b8b5043')).toEqual({
      txid: '0x2b8b50431ea4627e07e7e4156158fdeb64d7cbf96b86b44933dc53a65cdaf706',
      date: '2026-10-05',
      fee: 0,
      transfers: [{ counterparty: '0x8108f44df5f755d36f395b69b8749165c3933a67', amount: 1000000000 }],
    });
  });

  it('reads a USDT payment without a fee', () => {
    expect(byId('0xa083c816')).toMatchObject({
      fee: 0,
      transfers: [{ counterparty: '0x253dd57300904225762960755b7662e6ae06492d', amount: -1000000000 }],
    });
  });

  it('nets to the USDT balance on the chain', () => {
    expect(txs.flatMap(t => t.transfers).reduce((s, t) => s + t.amount, 0)).toBe(50);
  });

  const rec = (over: Partial<TokenTransfer>): TokenTransfer => ({
    hash: '0xmulti', blockNumber: '26000000', timeStamp: '1789700000',
    from: ADDR, to: '0x1', value: '5', contractAddress: USDT_CONTRACT, ...over,
  });

  it('returns an other-token tx with no transfers', () => {
    expect(tokenToChainTxs([rec({ contractAddress: '0xfa4e' })], ADDR)).toEqual([
      { txid: '0xmulti', date: '2026-09-18', fee: 0, transfers: [] },
    ]);
  });

  it('drops a zero-value transfer (address poisoning) but keeps its tx', () => {
    expect(byId('0x0ca65751')).toMatchObject({ fee: 0, transfers: [] });
  });

  it('groups several transfers of one transaction and drops a transfer to itself', () => {
    expect(tokenToChainTxs([rec({ to: '0x1' }), rec({ to: '0x2', value: '7' }), rec({ to: ADDR, value: '9' })], ADDR))
      .toEqual([{
        txid: '0xmulti', date: '2026-09-18', fee: 0,
        transfers: [{ counterparty: '0x1', amount: -5 }, { counterparty: '0x2', amount: -7 }],
      }]);
  });
});

describe('ethToChainTxs', () => {
  const txs = ethToChainTxs(normal, internal, ADDR);
  const byId = (prefix: string) => txs.find(t => t.txid.startsWith(prefix))!;

  it('returns one ChainTx per hash across both lists, oldest first', () => {
    expect(txs).toHaveLength(33);
    expect(txs[0].txid).toBe('0x4951bf7ec9067d527a5cf2ed0c92301fcdd5ef31faedc69e184245fe859cb735');
    expect(txs[32].txid).toBe('0xa083c81616953d32c90f24099b60882e7453d9ea347e63edc217eb22229557a6');
    expect(txs.filter(t => t.transfers.some(x => x.amount > 0))).toHaveLength(15);
    expect(txs.filter(t => t.transfers.some(x => x.amount < 0))).toHaveLength(7);
    expect(txs.filter(t => t.fee > 0)).toHaveLength(15);
  });

  it('reads an outgoing ETH transfer with its fee', () => {
    expect(byId('0xd678ac4d')).toEqual({
      txid: '0xd678ac4de640acc495d429554dd78e7430ab5007dd0c2de62d3abe19c3a2badd',
      date: '2026-03-08',
      fee: 72,
      transfers: [{ counterparty: '0x253dd57300904225762960755b7662e6ae06492d', amount: -3620073 }],
    });
  });

  it('reads an incoming ETH transfer without a fee', () => {
    expect(byId('0x060a6296')).toMatchObject({
      fee: 0,
      transfers: [{ counterparty: '0x20ffdcfc8b16685f3109a3b56da3847b3caa2533', amount: 7510 }],
    });
  });

  it('reads a USDT send as a fee-only transaction', () => {
    expect(byId('0xa083c816')).toMatchObject({ fee: 3766, transfers: [] });
  });

  it('returns the dust internal transfer as an empty ChainTx', () => {
    expect(byId('0xaf8f4c93')).toEqual({
      txid: '0xaf8f4c939d3f158c2d0eaa57366325cd64e998fa4ca3cc6e5a7aa7794d122238',
      date: '2026-03-21', fee: 0, transfers: [],
    });
  });

  it('nets to the chain balance within rounding', () => {
    const total = txs.reduce((s, t) => s - t.fee + t.transfers.reduce((a, x) => a + x.amount, 0), 0);
    expect(total).toBe(21651);
  });

  it('keeps only the fee of a failed transaction', () => {
    expect(ethToChainTxs([ethTx({ value: '1000000000000000000', isError: '1', gasUsed: '21000' })], [], ADDR))
      .toEqual([{ txid: '0xsynthetic', date: '2026-09-18', fee: 2100, transfers: [] }]);
  });

  it('merges a swap payout from the internal list into our transaction', () => {
    const payout = ethTx({ from: ROUTER, to: ADDR, value: '500000000000000000', gasUsed: undefined, gasPrice: undefined });
    expect(ethToChainTxs([ethTx({})], [payout], ADDR)).toEqual([
      { txid: '0xsynthetic', date: '2026-09-18', fee: 10000, transfers: [{ counterparty: ROUTER, amount: 50000000 }] },
    ]);
  });

  it('nets a refund against what was sent', () => {
    const refund = ethTx({ from: ROUTER, to: ADDR, value: '100000000000000000', gasUsed: undefined, gasPrice: undefined });
    expect(ethToChainTxs([ethTx({ value: '1000000000000000000' })], [refund], ADDR)[0].transfers)
      .toEqual([{ counterparty: ROUTER, amount: -90000000 }]);
  });

  it('drops a refund that cancels what was sent', () => {
    const refund = ethTx({ from: ROUTER, to: ADDR, value: '1000000000000000000', gasUsed: undefined, gasPrice: undefined });
    expect(ethToChainTxs([ethTx({ value: '1000000000000000000' })], [refund], ADDR)[0].transfers).toEqual([]);
  });

  it('ignores a failed internal transfer and a transfer to itself', () => {
    const failed = ethTx({ hash: '0xi', from: ROUTER, to: ADDR, value: '1000000000000000000', isError: '1' });
    const self = ethTx({ hash: '0xs', to: ADDR, value: '1000000000000000000', gasUsed: '21000' });
    expect(ethToChainTxs([self], [failed], ADDR)).toEqual([
      { txid: '0xs', date: '2026-09-18', fee: 2100, transfers: [] },
      { txid: '0xi', date: '2026-09-18', fee: 0, transfers: [] },
    ]);
  });
});

describe('ethereumProvider.fetchNewTxs', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  const raw = (name: string) => fixture<unknown>(name);
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
  const empty = { status: '0', message: 'No transactions found', result: [] };
  const KEYED = 'https://api.etherscan.io/v2/api?chainid=1&apikey=test-key&';
  const HEAD = 26128000;
  /** Lists are read up to 12 blocks below the head. */
  const RANGE = `startblock=0&endblock=${HEAD - 12}`;
  const isHead = (url: string) => url.includes('module=block&action=getblocknobytime');
  /** Answers the head-block request itself and passes list requests to `lists`. */
  const api = (lists: (url: string) => unknown) => (url: string) =>
    ok(isHead(url) ? { status: '1', message: 'OK', result: String(HEAD) } : lists(url));
  const listUrls = () => fetchMock.mock.calls.map(c => c[0] as string).filter(u => !isHead(u));

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.ETHERSCAN_API_KEY = 'test-key';
    delete process.env.ETHEREUM_API_URL;
  });
  afterEach(() => {
    delete process.env.ETHERSCAN_API_KEY;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('is registered for ethereum, syncs ETH and USDT, and stores addresses lowercase', () => {
    expect(getProvider('ethereum')).toBe(ethereumProvider);
    expect(ethereumProvider.currencies).toEqual({ ETH: 8, USDT: 6 });
    expect(ethereumProvider.normalizeAddress!('0xF4f8d6fB5117CEc024d135d91C012636b814CC07')).toBe(ADDR);
  });

  it('asks for the head block first, then reads the USDT list of the official contract up to 12 blocks below it', async () => {
    fetchMock.mockImplementation(api(() => raw('eth-usdt-0xf4f8.json')));
    const txs = await ethereumProvider.fetchNewTxs(ADDR, 'USDT', new Set());
    expect(fetchMock.mock.calls[0][0]).toMatch(
      /^https:\/\/api\.etherscan\.io\/v2\/api\?chainid=1&apikey=test-key&module=block&action=getblocknobytime&timestamp=\d+&closest=before$/
    );
    expect(listUrls()).toEqual([
      `${KEYED}module=account&address=${ADDR}&action=tokentx&contractaddress=${USDT_CONTRACT}&${RANGE}&sort=desc&page=1&offset=1000`,
    ]);
    expect(txs).toHaveLength(20);
    expect(txs[0].txid.startsWith('0x5e5a9762')).toBe(true);
  });

  it('reads the normal and internal lists for ETH, lowercasing the address', async () => {
    fetchMock.mockImplementation(api(url =>
      raw(url.includes('action=txlistinternal') ? 'eth-internal-0xf4f8.json' : 'eth-txlist-0xf4f8.json')));
    const txs = await ethereumProvider.fetchNewTxs('0xF4f8d6fB5117CEc024d135d91C012636b814CC07', 'ETH', new Set());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(listUrls()).toEqual([
      `${KEYED}module=account&address=${ADDR}&action=txlist&${RANGE}&sort=desc&page=1&offset=1000`,
      `${KEYED}module=account&address=${ADDR}&action=txlistinternal&${RANGE}&sort=desc&page=1&offset=1000`,
    ]);
    expect(txs).toHaveLength(33);
  });

  it('skips known hashes in both lists', async () => {
    fetchMock.mockImplementation(api(url =>
      raw(url.includes('action=txlistinternal') ? 'eth-internal-0xf4f8.json' : 'eth-txlist-0xf4f8.json')));
    const known = new Set([...normal.slice(0, 30), ...internal].map(r => r.hash));
    const txs = await ethereumProvider.fetchNewTxs(ADDR, 'ETH', known);
    expect(txs.map(t => t.txid)).toEqual(normal.slice(30).map(r => r.hash));
  });

  it.each([
    ['Etherscan', 'No transactions found'],
    ['Blockscout internal', 'No internal transactions found'],
    ['Blockscout token', 'No token transfers found'],
  ])('reads an empty %s answer as an empty list', async (_api, message) => {
    fetchMock.mockImplementation(api(() => ({ status: '0', message, result: [] })));
    await expect(ethereumProvider.fetchNewTxs(ADDR, 'ETH', new Set())).resolves.toEqual([]);
    expect(listUrls()).toHaveLength(2);
  });

  const fullPage = (prefix: string) => ({
    status: '1', message: 'OK',
    result: Array.from({ length: 1000 }, (_, i) => ({ ...normal[0], hash: `${prefix}${i}` })),
  });

  it('pages on while a full page has something new, keeping the same block range', async () => {
    fetchMock.mockImplementation(api(url => (url.includes('page=1&') ? fullPage('0xnew') : raw('eth-usdt-0xf4f8.json'))));
    const txs = await ethereumProvider.fetchNewTxs(ADDR, 'USDT', new Set());
    expect(listUrls()).toEqual([
      expect.stringContaining(`&${RANGE}&sort=desc&page=1&offset=1000`),
      expect.stringContaining(`&${RANGE}&sort=desc&page=2&offset=1000`),
    ]);
    expect(txs).toHaveLength(1020);
  });

  it('stops at a full page with nothing new', async () => {
    const page = fullPage('0xold');
    fetchMock.mockImplementation(api(() => page));
    await ethereumProvider.fetchNewTxs(ADDR, 'USDT', new Set(page.result.map(r => r.hash)));
    expect(listUrls()).toHaveLength(1);
  });

  it('uses Blockscout without a key, spacing requests a second apart', async () => {
    delete process.env.ETHERSCAN_API_KEY;
    const at: number[] = [];
    const answer = api(() => empty);
    fetchMock.mockImplementation((url: string) => {
      at.push(Date.now());
      return answer(url);
    });
    await ethereumProvider.fetchNewTxs(ADDR, 'ETH', new Set());
    expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/eth\.blockscout\.com\/api\?module=block&action=getblocknobytime&/);
    expect(listUrls()[0]).toBe(
      `https://eth.blockscout.com/api?module=account&address=${ADDR}&action=txlist&${RANGE}&sort=desc&page=1&offset=1000`
    );
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(1000);
  });

  it('uses ETHEREUM_API_URL without a key', async () => {
    delete process.env.ETHERSCAN_API_KEY;
    process.env.ETHEREUM_API_URL = 'https://eth.test/api';
    fetchMock.mockImplementation(api(() => empty));
    try {
      await ethereumProvider.fetchNewTxs(ADDR, 'USDT', new Set());
      expect(listUrls()[0]).toMatch(/^https:\/\/eth\.test\/api\?module=account&/);
    } finally {
      delete process.env.ETHEREUM_API_URL;
    }
  });

  it('spaces keyed requests at least 450 ms apart (Etherscan free tier: 3/s)', async () => {
    const at: number[] = [];
    const answer = api(() => empty);
    fetchMock.mockImplementation((url: string) => {
      at.push(Date.now());
      return answer(url);
    });
    await ethereumProvider.fetchNewTxs(ADDR, 'ETH', new Set());
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(450);
  });

  it.each(['0x123', 'f4f8d6fb5117cec024d135d91c012636b814cc07', 'TPJe9tgEJFsgVTQ4gLjzRTCrQ6pRJYc1aS'])(
    'refuses %s without asking the API', async address => {
      await expect(ethereumProvider.fetchNewTxs(address, 'ETH', new Set()))
        .rejects.toEqual({ statusCode: 400, message: 'Invalid address' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  const unavailable = { statusCode: 502, message: 'Blockchain API unavailable' };

  it.each([
    ['Blockscout status 2', { status: '2', message: 'Some internal transactions within this block range have not yet been processed', result: [] }],
    ['NOTOK', { status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (5/sec)' }],
    ['Blockscout rate limit', { status: '0', message: 'Too many requests. Increase limits now at https://dev.blockscout.com', result: null }],
    ['result window', { status: '0', message: 'Result window is too large, PageNo x Offset size must be less than or equal to 10000', result: null }],
  ])('maps %s to 502', async (_name, body) => {
    fetchMock.mockImplementation(api(() => body));
    await expect(ethereumProvider.fetchNewTxs(ADDR, 'ETH', new Set())).rejects.toEqual(unavailable);
  });

  it('maps a failed head-block request to 502 without reading any list', async () => {
    fetchMock.mockImplementation(() => ok({ status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (3/sec)' }));
    await expect(ethereumProvider.fetchNewTxs(ADDR, 'ETH', new Set())).rejects.toEqual(unavailable);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500])('maps HTTP %i to 502', async status => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status, json: async () => ({}) } as Response));
    await expect(ethereumProvider.fetchNewTxs(ADDR, 'USDT', new Set())).rejects.toEqual(unavailable);
  });

  it('maps a body that is not JSON to 502', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); },
    } as unknown as Response));
    await expect(ethereumProvider.fetchNewTxs(ADDR, 'USDT', new Set())).rejects.toEqual(unavailable);
  });

  it('maps a network error to 502', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(ethereumProvider.fetchNewTxs(ADDR, 'ETH', new Set())).rejects.toEqual(unavailable);
  });
});
