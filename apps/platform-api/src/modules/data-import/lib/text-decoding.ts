/**
 * Character-set handling for text imports (CSV / TSV / JSON).
 *
 * Excel on a Turkish Windows machine saves "CSV (comma delimited)" in
 * Windows-1254, not UTF-8. Decoding those bytes as UTF-8 turns every
 * "ğüşıöçİĞŞÜÖÇ" into U+FFFD and the damage is silent — the import "succeeds"
 * with corrupted text. So the bytes are checked first: a BOM decides outright,
 * strictly valid UTF-8 stays UTF-8, and anything else is read as a single-byte
 * code page (Windows-1254 by default, the superset Turkish Excel uses).
 *
 * The single-byte tables are built in here rather than relying on the
 * runtime's ICU data, which slim Node builds may not ship.
 */

export const IMPORT_ENCODINGS = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'windows-1254',
  'windows-1252',
  'iso-8859-9',
] as const;

export type ImportEncoding = (typeof IMPORT_ENCODINGS)[number];

export function isImportEncoding(v: unknown): v is ImportEncoding {
  return typeof v === 'string' && (IMPORT_ENCODINGS as readonly string[]).includes(v);
}

export interface EncodingDetection {
  encoding: ImportEncoding;
  /** Bytes to skip at the start of the buffer (a byte-order mark). */
  bomLength: number;
  /** True when the choice came from a BOM or a strictly valid UTF-8 decode. */
  confident: boolean;
}

/**
 * cp1252 code points for 0x80–0x9F. `null` marks bytes the code page leaves
 * undefined; they decode to U+FFFD.
 */
const CP1252_HIGH_CONTROL: Array<number | null> = [
  0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, null, 0x017d, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
];

/** Where the Turkish code pages differ from Latin-1 in 0xA0–0xFF. */
const TURKISH_OVERRIDES: Record<number, number> = {
  0xd0: 0x011e, // Ğ
  0xdd: 0x0130, // İ
  0xde: 0x015e, // Ş
  0xf0: 0x011f, // ğ
  0xfd: 0x0131, // ı
  0xfe: 0x015f, // ş
};

function buildSingleByteTable(encoding: 'windows-1254' | 'windows-1252' | 'iso-8859-9'): string[] {
  const table: string[] = new Array(256);
  for (let b = 0; b < 256; b++) {
    let cp: number | null = b;
    if (b >= 0x80 && b <= 0x9f) {
      if (encoding === 'iso-8859-9') {
        cp = b; // C1 controls, as ISO-8859-9 defines them
      } else {
        cp = CP1252_HIGH_CONTROL[b - 0x80];
        // Windows-1254 leaves Ž/ž undefined where 1252 has them.
        if (encoding === 'windows-1254' && (b === 0x8e || b === 0x9e)) cp = null;
      }
    } else if (b >= 0xa0 && encoding !== 'windows-1252' && TURKISH_OVERRIDES[b] !== undefined) {
      cp = TURKISH_OVERRIDES[b];
    }
    table[b] = cp === null ? '\ufffd' : String.fromCharCode(cp);
  }
  return table;
}

const SINGLE_BYTE_TABLES: Record<string, string[]> = {};

function singleByteTable(encoding: 'windows-1254' | 'windows-1252' | 'iso-8859-9'): string[] {
  return (SINGLE_BYTE_TABLES[encoding] ??= buildSingleByteTable(encoding));
}

/**
 * The runtime's own decoder is much faster on large files. It is used only when
 * it exists and agrees with the built-in table on the bytes that matter.
 * (WHATWG maps the iso-8859-9 label to windows-1254, so that one always uses
 * the table.)
 */
const nativeDecoders: Record<string, TextDecoder | null> = {};

function nativeDecoder(encoding: 'windows-1254' | 'windows-1252'): TextDecoder | null {
  if (encoding in nativeDecoders) return nativeDecoders[encoding];
  let decoder: TextDecoder | null = null;
  try {
    const candidate = new TextDecoder(encoding);
    const probe = Buffer.from([0x80, 0xd0, 0xdd, 0xde, 0xf0, 0xfd, 0xfe, 0x41]);
    const table = singleByteTable(encoding);
    const expected = Array.from(probe, (b) => table[b]).join('');
    if (candidate.decode(probe) === expected) decoder = candidate;
  } catch {
    decoder = null;
  }
  nativeDecoders[encoding] = decoder;
  return decoder;
}

