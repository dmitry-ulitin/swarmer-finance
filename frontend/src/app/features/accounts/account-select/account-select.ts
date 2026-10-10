import { ChangeDetectionStrategy, Component, computed, forwardRef, inject, input, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ControlValueAccessor, FormsModule, NG_VALUE_ACCESSOR } from '@angular/forms';
import { TuiDataList, TuiTextfield } from '@taiga-ui/core';
import { TuiChevron, TuiSelect } from '@taiga-ui/kit';
import { type TuiStringHandler } from '@taiga-ui/cdk';
import { AccountsState } from '../../../core/accounts.state';
import { AuthService } from '../../../core/auth.service';
import type { Account } from '../../../models/account';
import type { TransactionAccount } from '../../../models/transaction';

/**
 * Picks the other account of a transfer, the way CategorySelect picks a
 * category: only accounts a transfer may be entered against are offered.
 */
@Component({
  selector: 'app-account-select',
  imports: [FormsModule, NgTemplateOutlet, TuiTextfield, TuiSelect, TuiDataList, TuiChevron],
  templateUrl: './account-select.html',
  styleUrl: './account-select.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => AccountSelect),
      multi: true,
    },
  ],
})
export class AccountSelect implements ControlValueAccessor {
  readonly label = input<string>('Account');
  readonly size = input<'l' | 'm' | 's'>('m');
  /** The account on the transfer's own side, which cannot also be its peer. */
  readonly excludeId = input<number | null>(null);

  private readonly accountsState = inject(AccountsState);
  private readonly auth = inject(AuthService);

  // A transaction carries only a summary of its accounts, so the value may be
  // a bare TransactionAccount; picks from the list are always full accounts.
  protected readonly value = signal<TransactionAccount | null>(null);
  protected readonly disabled = signal(false);
  private onChange: (value: Account | null) => void = () => {};
  protected onTouched: () => void = () => {};

  /** The value as the full account, for its owner; as given when it is not loaded. */
  readonly displayed = computed(() => {
    const value = this.value();
    return this.accountsState.accounts().find(a => a.id === value?.id) ?? value;
  });

  readonly options = computed(() =>
    this.accountsState.transferTargets().filter(a => a.id !== this.excludeId())
  );

  readonly stringify: TuiStringHandler<TransactionAccount | null> = a => a?.name ?? '';

  /** Someone else's account, shared with the user; its owner is shown beside the name. */
  readonly isForeign = (a: TransactionAccount | Account): boolean =>
    'user_id' in a && a.user_id !== this.auth.user()?.id;

  readonly accountMatcher = (a: TransactionAccount | null, b: TransactionAccount | null): boolean =>
    a?.id === b?.id;

  writeValue(value: TransactionAccount | null): void {
    this.value.set(value);
  }

  registerOnChange(fn: (value: Account | null) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(disabled: boolean): void {
    this.disabled.set(disabled);
  }

  protected onValueChange(value: Account | null): void {
    this.value.set(value);
    this.onChange(value);
  }
}
