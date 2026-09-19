import { bootstrapApplication } from '@angular/platform-browser';
import { LOCALE_ID } from '@angular/core';
import { appConfig } from './app/app.config';
import { resolveLocale } from './app/core/locale';
import { App } from './app/app';

// The locale data has to be registered before the app bootstraps, so LOCALE_ID
// is provided here rather than in appConfig.
resolveLocale()
  .then((locale) => {
    document.documentElement.lang = locale;
    return bootstrapApplication(App, {
      ...appConfig,
      providers: [...appConfig.providers, { provide: LOCALE_ID, useValue: locale }],
    });
  })
  .catch((err) => console.error(err));
