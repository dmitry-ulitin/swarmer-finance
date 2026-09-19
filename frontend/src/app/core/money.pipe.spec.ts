import { LOCALE_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MoneyPipe } from './money.pipe';

// The pipe injects LOCALE_ID, so it has to be built in an injection context.
function pipeFor(locale?: string): MoneyPipe {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [MoneyPipe, ...(locale ? [{ provide: LOCALE_ID, useValue: locale }] : [])],
  });
  return TestBed.inject(MoneyPipe);
}

describe('MoneyPipe', () => {
  // Angular's default LOCALE_ID when the app provides none.
  const pipe = () => pipeFor();

  it('uses the narrow symbol for currencies en-US has no wide symbol for', () => {
    expect(pipe().transform(1234.5, 'RUB', 2)).toBe('₽1,234.50');
    expect(pipe().transform(1234.5, 'GEL', 2)).toBe('₾1,234.50');
    expect(pipe().transform(1234.5, 'KZT', 2)).toBe('₸1,234.50');
    expect(pipe().transform(1234.5, 'AMD', 2)).toBe('֏1,234.50');
    expect(pipe().transform(1234.5, 'TRY', 2)).toBe('₺1,234.50');
  });

  it('keeps the wide symbol where the narrow one is an ambiguous glyph', () => {
    expect(pipe().transform(1234.5, 'CNY', 2)).toBe('CN¥1,234.50');
    expect(pipe().transform(1234.5, 'AUD', 2)).toBe('A$1,234.50');
    expect(pipe().transform(1234.5, 'CAD', 2)).toBe('CA$1,234.50');
    expect(pipe().transform(1234.5, 'MXN', 2)).toBe('MX$1,234.50');
  });

  it('still narrows an ambiguous glyph whose wide form is only the ISO code', () => {
    // JPY narrows to ¥ and has no qualifying wide symbol, so ¥ is the best available.
    expect(pipe().transform(1234, 'JPY', 0)).toBe('¥1,234');
  });

  it('formats common currencies as before', () => {
    expect(pipe().transform(1234.5, 'USD', 2)).toBe('$1,234.50');
    expect(pipe().transform(1234.5, 'EUR', 2)).toBe('€1,234.50');
  });

  it('honours the scale argument', () => {
    expect(pipe().transform(1234.5, 'USD', 0)).toBe('$1,235');
    expect(pipe().transform(1234.5678, 'BTC', 4)).toBe('₿1,234.5678');
  });

  it('falls back to a scale of 2 when none is given', () => {
    expect(pipe().transform(1234.5, 'USD')).toBe('$1,234.50');
  });

  it('renders a plain number when the currency is unknown', () => {
    // `auth.user()?.currency` is undefined until the profile resolves.
    expect(pipe().transform(1234.5, undefined, 2)).toBe('1,234.50');
    expect(pipe().transform(1234.5, '', 2)).toBe('1,234.50');
  });

  it('returns an empty string for a missing amount', () => {
    expect(pipe().transform(null, 'USD', 2)).toBe('');
    expect(pipe().transform(undefined, 'USD', 2)).toBe('');
  });

  describe('currencies Intl does not know', () => {
    it('gives the known crypto symbols', () => {
      // USDT is not ISO 4217 at all; BTC and ETH are well-formed but have no
      // symbol in CLDR, so Intl renders them as bare letters.
      expect(pipe().transform(1234.5, 'USDT', 2)).toBe('₮1,234.50');
      expect(pipe().transform(1234.5, 'BTC', 2)).toBe('₿1,234.50');
      expect(pipe().transform(1234.5, 'ETH', 2)).toBe('Ξ1,234.50');
    });

    it('formats an unknown code with the locale grouping, not as a raw number', () => {
      // A 4-letter code makes Intl throw, but the amount must still read as
      // money — with a space, since a letter code is not a symbol.
      expect(pipe().transform(1234.5, 'USDC', 2)).toBe('USDC 1,234.50');
    });

    it('leaves an ambiguous code as letters rather than reusing a symbol', () => {
      // ₮ already stands for USDT here, so USDC must not get it too.
      expect(pipe().transform(1234.5, 'USDC', 2)).not.toContain('₮');
    });

    it('applies crypto symbols under any locale', () => {
      // ru groups with a NBSP and puts the symbol last, after another NBSP.
      expect(pipeFor('ru').transform(1234.5, 'USDT', 2)).toBe('1\u00a0234,50\u00a0₮');
      expect(pipeFor('ru').transform(1234.5, 'USDC', 2)).toBe('1\u00a0234,50\u00a0USDC');
    });

    it('honours the scale for crypto amounts', () => {
      expect(pipe().transform(1.23456789, 'BTC', 8)).toBe('₿1.23456789');
    });
  });

  describe('LOCALE_ID', () => {
    it('formats numbers with the provided locale', () => {
      // de-DE swaps the grouping and decimal separators and trails the symbol.
      expect(pipeFor('de-DE').transform(1234.5, 'EUR', 2)).toBe('1.234,50 €');
    });

    it('still resolves the narrow symbol under a non-en locale', () => {
      expect(pipeFor('de-DE').transform(1234.5, 'RUB', 2)).toBe('1.234,50 ₽');
    });

    it('keeps a narrow symbol whose wide form is the ISO code in that locale', () => {
      // Under ka-GE, CNY's wide form is the bare code, so ¥ must be kept.
      expect(pipeFor('ka-GE').transform(1234.5, 'CNY', 2)).toContain('¥');
      expect(pipeFor('ka-GE').transform(1234.5, 'CNY', 2)).not.toContain('CNY');
    });
  });
});
