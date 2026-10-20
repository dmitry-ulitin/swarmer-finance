import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { RegisterComponent } from './register.component';
import { AuthService } from '../../core/auth.service';
import { NotificationService } from '../../core/notification.service';

describe('RegisterComponent currency', () => {
  let register: ReturnType<typeof vi.fn>;
  let component: RegisterComponent;

  beforeEach(() => {
    register = vi.fn(() => of({ data: null, error: null }));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'dashboard', children: [] }]),
        RegisterComponent,
        { provide: AuthService, useValue: { register } },
        { provide: NotificationService, useValue: { showError: vi.fn() } },
      ],
    });
    component = TestBed.inject(RegisterComponent);
    component.form.patchValue({ email: 'a@b.c', password: 'secret1' });
  });

  async function submit(currency: string): Promise<void> {
    component.form.patchValue({ currency });
    await component.onSubmit(new Event('submit'));
  }

  it('sends the code trimmed and in upper case', async () => {
    await submit(' usdt ');
    expect(register).toHaveBeenCalledWith('a@b.c', 'secret1', '', 'USDT');
  });

  it('defaults to EUR when left empty', async () => {
    await submit('');
    expect(register.mock.lastCall![3]).toBe('EUR');
  });

  it('refuses a code that is not 3 or 4 letters', async () => {
    await submit('dollars');
    expect(component.form.controls.currency.invalid).toBe(true);
    expect(register).not.toHaveBeenCalled();
  });
});
