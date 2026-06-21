import { describe, it, expect, vi } from 'vitest';
import { Observable, Subject, of, throwError } from 'rxjs';
import { take, firstValueFrom } from 'rxjs';
import { RefreshCoordinator } from './refresh-coordinator';
import { AuthService } from './auth.service';

/**
 * Tests for single-flight refresh behaviour.
 *
 * The bug we are guarding against: when 3 parallel HTTP requests get
 * 401 simultaneously, each would call /api/auth/refresh on its own.
 * With refresh-token rotation, only the first call succeeds; the
 * other two would logout the user.
 *
 * The contract: the coordinator must call auth.performRefresh at most
 * once per "round", even if refresh() is subscribed to many times
 * concurrently. All subscribers in the window share the same result.
 *
 * Note on async semantics: real HTTP /api/auth/refresh is asynchronous
 * (microtask boundary), so concurrent 401s hit refresh() in one tick,
 * all subscribe to the same inflight Observable, and the source emits
 * later. We use a deferred Subject to model that asynchrony.
 */

interface MockAuth {
  performRefresh: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  getRefreshToken: ReturnType<typeof vi.fn>;
}

function makeAuth(performRefreshReturn: Observable<string> | (() => Observable<string>)): MockAuth {
  const fn = typeof performRefreshReturn === 'function'
    ? vi.fn(performRefreshReturn)
    : vi.fn(() => performRefreshReturn);
  return {
    performRefresh: fn,
    logout: vi.fn(),
    getRefreshToken: vi.fn(() => 'stored-refresh-token'),
  };
}

