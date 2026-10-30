import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { TuiButton, TuiDataList, TuiError, TuiLoader, TuiTextfield } from '@taiga-ui/core';
import type { TuiDialogContext } from '@taiga-ui/core';
import { TuiChevron, TuiDataListWrapper, TuiFiles, TuiSelect, TuiStringifyContentPipe } from '@taiga-ui/kit';
import { type TuiStringHandler } from '@taiga-ui/cdk';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService } from '../../../core/api.service';
import type { Account } from '../../../models/account';
import { IMPORT_FORMATS, type ImportFormat, type ImportParseResult } from '../../../models/import';

/** Base64 of the file's bytes, safe for content outside Latin-1. */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  // Chunked so a large statement does not blow the argument limit of apply().
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

@Component({
  selector: 'app-import-upload',
  imports: [
    ReactiveFormsModule,
    TuiFiles,
    TuiTextfield,
    TuiSelect,
    TuiDataList,
    TuiDataListWrapper,
    TuiChevron,
    TuiButton,
    TuiError,
    TuiLoader,
    TuiStringifyContentPipe
  ],
  templateUrl: './import-upload.html',
  styleUrl: './import-upload.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImportUpload {
  private readonly context =
    inject<TuiDialogContext<ImportParseResult | null, Account>>(POLYMORPHEUS_CONTEXT);
  private readonly api = inject(ApiService);

  readonly account = this.context.data;
  readonly formats = IMPORT_FORMATS;

  readonly form = new FormGroup({
    format: new FormControl<ImportFormat>(IMPORT_FORMATS[0], { nonNullable: true }),
    file: new FormControl<File | null>(null),
  });

  /**
   * A parsed file covering several accounts waits here for the user to pick
   * whose rows to import; `content` is kept to re-parse with another choice.
   */
  readonly pending = signal<{ content: string; format: string | null; result: ImportParseResult } | null>(null);
  readonly sourceAccount = new FormControl<string | null>(null);

  readonly loading = signal(false);
  /**
   * A failed parse is shown here rather than closing the dialog: an
   * unrecognised format or a currency mismatch is exactly the case where the
   * user needs to pick a different file or name the format explicitly.
   */
  readonly error = signal<string | null>(null);

  readonly stringifyFormat: TuiStringHandler<ImportFormat> = f => f.name;

  constructor() {
    // Picking a file starts the parse straight away — there is nothing else
    // to confirm on this step, and a separate "Upload" button would only add
    // a click between choosing the file and seeing the result.
    this.form.controls.file.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(file => {
        if (file) void this.upload(file);
      });
    this.sourceAccount.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(name => {
        const pending = this.pending();
        if (pending && name && name !== pending.result.sourceAccount) void this.reparse(name);
      });
  }

  async upload(file: File): Promise<void> {
    this.error.set(null);
    this.loading.set(true);
    try {
      const content = await toBase64(file);
      const format = this.form.controls.format.value.id;
      const response = await firstValueFrom(
        this.api.parseStatement(this.account.id, content, format)
      );
      const result = response.data;
      if (!result) return;
      if ((result.sourceAccounts?.length ?? 0) > 1) {
        this.pending.set({ content, format, result });
        this.sourceAccount.setValue(result.sourceAccount ?? null, { emitEvent: false });
      } else {
        this.context.completeWith(result);
      }
    } catch (e) {
      this.error.set(this.messageOf(e));
      this.form.controls.file.setValue(null);
    } finally {
      this.loading.set(false);
    }
  }

  private async reparse(sourceAccount: string): Promise<void> {
    const pending = this.pending()!;
    this.error.set(null);
    this.loading.set(true);
    try {
      const response = await firstValueFrom(
        this.api.parseStatement(this.account.id, pending.content, pending.format, sourceAccount)
      );
      if (response.data) this.pending.set({ ...pending, result: response.data });
    } catch (e) {
      this.error.set(this.messageOf(e));
      // The rows shown are still the previous account's: say so in the picker.
      this.sourceAccount.setValue(pending.result.sourceAccount ?? null, { emitEvent: false });
    } finally {
      this.loading.set(false);
    }
  }

  protected proceed(): void {
    const result = this.pending()?.result;
    if (result) this.context.completeWith(result);
  }

  protected cancel(): void {
    this.context.completeWith(null);
  }

  private messageOf(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      return e.error?.error || e.message || 'Could not read this statement';
    }
    return e instanceof Error ? e.message : 'Could not read this statement';
  }
}
