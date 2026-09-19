const FRANKFURTER_BASE_URL = process.env.FRANKFURTER_BASE_URL || 'https://api.frankfurter.dev/v1';
const FRANKFURTER_TIMEOUT_MS = 5000;

// Fetches `from`->`to` from Frankfurter (ECB reference rates: fiat only).
// Returns null when Frankfurter does not cover the pair — it answers 404 for
// an unknown base and simply omits an unknown symbol from `rates` — so the
// caller can try the next provider. Throws when the pair looks supported but
// the request itself failed.
export async function fetchRate(
  from: string,
  to: string
): Promise<{ rate: number; asOf: string } | null> {
  const res = await fetch(`${FRANKFURTER_BASE_URL}/latest?base=${from}&symbols=${to}`, {
    signal: AbortSignal.timeout(FRANKFURTER_TIMEOUT_MS),
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Frankfurter request failed: ${res.status}`);
  }

  const body = (await res.json()) as { date: string; rates: Record<string, number> };
  const rate = body.rates?.[to];
  if (typeof rate !== 'number') return null;

  return { rate, asOf: body.date };
}
