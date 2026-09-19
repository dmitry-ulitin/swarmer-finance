// Angular's DatePipe reads CLDR data that only ships for en-US by default and
// throws RuntimeError 701 for any other locale. Intl (used by MoneyPipe) needs
// no such data, but DatePipe does — so the data has to be registered before the
// app bootstraps, for a locale only known at runtime.
//
// The data is fetched as a plain script rather than imported. A dynamic import
// with a variable cannot be a bare specifier (the bundler leaves it unresolved
// and the browser cannot load it), and making it a relative path into
// node_modules makes esbuild bundle all ~750 locales and inline a 2240-entry
// import map into main.js. The global/* builds self-register onto globalThis,
// so a single <script> costs nothing until it is actually needed.
//
// @angular/common ships base languages ("ru", "de") but not every region
// variant ("ru-RU" does not exist), while navigator.language usually returns
// the region form. So try the full tag first (en-GB and es-MX do ship their
// own data), then the base language, and fall back to en-US, whose data is
// built in. A missing region variant costs one 404 before that fallback, which
// is cheaper than shipping a manifest of all 742 locales to every user.
export async function resolveLocale(requested = navigator.language): Promise<string> {
  const base = requested.split('-')[0];
  const candidates = requested === base ? [base] : [requested, base];

  for (const candidate of candidates) {
    if (await loadLocaleData(candidate)) return candidate;
  }

  // Reached when the browser asks for a locale Angular has no data for — but
  // also when the data simply could not be fetched, so name the URLs that were
  // tried rather than blaming the locale.
  if (base !== 'en') {
    const tried = candidates.map((c) => localeUrl(c)).join(', ');
    console.warn(`No locale data for "${requested}" (tried ${tried}); using en-US.`);
  }
  return 'en-US';
}

// Resolved against <base href> rather than the current URL, so a deep link
// like /transactions does not ask for /transactions/locales/ru.js.
function localeUrl(locale: string): string {
  return new URL(`locales/${locale}.js`, document.baseURI).href;
}

// The global/* builds register themselves under globalThis.ng.common.locales,
// so check for the entry rather than trusting onload: a dev server or SPA host
// that answers an unknown path with index.html can return 200 for a file that
// is not there, and the script would then "load" without registering anything.
function isRegistered(locale: string): boolean {
  const locales = (globalThis as { ng?: { common?: { locales?: Record<string, unknown> } } }).ng
    ?.common?.locales;
  return !!locales?.[locale.toLowerCase()];
}

function loadLocaleData(locale: string): Promise<boolean> {
  if (isRegistered(locale)) return Promise.resolve(true);

  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = localeUrl(locale);
    script.onload = () => resolve(isRegistered(locale));
    script.onerror = () => {
      script.remove();
      resolve(false);
    };
    document.head.appendChild(script);
  });
}
