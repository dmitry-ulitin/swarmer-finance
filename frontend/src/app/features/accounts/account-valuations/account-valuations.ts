import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { type AbstractControl, FormControl, FormGroup, ReactiveFormsModule, type ValidationErrors, Validators } from '@angular/forms';
import { TuiDay } from '@taiga-ui/cdk/date-time';
import { TuiButton, TuiDialogService, TuiInput, TuiLoader, TuiNumberFormat } from '@taiga-ui/core';
import type { TuiDialogContext } from '@taiga-ui/core';
import { TUI_CONFIRM, type TuiConfirmData, TuiInputDate, TuiInputNumber } from '@taiga-ui/kit';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { AccountsState } from '../../../core/accounts.state';
import { NotificationService } from '../../../core/notification.service';
import { MoneyPipe } from '../../../core/money.pipe';
import { accessLevelOf, type Account } from '../../../models/account';
import type { Valuation } from '../../../models/valuation';

@Component({
  selector: 'app-account-valuations',
  imports: [ReactiveFormsModule, TuiInput, TuiInputDate, TuiInputNumber, TuiNumberFormat, TuiButton, TuiLoader, MoneyPipe],
  templateUrl: './account-valuations.html',
  styleUrl: './account-valuations.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountValuations {
  private readonly context = inject<TuiDialogContext<void, Account>>(POLYMORPHEUS_CONTEXT);
  private readonly api = inject(ApiService);
  private readonly accountsState = inject(AccountsState);
  private readonly notifications = inject(NotificationService);
  private readonly dialogs = inject(TuiDialogService);

  readonly account = this.context.data;
  readonly canWrite = accessLevelOf(this.account) >= 2;
  readonly today = utcToday();
  readonly precision = this.account.scale ?? 2;
  readonly quantum = 1 / Math.pow(10, this.precision);

  readonly busy = signal(false);
  readonly loading = signal(true);
  /** Server message of the last failed change, shown by the form. */
  readonly error = signal<string | null>(null);
  readonly valuations = signal<Valuation[]>([]);
  /** The row being edited; null while adding. */
  readonly editingId = signal<number | null>(null);
  /** Newest first; the API answers oldest first. */
  readonly rows = computed(() => [...this.valuations()].sort((a, b) => b.as_of.localeCompare(a.as_of)));

  readonly form = new FormGroup({
    date: new FormControl<TuiDay | null>(utcToday(), [Validators.required, notFuture]),
    value: new FormControl<number | null>(null, [Validators.required, Validators.min(0)]),
  });

  constructor() {
    void this.load();
  }

  edit(valuation: Valuation): void {
    this.error.set(null);
    this.editingId.set(valuation.id);
    this.form.setValue({ date: TuiDay.jsonParse(valuation.as_of), value: valuation.value });
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.resetForm();
  }

  async submit(): Promise<void> {
    if (this.busy() || this.form.invalid) return;
    const { date, value } = this.form.getRawValue();
    if (!date || value === null) return;
    const payload = { asOf: date.toJSON(), value };
    const id = this.editingId();
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(id === null
        ? this.api.createValuation(this.account.id, payload)
        : this.api.updateValuation(this.account.id, id, payload));
      this.editingId.set(null);
      this.resetForm();
      await this.changed();
    } catch (e) {
      this.error.set(serverMessage(e) ?? 'Failed to save the valuation');
    } finally {
      this.busy.set(false);
    }
  }

  async remove(valuation: Valuation): Promise<void> {
    if (this.busy()) return;
    const data: TuiConfirmData = { content: `Delete the valuation of ${valuation.as_of}?`, yes: 'Delete', no: 'Cancel' };
    this.busy.set(true);
    this.error.set(null);
    try {
      const ok = await firstValueFrom(this.dialogs.open<boolean>(TUI_CONFIRM, { label: 'Delete valuation', size: 's', data }), { defaultValue: false });
      if (!ok) return;
      await firstValueFrom(this.api.deleteValuation(this.account.id, valuation.id));
      if (this.editingId() === valuation.id) this.cancelEdit();
      await this.changed();
    } catch (e) {
      this.notifications.showError(e, 'Failed to delete the valuation');
    } finally {
      this.busy.set(false);
    }
  }

  private resetForm(): void {
    this.form.reset({ date: utcToday(), value: null });
  }

  /** Reloads the list and the accounts, whose values depend on the latest valuation. */
  private async changed(): Promise<void> {
    this.accountsState.reload();
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      const r = await firstValueFrom(this.api.getValuations(this.account.id));
      this.valuations.set(r.data ?? []);
    } catch (e) {
      this.notifications.showError(e, 'Failed to load valuations');
    } finally {
      this.loading.set(false);
    }
  }
}

/** The server's "today" is the UTC date. */
function utcToday(): TuiDay {
  const now = new Date();
  return new TuiDay(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function notFuture(control: AbstractControl<TuiDay | null>): ValidationErrors | null {
  const day = control.value;
  return day && day.dayAfter(utcToday()) ? { future: true } : null;
}

function serverMessage(e: unknown): string | null {
  const body = (e as { error?: { error?: unknown } } | null)?.error;
  return typeof body?.error === 'string' ? body.error : null;
}
