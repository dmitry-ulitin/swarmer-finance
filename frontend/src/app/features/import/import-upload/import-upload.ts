import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { TuiButton, TuiDataList, TuiError, TuiLoader, TuiTextfield } from '@taiga-ui/core';
import type { TuiDialogContext } from '@taiga-ui/core';
import { TuiChevron, TuiDataListWrapper, TuiFiles, TuiSelect } from '@taiga-ui/kit';
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
      if (response.data) {
        this.context.completeWith(response.data);
      }
    } catch (e) {
      this.error.set(this.messageOf(e));
      this.form.controls.file.setValue(null);
    } finally {
      this.loading.set(false);
    }
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
