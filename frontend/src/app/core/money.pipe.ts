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

@Pipe({ name: 'money' })
export class MoneyPipe implements PipeTransform {
  private readonly locale = inject(LOCALE_ID);

  transform(value: number | null | undefined, currency?: string | null, scale = 2): string {
    if (value == null) return '';

    const digits = { minimumFractionDigits: scale, maximumFractionDigits: scale };
    if (!currency) return new Intl.NumberFormat(this.locale, digits).format(value);

    try {
      return new Intl.NumberFormat(this.locale, {
        style: 'currency',
        currency,
        currencyDisplay: this.display(currency),
        ...digits,
      }).format(value);
    } catch {
      // Intl throws RangeError on codes that are not well-formed ISO 4217.
      return `${currency} ${new Intl.NumberFormat(this.locale, digits).format(value)}`;
    }
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
