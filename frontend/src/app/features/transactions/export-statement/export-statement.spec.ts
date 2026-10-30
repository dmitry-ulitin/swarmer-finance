import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { of } from 'rxjs';
import { signal } from '@angular/core';
import { ExportStatement } from './export-statement';
import { ApiService } from '../../../core/api.service';
import { NotificationService } from '../../../core/notification.service';
import { TransactionsState } from '../../../core/transactions.state';
import type { ExportPreview } from '../../../models/transaction';

const filters = { accounts: [3], from: '2026-01-01' };

function render(preview: ExportPreview) {
  const completeWith = vi.fn();
  const api = {
    previewExport: vi.fn().mockReturnValue(of({ data: preview, error: null })),
    exportTransactions: vi.fn().mockReturnValue(of(new Blob(['csv']))),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: POLYMORPHEUS_CONTEXT, useValue: { completeWith } },
      { provide: ApiService, useValue: api },
      { provide: NotificationService, useValue: { showError: vi.fn() } },
      { provide: TransactionsState, useValue: { filters: signal(filters) } },
    ],
  });
  const fixture = TestBed.createComponent(ExportStatement);
  return { fixture, api, completeWith };
}

async function settle(fixture: ReturnType<typeof render>['fixture']) {
  await vi.waitFor(() => expect(fixture.componentInstance.preview.isLoading()).toBe(false));
  fixture.detectChanges();
}

const downloadButton = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].find(b => b.textContent?.includes('Download'))!;

describe('ExportStatement', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows what the file will hold for the current filters', async () => {
    const { fixture, api } = render({ rows: 1234, accounts: 3, from: '2019-03-12', to: '2026-10-29' });
    fixture.detectChanges();
    await settle(fixture);

    expect(api.previewExport).toHaveBeenCalledWith(filters);
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('1,234 rows');
    expect(text).toContain('3 accounts');
    expect(text).toContain('12 Mar 2019 – 29 Oct 2026');
    expect(downloadButton(fixture.nativeElement).disabled).toBe(false);
  });

  it('disables the download when nothing matches', async () => {
    const { fixture } = render({ rows: 0, accounts: 0, from: null, to: null });
    fixture.detectChanges();
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('No transactions match the current filters.');
    expect(downloadButton(fixture.nativeElement).disabled).toBe(true);
  });

  it('downloads the CSV for the same filters and closes', async () => {
    const { fixture, api, completeWith } = render({ rows: 2, accounts: 1, from: '2026-01-01', to: '2026-01-02' });
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fixture.detectChanges();
    await settle(fixture);

    await fixture.componentInstance.download();

    expect(api.exportTransactions).toHaveBeenCalledWith(filters);
    expect(click).toHaveBeenCalled();
    expect(completeWith).toHaveBeenCalledWith(true);
    click.mockRestore();
  });
});
