// jsdom in the Vitest unit-test runner does not provide `localStorage` by
// default on newer Node versions. Polyfill it with an in-memory implementation
// so services that read/write localStorage (e.g. AuthService) work under test.
if (typeof globalThis.localStorage === 'undefined') {
  class MemoryStorage implements Storage {
    private store = new Map<string, string>();

    get length(): number {
      return this.store.size;
    }

    clear(): void {
      this.store.clear();
    }

    getItem(key: string): string | null {
      return this.store.has(key) ? this.store.get(key)! : null;
    }

    key(index: number): string | null {
      return Array.from(this.store.keys())[index] ?? null;
    }

    removeItem(key: string): void {
      this.store.delete(key);
    }

    setItem(key: string, value: string): void {
      this.store.set(key, String(value));
    }
  }

  globalThis.localStorage = new MemoryStorage();
}

// Known issue, pre-existing and not caused by any one spec: with enough specs
// that instantiate components through TestBed, some runs fail with
// "The service 'FetchBackend' needs to be compiled using the JIT compiler,
// but '@angular/compiler' is not available" — and the suite it lands on
// varies between runs.
//
// It reproduces on a clean checkout by duplicating account-form.spec.ts three
// times, with no other changes, so it is a builder/runner initialization
// order problem rather than anything in a particular test. Importing
// '@angular/compiler' here does not fix it: the unit-test builder initializes
// TestBed before setupFiles run. providersFile and a single-fork vitest
// config were both tried and did not help either.
//
// Every spec passes when run on its own (`ng test --include=<path>`), which
// is the workaround until the builder is updated.
