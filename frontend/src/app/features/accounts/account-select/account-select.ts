import { ChangeDetectionStrategy, Component, computed, forwardRef, inject, input, signal } from '@angular/core';
import { ControlValueAccessor, FormsModule, NG_VALUE_ACCESSOR } from '@angular/forms';
import { TuiTextfield } from '@taiga-ui/core';
import { TuiChevron, TuiDataListWrapper, TuiSelect } from '@taiga-ui/kit';
import { type TuiStringHandler } from '@taiga-ui/cdk';
import { AccountsState } from '../../../core/accounts.state';
import type { Account } from '../../../models/account';

/**
 * Picks the other account of a transfer, the way CategorySelect picks a
 * category: only accounts a transfer may be entered against are offered.
 */
@Component({
  selector: 'app-account-select',
  imports: [FormsModule, TuiTextfield, TuiSelect, TuiDataListWrapper, TuiChevron],
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

  protected readonly value = signal<Account | null>(null);
  protected readonly disabled = signal(false);
  private onChange: (value: Account | null) => void = () => {};
  protected onTouched: () => void = () => {};

  readonly options = computed(() =>
    this.accountsState.transferTargets().filter(a => a.id !== this.excludeId())
  );

  readonly stringify: TuiStringHandler<Account | null> = a =>
    a ? `${a.name} (${a.currency})` : '';

  readonly accountMatcher = (a: Account | null, b: Account | null): boolean => a?.id === b?.id;

  writeValue(value: Account | null): void {
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
