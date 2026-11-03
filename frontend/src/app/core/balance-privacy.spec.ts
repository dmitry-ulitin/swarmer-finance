import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BalancePrivacy } from './balance-privacy';

describe('BalancePrivacy', () => {
  beforeEach(() => localStorage.removeItem('balancesHidden'));

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem('balancesHidden');
  });

  it('shows balances by default', () => {
    expect(TestBed.inject(BalancePrivacy).hidden()).toBe(false);
  });

  it('toggles and remembers the choice', () => {
    const privacy = TestBed.inject(BalancePrivacy);

    privacy.toggle();
    expect(privacy.hidden()).toBe(true);
    expect(localStorage.getItem('balancesHidden')).toBe('true');

    privacy.toggle();
    expect(privacy.hidden()).toBe(false);
    expect(localStorage.getItem('balancesHidden')).toBe('false');
  });

  it('restores a hidden state saved earlier', () => {
    localStorage.setItem('balancesHidden', 'true');
    expect(TestBed.inject(BalancePrivacy).hidden()).toBe(true);
  });

  it('keeps working when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    const privacy = TestBed.inject(BalancePrivacy);
    expect(privacy.hidden()).toBe(false);

    privacy.toggle();
    expect(privacy.hidden()).toBe(true);
  });
});
