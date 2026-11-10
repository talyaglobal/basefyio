import { decodeText, detectEncoding, looksBinary, looksLikeZip } from './text-decoding';

const TURKISH = 'ğüşıöçİĞŞÜÖÇ';
/** The same letters as Turkish Excel writes them in Windows-1254. */
const TURKISH_1254 = Buffer.from([
  0xf0, 0xfc, 0xfe, 0xfd, 0xf6, 0xe7, 0xdd, 0xd0, 0xde, 0xdc, 0xd6, 0xc7,
]);

describe('text-decoding', () => {
  it('reads a Windows-1254 CSV without turning Turkish letters into U+FFFD', () => {
    const csv = Buffer.concat([Buffer.from('ad,sehir\n'), TURKISH_1254, Buffer.from(',x\n')]);
    const out = decodeText(csv);
    expect(out.encoding).toBe('windows-1254');
    expect(out.detected).toBe(true);
    expect(out.text).toBe(`ad,sehir\n${TURKISH},x\n`);
    expect(out.replacementChars).toBe(0);
  });

  it('keeps valid UTF-8 as UTF-8 and strips a BOM', () => {
    const plain = decodeText(Buffer.from(`a\n${TURKISH}\n`, 'utf8'));
    expect(plain.encoding).toBe('utf-8');
    expect(plain.text).toBe(`a\n${TURKISH}\n`);

    const bom = decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b')]));
    expect(bom.encoding).toBe('utf-8');
    expect(bom.text).toBe('a,b');
  });

  it('detects UTF-16 with and without a byte-order mark', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`a\t${TURKISH}`, 'utf16le')]);
    expect(decodeText(le)).toMatchObject({ encoding: 'utf-16le', text: `a\t${TURKISH}` });

    const bomless = Buffer.from('name,city\nAda,Izmir\n', 'utf16le');
    expect(detectEncoding(bomless).encoding).toBe('utf-16le');

    const be = Buffer.from(`x,y`, 'utf16le');
    be.swap16();
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).text).toBe('x,y');
  });

  it('honours an explicit encoding even when the bytes would be detected differently', () => {
    const out = decodeText(TURKISH_1254, 'windows-1252');
    expect(out.encoding).toBe('windows-1252');
    // 0xF0 is "ð" in Windows-1252, not "ğ".
    expect(out.text.charAt(0)).toBe('ð');
    expect(out.detected).toBe(false);
  });

  it('counts undecodable characters when UTF-8 is forced on single-byte text', () => {
    const out = decodeText(TURKISH_1254, 'utf-8');
    expect(out.replacementChars).toBeGreaterThan(0);
  });

  it('treats a slice cut inside a multi-byte character as UTF-8', () => {
    const full = Buffer.from(`a,b\n${TURKISH}`, 'utf8');
    const cut = full.subarray(0, full.length - 1); // last "Ç" loses a byte
    expect(detectEncoding(cut).encoding).toBe('windows-1254');
    expect(detectEncoding(cut, { mayBeTruncated: true }).encoding).toBe('utf-8');
  });

  it('matches the runtime decoder for the Turkish code page', () => {
    // Guards the built-in table against the WHATWG reference where available.
    let reference: string | null = null;
    try {
      reference = new TextDecoder('windows-1254').decode(TURKISH_1254);
    } catch {
      reference = null;
    }
    if (reference !== null) expect(reference).toBe(TURKISH);
    expect(decodeText(TURKISH_1254, 'iso-8859-9').text).toBe(TURKISH);
  });

  it('flags binary content and zip containers', () => {
    expect(looksBinary(Buffer.from('a,b\n1,2\n'), 'utf-8')).toBe(false);
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]), 'windows-1254')).toBe(true);
    expect(looksBinary(Buffer.from('a\u0000b', 'utf16le'), 'utf-16le')).toBe(false);
    expect(looksLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(true);
    expect(looksLikeZip(Buffer.from('PK,name\n'))).toBe(false);
  });
});
