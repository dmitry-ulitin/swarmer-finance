import { inject, LOCALE_ID, Pipe, PipeTransform } from '@angular/core';

// Angular's CurrencyPipe resolves symbols from CURRENCIES_EN, whose entries are
// [symbol, symbolNarrow, digits]. Currencies like RUB are stored as
// [undefined, "₽"], so under en-US 'symbol' falls back to the ISO code and only
// 'symbol-narrow' yields ₽. Intl's 'narrowSymbol' covers far more currencies
// (₾ ₸ ֏ ₺ ₴ zł Kč ฿ ₦ ₼ …), so we prefer it.
//
// But narrow symbols are not unique: AUD/CAD/MXN all narrow to a bare "$" and
// CNY to "¥", which in a multi-currency list is indistinguishable from USD and
// JPY. Where the wide symbol disambiguates (A$, CA$, MX$, CN¥) we keep it.
const AMBIGUOUS_NARROW = /^[$¥£元]+$/u;

// Crypto is not in ISO 4217, so Intl either rejects the code outright (USDT,
// USDC and anything else over three letters) or accepts it with no symbol in
// CLDR (BTC, ETH render as bare letters). Only unambiguous glyphs go here:
// USDC would otherwise have to share ₮ with USDT, the same collision the wide
// symbols above exist to avoid, so it keeps its letters.
const CRYPTO_SYMBOLS: Record<string, string> = {
  BTC: '₿',
  ETH: 'Ξ',
  USDT: '₮',
};

@Pipe({ name: 'money' })
export class MoneyPipe implements PipeTransform {
  private readonly locale = inject(LOCALE_ID);

  transform(value: number | null | undefined, currency?: string | null, scale = 2): string {
    if (value == null) return '';

    const digits = { minimumFractionDigits: scale, maximumFractionDigits: scale };
    if (!currency) return new Intl.NumberFormat(this.locale, digits).format(value);

    const code = currency.toUpperCase();
    const symbol = CRYPTO_SYMBOLS[code];
    if (symbol) return this.withSymbol(value, symbol, digits);

    try {
      return new Intl.NumberFormat(this.locale, {
        style: 'currency',
        currency,
        currencyDisplay: this.display(currency),
        ...digits,
      }).format(value);
    } catch {
      // Intl only accepts three ASCII letters, so anything else — a longer
      // ticker like USDC, or a typo — lands here. Still format it as money so
      // it lines up with the other rows.
      return this.withSymbol(value, currency, digits);
    }
  }

  // Formats through a currency Intl does know, then swaps the symbol out. That
  // keeps the locale's own layout: "$1,234.50" but "1 234,50 ₽", including the
  // space a letter code needs and a symbol does not.
  private withSymbol(value: number, symbol: string, digits: Intl.NumberFormatOptions): string {
    // A stand-in whose shape matches: symbol-like for a glyph (USD → "$"),
    // letter-like for a ticker (BTC → "BTC "), which differ in spacing.
    const template = /^[A-Za-z]+$/.test(symbol) ? 'BTC' : 'USD';
    return new Intl.NumberFormat(this.locale, {
      style: 'currency',
      currency: template,
      currencyDisplay: 'narrowSymbol',
      ...digits,
    })
      .formatToParts(value)
      .map((part) => (part.type === 'currency' ? symbol : part.value))
      .join('');
  }

  // Use the wide symbol when the narrow one is a shared glyph that the wide one
  // qualifies (CNY: ¥ → CN¥), but not when the wide form is just the ISO code
  // (RUB: ₽ → RUB), which would defeat the point. Both forms are locale-
  // dependent, so this is re-evaluated per locale rather than hardcoded.
  private display(currency: string): 'symbol' | 'narrowSymbol' {
    const narrow = this.symbolOf(currency, 'narrowSymbol');
    if (!AMBIGUOUS_NARROW.test(narrow)) return 'narrowSymbol';
    return this.symbolOf(currency, 'symbol') === currency ? 'narrowSymbol' : 'symbol';
  }

  private symbolOf(currency: string, display: 'symbol' | 'narrowSymbol'): string {
    return new Intl.NumberFormat(this.locale, { style: 'currency', currency, currencyDisplay: display })
      .formatToParts(1)
      .filter(p => p.type === 'currency')
      .map(p => p.value)
      .join('');
  }
}