function decodeSingleByte(
  buf: Buffer,
  encoding: 'windows-1254' | 'windows-1252' | 'iso-8859-9',
): string {
  if (encoding !== 'iso-8859-9') {
    const native = nativeDecoder(encoding);
    if (native) return native.decode(buf);
  }
  const table = singleByteTable(encoding);
  // Chunked so a large file does not build one enormous argument list.
  const parts: string[] = [];
  const CHUNK = 64 * 1024;
  for (let start = 0; start < buf.length; start += CHUNK) {
    const end = Math.min(buf.length, start + CHUNK);
    let s = '';
    for (let i = start; i < end; i++) s += table[buf[i]];
    parts.push(s);
  }
  return parts.join('');
}

/** Strict UTF-8 check. A slice cut mid-character is allowed to end early. */
function isValidUtf8(buf: Buffer, mayBeTruncated: boolean): boolean {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(buf);
    return true;
  } catch {
    if (!mayBeTruncated) return false;
  }
  // A range-fetched preview can stop inside a multi-byte sequence; drop up to
  // three trailing bytes and try again.
  for (let cut = 1; cut <= 3 && cut < buf.length; cut++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, buf.length - cut));
      return true;
    } catch {
      // keep trimming
    }
  }
  return false;
}

/**
 * UTF-16 without a BOM shows up as a NUL in every other byte of ASCII text.
 * Returns the byte order when that pattern dominates the sample.
 */
function sniffBomlessUtf16(buf: Buffer): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(buf.length, 4096) & ~1;
  if (n < 4) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) evenZero++;
    if (buf[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (oddZero / pairs > 0.4 && evenZero / pairs < 0.05) return 'utf-16le';
  if (evenZero / pairs > 0.4 && oddZero / pairs < 0.05) return 'utf-16be';
  return null;
}

export function detectEncoding(buf: Buffer, opts: { mayBeTruncated?: boolean } = {}): EncodingDetection {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8', bomLength: 3, confident: true };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf-16le', bomLength: 2, confident: true };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf-16be', bomLength: 2, confident: true };
  }
  const utf16 = sniffBomlessUtf16(buf);
  if (utf16) return { encoding: utf16, bomLength: 0, confident: false };
  if (isValidUtf8(buf, !!opts.mayBeTruncated)) {
    return { encoding: 'utf-8', bomLength: 0, confident: true };
  }
  return { encoding: 'windows-1254', bomLength: 0, confident: false };
}

function bomLengthFor(buf: Buffer, encoding: ImportEncoding): number {
  if (encoding === 'utf-8' && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 3;
  if (encoding === 'utf-16le' && buf[0] === 0xff && buf[1] === 0xfe) return 2;
  if (encoding === 'utf-16be' && buf[0] === 0xfe && buf[1] === 0xff) return 2;
  return 0;
}

/**
 * Decode a text upload. `encoding: 'auto'` (the default) runs
 * {@link detectEncoding}; an explicit encoding is honoured as-is so the user
 * can override a wrong guess from the wizard.
 */
export function decodeText(
  buf: Buffer,
  encoding: ImportEncoding | 'auto' = 'auto',
  opts: { mayBeTruncated?: boolean } = {},
): { text: string; encoding: ImportEncoding; detected: boolean; replacementChars: number } {
  let chosen: ImportEncoding;
  let bom: number;
  if (encoding === 'auto') {
    const d = detectEncoding(buf, opts);
    chosen = d.encoding;
    bom = d.bomLength;
  } else {
    chosen = encoding;
    bom = bomLengthFor(buf, encoding);
  }
  const body = bom > 0 ? buf.subarray(bom) : buf;

  let text: string;
  switch (chosen) {
    case 'utf-8':
      text = body.toString('utf8');
      break;
    case 'utf-16le':
      text = body.subarray(0, body.length & ~1).toString('utf16le');
      break;
    case 'utf-16be': {
      const even = body.subarray(0, body.length & ~1);
      const swapped = Buffer.from(even);
      swapped.swap16();
      text = swapped.toString('utf16le');
      break;
    }
    default:
      text = decodeSingleByte(body, chosen);
  }
  // A stray BOM can survive when the caller forced an encoding.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let replacementChars = 0;
  for (let i = 0; i < text.length && replacementChars < 1000; i++) {
    if (text.charCodeAt(i) === 0xfffd) replacementChars++;
  }
  return { text, encoding: chosen, detected: encoding === 'auto', replacementChars };
}

/**
 * A text file has no NUL bytes and few control characters. Images, archives
 * and executables renamed to .csv fail this quickly — rejecting them up front
 * beats importing pages of garbage rows.
 */
export function looksBinary(buf: Buffer, encoding: ImportEncoding): boolean {
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return false;
  const n = Math.min(buf.length, 8192);
  if (n === 0) return false;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    // Tab, LF, CR and form feed are normal in text.
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) control++;
  }
  return control / n > 0.1;
}

/** ZIP-based formats (xlsx) start with "PK"; used to catch a workbook renamed to .csv. */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05);
}