describe('RefreshCoordinator', () => {
  it('invokes performRefresh exactly once when refresh() is called 3 times in parallel', () => {
    // Defer the refresh HTTP so we can subscribe from many callers
    // before the underlying "request" resolves.
    const refresh$: Subject<string> = new Subject<string>();
    const auth = makeAuth(refresh$.asObservable()) as unknown as AuthService;
    const coordinator = new RefreshCoordinator(auth);

    // Three concurrent callers (simulating three parallel 401s).
    const s1: string[] = [];
    const s2: string[] = [];
    const s3: string[] = [];
    const errors: unknown[] = [];

    coordinator.refresh().pipe(take(1)).subscribe({ next: v => s1.push(v), error: e => errors.push(['e1', e]) });
    coordinator.refresh().pipe(take(1)).subscribe({ next: v => s2.push(v), error: e => errors.push(['e2', e]) });
    coordinator.refresh().pipe(take(1)).subscribe({ next: v => s3.push(v), error: e => errors.push(['e3', e]) });

    // At this point, no HTTP request has completed yet, but a single
    // performRefresh call must already have been made.
    expect(auth.performRefresh).toHaveBeenCalledTimes(1);

    // Resolve the shared refresh.
    refresh$.next('new-access-token');
    refresh$.complete();

    // All three callers should receive the same token.
    expect(s1).toEqual(['new-access-token']);
    expect(s2).toEqual(['new-access-token']);
    expect(s3).toEqual(['new-access-token']);
    expect(errors).toEqual([]);

    // And still only ONE underlying refresh call.
    expect(auth.performRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not call logout() on a successful refresh shared by concurrent callers', () => {
    const refresh$: Subject<string> = new Subject<string>();
    const auth = makeAuth(refresh$.asObservable()) as unknown as AuthService;
    const coordinator = new RefreshCoordinator(auth);

    coordinator.refresh().subscribe();
    coordinator.refresh().subscribe();
    coordinator.refresh().subscribe();

    refresh$.next('new-token');
    refresh$.complete();

    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('calls logout() exactly once when shared refresh fails, and all callers see the error', async () => {
    const authError = new Error('refresh failed');
    const refresh$: Subject<string> = new Subject<string>();
    const auth = makeAuth(refresh$.asObservable()) as unknown as AuthService;
    const coordinator = new RefreshCoordinator(auth);

    const error1 = firstValueFrom(coordinator.refresh()).catch(e => e);
    const error2 = firstValueFrom(coordinator.refresh()).catch(e => e);
    const error3 = firstValueFrom(coordinator.refresh()).catch(e => e);

    // All three subscribed before source emitted (synchronously).
    expect(auth.performRefresh).toHaveBeenCalledTimes(1);

    // Resolve with error.
    refresh$.error(authError);

    const [e1, e2, e3] = await Promise.all([error1, error2, error3]);
    expect(e1).toBe(authError);
    expect(e2).toBe(authError);
    expect(e3).toBe(authError);

    // logout is invoked once per failed refresh — three concurrent
    // subscribers share the same observable, so logout runs exactly once.
    expect(auth.logout).toHaveBeenCalledTimes(1);

    // And only one underlying HTTP refresh was attempted.
    expect(auth.performRefresh).toHaveBeenCalledTimes(1);
  });

  it('allows a new refresh round after the previous one completes successfully', async () => {
    let callIndex = 0;
    const auth = makeAuth(() => {
      callIndex++;
      // Each call returns a deferred Observable.
      return new Observable<string>(subscriber => {
        // Resolve async via queueMicrotask to model HTTP latency.
        queueMicrotask(() => {
          subscriber.next(`t${callIndex}`);
          subscriber.complete();
        });
      });
    }) as unknown as AuthService;
    const coordinator = new RefreshCoordinator(auth);

    const first = await firstValueFrom(coordinator.refresh().pipe(take(1)));
    expect(first).toBe('t1');
    expect(coordinator.isRefreshing()).toBe(false);

    // Round 2: must call performRefresh again.
    const second = await firstValueFrom(coordinator.refresh().pipe(take(1)));
    expect(second).toBe('t2');
    expect(auth.performRefresh).toHaveBeenCalledTimes(2);
  });

  it('logs out and errors when no refresh token is stored', () => {
    const auth = {
      performRefresh: vi.fn(),
      logout: vi.fn(),
      getRefreshToken: vi.fn(() => null),
    } as unknown as AuthService;
    const coordinator = new RefreshCoordinator(auth);

    let received: string | null = null;
    let errorMessage: string | null = null;
    coordinator.refresh().subscribe({
      next: v => (received = v),
      error: (e: unknown) => (errorMessage = (e as Error)?.message ?? null),
    });

    expect(received).toBeNull();
    expect(errorMessage).toBe('No refresh token');
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(auth.performRefresh).not.toHaveBeenCalled();
    // Gate cleared on error path.
    expect(coordinator.isRefreshing()).toBe(false);
  });

  it('clears the in-flight gate after a failure so a subsequent retry can start a new round', async () => {
    const authError = new Error('refresh failed');
    let callIndex = 0;
    const auth = makeAuth(() => {
      callIndex++;
      if (callIndex === 1) {
        return new Observable<string>(subscriber => {
          queueMicrotask(() => subscriber.error(authError));
        });
      }
      // Round 2: deferred emission to avoid synchronous Subject.complete()
      // before firstValueFrom subscribes.
      return new Observable<string>(subscriber => {
        queueMicrotask(() => {
          subscriber.next('t-after-failure');
          subscriber.complete();
        });
      });
    }) as unknown as AuthService;
    const coordinator = new RefreshCoordinator(auth);

    // Round 1 fails.
    const failed = await firstValueFrom(coordinator.refresh()).catch(e => e);
    expect(failed).toBe(authError);
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(coordinator.isRefreshing()).toBe(false);

    // After the gate is cleared, a fresh refresh() should call performRefresh again.
    const succeeded = await firstValueFrom(coordinator.refresh().pipe(take(1)));
    expect(succeeded).toBe('t-after-failure');
    expect(auth.performRefresh).toHaveBeenCalledTimes(2);
  });
});