/**
 * RFC4180 reader. Banks disagree about quoting — LHV quotes text but leaves
 * dates and amounts bare, Bank of Cyprus quotes only its comma-decimal
 * numerics — so the reader treats quoting as per-field, never per-file.
 */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

  // A trailing newline leaves a [''] row; so does a blank separator line.
  return rows.filter(r => r.length > 1 || r[0] !== '');
}
