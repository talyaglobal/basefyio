import * as XLSX from 'xlsx';
import {
  detectFormat,
  ImportFileError,
  parseJsonRecords,
  samplePreview,
  streamRows,
} from './file-parser';

function xlsxBuffer(rows: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('file-parser', () => {
  describe('row counts', () => {
    it('counts records, not newlines, when a quoted field contains line breaks', () => {
      const csv = 'id,note\n1,"first\nline"\n2,b\n3,c\n4,"x\r\ny"\n';
      const p = samplePreview(Buffer.from(csv), 'csv');
      expect(p.totalRowsApprox).toBe(4);
      expect(p.totalRowsExact).toBe(true);
    });

    it('counts the last row when the file does not end with a newline', () => {
      const lines = ['id'];
      for (let i = 1; i <= 5000; i++) lines.push(String(i));
      const p = samplePreview(Buffer.from(lines.join('\n')), 'csv', 1000);
      // Only 1000 rows feed the preview, but the in-memory file is counted exactly.
      expect(p.rows).toHaveLength(1000);
      expect(p.totalRowsApprox).toBe(5000);
      expect(p.totalRowsExact).toBe(true);

      const small = samplePreview(Buffer.from('id\n1\n2\n3'), 'csv');
      expect(small.totalRowsApprox).toBe(3);
    });

    it('extrapolates the total from a slice of a larger file', () => {
      const lines = ['id,name'];
      for (let i = 1; i <= 5000; i++) lines.push(`${String(i).padStart(5, '0')},row`);
      const p = samplePreview(Buffer.from(lines.join('\n')), 'csv', 1000, true, { truncated: true });
      expect(p.totalRowsExact).toBe(false);
      expect(Math.abs(p.totalRowsApprox - 5000)).toBeLessThan(50);
    });

    it('reports the real row count of a workbook bigger than the preview', () => {
      const rows: unknown[][] = [['id', 'name']];
      for (let i = 1; i <= 30; i++) rows.push([i, `n${i}`]);
      const p = samplePreview(xlsxBuffer(rows), 'xlsx', 10);
      expect(p.rows).toHaveLength(10);
      expect(p.totalRowsApprox).toBe(30);
      expect(p.totalRowsExact).toBe(false);

      const whole = samplePreview(xlsxBuffer(rows), 'xlsx', 1000);
      expect(whole.totalRowsApprox).toBe(30);
      expect(whole.totalRowsExact).toBe(true);
    });
  });

  describe('encodings and bad files', () => {
    it('decodes a Windows-1254 CSV and says so in a warning', () => {
      const body = Buffer.concat([
        Buffer.from('ad,şehir\n'.replace('ş', 's')),
        Buffer.from([0xc7, 0x61, 0x6e, 0x61, 0x6b, 0x6b, 0x61, 0x6c, 0x65, 0x2c, 0xdd, 0x7a, 0x6d, 0x69, 0x72, 0x0a]),
      ]);
      const p = samplePreview(body, 'csv');
      expect(p.encoding).toBe('windows-1254');
      expect(p.rows[0]).toEqual(['Çanakkale', 'İzmir']);
      expect(p.warnings.join(' ')).toMatch(/Windows-1254/);
    });

    it('rejects binary data and workbooks saved with a .csv name', () => {
      expect(() =>
        samplePreview(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x41, 0x00]), 'csv'),
      ).toThrow(ImportFileError);
      expect(() => samplePreview(xlsxBuffer([['a'], [1]]), 'csv')).toThrow(/Excel workbook/);
    });

    it('warns when the file has a header but no data rows', () => {
      const p = samplePreview(Buffer.from('id,name\n'), 'csv');
      expect(p.rows).toHaveLength(0);
      expect(p.warnings.join(' ')).toMatch(/no data rows/);
    });
  });

  describe('JSON', () => {
    it('detects .json, .ndjson and .jsonl files', () => {
      expect(detectFormat('data.json')).toBe('json');
      expect(detectFormat('data.ndjson')).toBe('json');
      expect(detectFormat('data.jsonl')).toBe('json');
      expect(detectFormat('data.csv')).toBe('csv');
    });

    it('reads an array of objects, taking every key as a column', () => {
      const out = parseJsonRecords(
        JSON.stringify([
          { id: 1, ad: 'Ayşe', tags: ['a'] },
          { id: 2, city: 'İzmir', ad: null },
        ]),
        true,
      );
      expect(out.headers).toEqual(['id', 'ad', 'tags', 'city']);
      expect(out.rows).toEqual([
        [1, 'Ayşe', '["a"]', null],
        [2, null, null, 'İzmir'],
      ]);
    });

    it('reads newline-delimited JSON and a wrapped array', () => {
      expect(parseJsonRecords('{"a":1}\n{"a":2}\n', true).rows).toEqual([[1], [2]]);
      expect(parseJsonRecords('{"data":[{"a":1}]}', true).rows).toEqual([[1]]);
    });

    it('explains a JSON syntax error instead of crashing', () => {
      expect(() => parseJsonRecords('[{"a":1},', true)).toThrow(ImportFileError);
    });

    it('streams JSON rows in chunks', async () => {
      const records = Array.from({ length: 7 }, (_, i) => ({ n: i }));
      const seen: unknown[][] = [];
      const res = await streamRows(
        Buffer.from(JSON.stringify(records)),
        'json',
        async (headers, rows) => {
          expect(headers).toEqual(['n']);
          seen.push(...rows);
        },
        { chunkSize: 3 },
      );
      expect(res.totalRows).toBe(7);
      expect(seen).toHaveLength(7);
    });
  });

  it('streams a Windows-1254 CSV with decoded values', async () => {
    const body = Buffer.concat([
      Buffer.from('ad\n'),
      Buffer.from([0xdd, 0x73, 0x74, 0x61, 0x6e, 0x62, 0x75, 0x6c, 0x0a]),
    ]);
    const seen: unknown[][] = [];
    const res = await streamRows(body, 'csv', async (_h, rows) => {
      seen.push(...rows);
    });
    expect(res.encoding).toBe('windows-1254');
    expect(seen).toEqual([['İstanbul']]);
  });
});
