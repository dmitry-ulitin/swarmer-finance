import * as fs from 'fs';
import * as path from 'path';
import { generateKeyPairSync } from 'crypto';
import jwt from 'jsonwebtoken';
import {
  BankAccessError,
  EbCredentials,
  fetchTransactions,
  getAspsps,
  makeJwt,
} from '../services/bank/client';

const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'enablebanking', name), 'utf8'));

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const cred: EbCredentials = { applicationId: 'app-123', privateKey };

describe('Enable Banking client', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  const respond = (status: number, body: unknown) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('signs an RS256 JWT with the application id as kid', () => {
    const token = makeJwt(cred, 1000);
    const payload = jwt.verify(token, publicKey, { algorithms: ['RS256'], clockTimestamp: 1000 }) as jwt.JwtPayload;
    expect(payload).toMatchObject({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: 1000, exp: 4600 });
    const header = jwt.decode(token, { complete: true })!.header;
    expect(header.kid).toBe('app-123');
    expect(header.typ).toBe('JWT');
  });

  it('lists banks of a country', async () => {
    fetchMock.mockReturnValueOnce(respond(200, fixture('aspsps-ee.json')));
    const banks = await getAspsps(cred, 'EE');
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/aspsps\?country=EE$/);
    expect(banks.map((b) => b.name)).toContain('LHV Pank');
  });

  it('follows continuation_key', async () => {
    const p1 = fixture('transactions-page1.json');
    const p2 = fixture('transactions-page2.json');
    fetchMock.mockReturnValueOnce(respond(200, p1)).mockReturnValueOnce(respond(200, p2));
    const rows = await fetchTransactions(cred, 'uid-1', '2027-01-01', '2027-01-31', {
      ip: '203.0.113.5',
      userAgent: 'TestAgent/1.0',
    });
    expect(rows).toHaveLength(p1.transactions.length + p2.transactions.length);
    expect(fetchMock.mock.calls[0][0]).not.toContain('continuation_key');
    expect(fetchMock.mock.calls[1][0]).toContain('continuation_key=k2');
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers['Psu-User-Agent']).toBe('TestAgent/1.0');
      expect(call[1].headers['Psu-Ip-Address']).toBe('203.0.113.5');
    }
  });

  it('maps 401 on transactions to BankAccessError', async () => {
    fetchMock.mockReturnValueOnce(respond(401, { message: 'expired' }));
    await expect(fetchTransactions(cred, 'u', '2027-01-01', '2027-01-31', {})).rejects.toBeInstanceOf(
      BankAccessError
    );
  });

  it('maps 500 to 502', async () => {
    fetchMock.mockReturnValueOnce(respond(500, {}));
    await expect(fetchTransactions(cred, 'u', '2027-01-01', '2027-01-31', {})).rejects.toEqual({
      statusCode: 502,
      message: 'Bank API unavailable',
    });
  });

  it('passes the Enable Banking message on other errors', async () => {
    fetchMock.mockReturnValueOnce(respond(403, { message: 'Application is not active' }));
    const err = await getAspsps(cred, 'EE').catch((e) => e);
    expect(err).toEqual({ statusCode: 400, message: 'Enable Banking: Application is not active' });
    expect(JSON.stringify(err)).not.toContain('Bearer');
  });
});
