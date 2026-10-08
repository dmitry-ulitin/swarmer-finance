import * as XLSX from 'xlsx';

/** OLE2 (.xls) and ZIP (.xlsx) signatures; anything else is read as text. */
export function isWorkbook(content: Buffer): boolean {
  return content.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
    || content.subarray(0, 2).toString('latin1') === 'PK';
}

/**
 * The first sheet as a grid of strings, shaped like parseCsv's: blank rows
 * dropped, numbers as their plain decimal text, and date cells as the Excel
 * serial number (the profile's dateFormat 'excel' turns it into a date).
 */
export function parseWorkbook(content: Buffer): string[][] {
  const workbook = XLSX.read(content, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '', blankrows: false });
  return rows.map(row => row.map(cell => String(cell)));
}
