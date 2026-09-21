import { parseCsv } from '../services/import/csv';

describe('parseCsv', () => {
  it('parses plain rows', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps a delimiter that sits inside quotes', () => {
    // LHV descriptions are full of commas.
    expect(parseCsv('a,b\n"x,y",2\n')).toEqual([['a', 'b'], ['x,y', '2']]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"he said ""hi"""\n')).toEqual([['a'], ['he said "hi"']]);
  });

  it('strips a UTF-8 BOM from the first field', () => {
    expect(parseCsv('﻿a,b\n')).toEqual([['a', 'b']]);
  });

  it('handles CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('drops trailing blank lines', () => {
    expect(parseCsv('a,b\n1,2\n\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps empty fields', () => {
    expect(parseCsv('a,,c\n')).toEqual([['a', '', 'c']]);
  });
});
