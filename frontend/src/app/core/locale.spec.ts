import { resolveLocale } from './locale';

type LocaleGlobal = { ng?: { common?: { locales?: Record<string, unknown> } } };

// The loader fetches locale data with a <script> tag, which jsdom never
// actually loads, so stub the element: a locale in `available` registers itself
// the way the real global/* build does, the rest fail like a 404. That covers
// the candidate order and fallback here; the real fetch has to be verified in a
// browser, since the asset path only exists in a served build.
//
// `serving` mimics a host that answers an unknown path with index.html: the
// script "loads" with 200 but registers nothing.
function stubLocaleScripts(
  available: string[],
  options: { serving?: string[] } = {},
): { requested: string[]; restore: () => void } {
  const requested: string[] = [];
  const create = document.createElement.bind(document);
  const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = create(tag as 'script');
    if (tag !== 'script') return el;
    Object.defineProperty(el, 'src', {
      set(value: string) {
        const locale = value.replace(/^.*\/locales\//, '').replace(/\.js$/, '');
        requested.push(locale);
        queueMicrotask(() => {
          if (available.includes(locale)) {
            const g = globalThis as LocaleGlobal;
            g.ng ??= {};
            g.ng.common ??= {};
            g.ng.common.locales ??= {};
            g.ng.common.locales[locale.toLowerCase()] = [locale];
          }
          const served = available.includes(locale) || options.serving?.includes(locale);
          served
            ? (el as HTMLScriptElement).onload?.(new Event('load'))
            : (el as HTMLScriptElement).onerror?.(new Event('error'));
        });
      },
      get: () => '',
      configurable: true,
    });
    return el;
  });
  return { requested, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  // Each test starts with an empty registry, so a previous one cannot satisfy it.
  // Clear only the registry, not all of `ng`: it also holds the JIT compiler
  // facade, and the unit-test builder runs spec files in a shared worker
  // (isolate: false), so deleting it breaks whichever spec loads Angular next
  // with "FetchBackend needs to be compiled using the JIT compiler".
  delete (globalThis as LocaleGlobal).ng?.common?.locales;
});

describe('resolveLocale', () => {
  it('keeps a locale Angular ships data for', async () => {
    const { restore } = stubLocaleScripts(['de']);
    expect(await resolveLocale('de')).toBe('de');
    restore();
  });

  it('falls back to the base language for a region variant', async () => {
    // navigator.language reports "ru-RU", but @angular/common ships only "ru".
    const { requested, restore } = stubLocaleScripts(['ru']);
    expect(await resolveLocale('ru-RU')).toBe('ru');
    expect(requested).toEqual(['ru-RU', 'ru']);
    restore();
  });

  it('prefers a region variant that ships its own data', async () => {
    const { requested, restore } = stubLocaleScripts(['en-GB', 'en']);
    expect(await resolveLocale('en-GB')).toBe('en-GB');
    // Stops at the first hit rather than also loading the base language.
    expect(requested).toEqual(['en-GB']);
    restore();
  });

  it('asks only once when the tag has no region', async () => {
    const { requested, restore } = stubLocaleScripts(['ru']);
    await resolveLocale('ru');
    expect(requested).toEqual(['ru']);
    restore();
  });

  it('falls back to en-US for an unknown locale', async () => {
    const { requested, restore } = stubLocaleScripts([]);
    expect(await resolveLocale('zz-ZZ')).toBe('en-US');
    expect(requested).toEqual(['zz-ZZ', 'zz']);
    restore();
  });

  it('does not accept a script that loaded but registered nothing', async () => {
    // A dev server whose assets are stale answers /locales/ru.js with
    // index.html and a 200, so onload fires for a file that is not there.
    const { restore } = stubLocaleScripts([], { serving: ['ru'] });
    expect(await resolveLocale('ru')).toBe('en-US');
    restore();
  });
});
