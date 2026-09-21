import type { ImportReconcileResult } from '../../models/import';

/**
 * How an import is reported once it lands.
 *
 * Kept out of import-dialog.service.ts so a test can reach it without
 * loading that module, which injects TransactionsState and AccountsState and
 * through them the HTTP stack.
 */
export function describeImport({ created, skipped }: ImportReconcileResult): string {
  const imported = `${created} transaction${created === 1 ? '' : 's'} imported`;
  return skipped > 0 ? `${imported}, ${skipped} already present` : imported;
}
