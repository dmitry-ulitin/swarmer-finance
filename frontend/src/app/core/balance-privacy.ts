import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'balancesHidden';

/** Whether account balances are blurred, remembered per browser so a reload does not reveal them. */
@Injectable({ providedIn: 'root' })
export class BalancePrivacy {
  readonly hidden = signal(readStored());

  toggle(): void {
    const next = !this.hidden();
    this.hidden.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Storage blocked: the choice lasts until the page is reloaded.
    }
  }
}

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}
