import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PageReload } from './page-reload';

const first = vi.fn();
const second = vi.fn();

@Component({ template: '' })
class FirstPage {
  constructor() {
    inject(PageReload).register('Reload first', first);
  }
}

@Component({ template: '' })
class SecondPage {
  constructor() {
    inject(PageReload).register('Reload second', second);
  }
}

describe('PageReload', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    first.mockReset();
    second.mockReset();
  });

  it('runs the reload of the page on screen and forgets it once destroyed', () => {
    const pageReload = TestBed.inject(PageReload);
    const page = TestBed.createComponent(FirstPage);
    expect(pageReload.hint()).toBe('Reload first');
    pageReload.reload();
    expect(first).toHaveBeenCalledOnce();

    page.destroy();
    expect(pageReload.hint()).toBeNull();
    pageReload.reload();
    expect(first).toHaveBeenCalledOnce();
  });

  it('keeps the next page when the previous one is destroyed after it registered', () => {
    const pageReload = TestBed.inject(PageReload);
    const previous = TestBed.createComponent(FirstPage);
    TestBed.createComponent(SecondPage);
    previous.destroy();
    expect(pageReload.hint()).toBe('Reload second');
    pageReload.reload();
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });
});
