import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TuiButton, TuiTextfield, type TuiDialogContext } from '@taiga-ui/core';
import { TuiInputDate } from '@taiga-ui/kit';
import { TuiDay } from '@taiga-ui/cdk/date-time';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';

/** Asks how far back the first load from the bank reaches; completes with `YYYY-MM-DD`, or null on cancel. */
@Component({
  selector: 'app-bank-load',
  imports: [ReactiveFormsModule, TuiButton, TuiInputDate, TuiTextfield],
  template: `
    <div class="content" tuiTextfieldSize="m">
      <tui-textfield>
        <label tuiLabel>Load from</label>
        <input tuiInputDate [max]="max" [formControl]="control" />
        <tui-calendar *tuiDropdown />
      </tui-textfield>
      <div class="actions">
        <button tuiButton size="s" type="button" appearance="secondary" (click)="cancel()">Cancel</button>
        <button tuiButton size="s" type="button" [disabled]="!control.value" (click)="submit()">Load</button>
      </div>
    </div>
  `,
  styles: `
    .content { display: flex; flex-direction: column; gap: 1rem; }
    .actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BankLoad {
  private readonly context = inject<TuiDialogContext<string | null, void>>(POLYMORPHEUS_CONTEXT);

  readonly max = TuiDay.currentLocal();
  readonly control = new FormControl<TuiDay | null>(this.max.append({ day: -90 }));

  submit(): void {
    const date = this.control.value;
    if (date) this.context.completeWith(date.toJSON());
  }

  cancel(): void {
    this.context.completeWith(null);
  }
}
