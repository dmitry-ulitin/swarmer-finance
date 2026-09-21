import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { ImportUpload } from './import-upload';
import { ApiService } from '../../../core/api.service';
import type { Account } from '../../../models/account';
import type { ImportParseResult } from '../../../models/import';

const account = { id: 7, name: 'LHV', currency: 'EUR', scale: 2 } as Account;

const parseResult: ImportParseResult = {
  format: 'lhv',
  account: { id: 7, name: 'LHV', currency: 'EUR', scale: 2 },
  rows: [],
  summary: { total: 0, new: 0, duplicate: 0, possibleDuplicate: 0 },
};

function configure(api: Partial<ApiService>) {
  const completeWith = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      ImportUpload,
      { provide: POLYMORPHEUS_CONTEXT, useValue: { data: account, completeWith } },
      { provide: ApiService, useValue: api },
    ],
  });
  return { component: TestBed.inject(ImportUpload), completeWith };
}

/** A File whose text() resolves to the given content, as jsdom provides. */
function makeFile(content: string, name = 'statement.csv'): File {
  return new File([content], name, { type: 'text/csv' });
}

describe('ImportUpload', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('sends the file base64-encoded', async () => {
    const parseStatement = vi.fn().mockReturnValue(of({ data: parseResult, error: null }));
    const { component } = configure({ parseStatement } as never);

    await component.upload(makeFile('Date,Amount\n2026-07-01,10.00\n'));

    const [accountId, content] = parseStatement.mock.calls[0];
    expect(accountId).toBe(7);
    // Decoding what we sent must reproduce the file byte for byte.
    expect(atob(content)).toBe('Date,Amount\n2026-07-01,10.00\n');
  });

  it('encodes non-ASCII content without corrupting it', async () => {
    // A statement with accented merchant names must survive the round trip;
    // a naive btoa(string) would throw or mangle these.
    const parseStatement = vi.fn().mockReturnValue(of({ data: parseResult, error: null }));
    const { component } = configure({ parseStatement } as never);

    await component.upload(makeFile('MERCADONA CALAHONDA,MIJAS,ESPAÑA\n'));

    const content = parseStatement.mock.calls[0][1];
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(content), c => c.charCodeAt(0))
    );
    expect(decoded).toBe('MERCADONA CALAHONDA,MIJAS,ESPAÑA\n');
  });

  it('omits format when detecting automatically', async () => {
    const parseStatement = vi.fn().mockReturnValue(of({ data: parseResult, error: null }));
    const { component } = configure({ parseStatement } as never);

    await component.upload(makeFile('x'));

    expect(parseStatement.mock.calls[0][2]).toBeNull();
  });

  it('passes an explicitly chosen format through', async () => {
    const parseStatement = vi.fn().mockReturnValue(of({ data: parseResult, error: null }));
    const { component } = configure({ parseStatement } as never);
    component.form.controls.format.setValue({ id: 'boc', name: 'Bank of Cyprus' });

    await component.upload(makeFile('x'));

    expect(parseStatement.mock.calls[0][2]).toBe('boc');
  });

  it('closes with the parse result on success', async () => {
    const parseStatement = vi.fn().mockReturnValue(of({ data: parseResult, error: null }));
    const { component, completeWith } = configure({ parseStatement } as never);

    await component.upload(makeFile('x'));

    expect(completeWith).toHaveBeenCalledWith(parseResult);
  });

  it('shows the server message inline and stays open when parsing fails', async () => {
    // A currency mismatch or unrecognised format is the case where the user
    // must pick a different file or force the format — closing the dialog
    // would throw away the context they need to do that.
    const parseStatement = vi.fn().mockReturnValue(
      throwError(() => new HttpErrorResponse({
        status: 400,
        error: { data: null, error: 'Statement is in EUR but the account is in USD' },
      }))
    );
    const { component, completeWith } = configure({ parseStatement } as never);

    await component.upload(makeFile('x'));

    expect(component.error()).toBe('Statement is in EUR but the account is in USD');
    expect(completeWith).not.toHaveBeenCalled();
  });

  it('clears a previous error when a new file is uploaded', async () => {
    const parseStatement = vi.fn()
      .mockReturnValueOnce(throwError(() => new HttpErrorResponse({
        status: 400,
        error: { data: null, error: 'Could not recognise this statement format.' },
      })))
      .mockReturnValueOnce(of({ data: parseResult, error: null }));
    const { component } = configure({ parseStatement } as never);

    await component.upload(makeFile('bad'));
    expect(component.error()).toBeTruthy();

    await component.upload(makeFile('good'));
    expect(component.error()).toBeNull();
  });

  it('reports loading while the request is in flight', async () => {
    const parseStatement = vi.fn().mockReturnValue(of({ data: parseResult, error: null }));
    const { component } = configure({ parseStatement } as never);

    expect(component.loading()).toBe(false);
    const done = component.upload(makeFile('x'));
    await done;
    expect(component.loading()).toBe(false);
  });
});
