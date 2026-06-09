import { chunk, normalizeToJson, estimateTokens } from './rag-chunker';

const within = (cs: ReturnType<typeof chunk>, size: number) =>
  cs.every((c) => c.endOffset - c.startOffset <= size);

describe('rag-chunker', () => {
  const text = Array.from(
    { length: 40 },
    (_, i) => `Sentence number ${i} explains concept ${i} and links forward.`,
  ).join(' ');

  it('produces chained, overlapping chunks', () => {
    const cs = chunk(text, { chunkSize: 300, chunkOverlap: 80, granularity: 'sentence' });
    expect(cs.length).toBeGreaterThan(1);
    for (let i = 1; i < cs.length; i++) {
      // each chunk starts before the previous one ended (the chain overlaps)
      expect(cs[i].startOffset).toBeLessThan(cs[i - 1].endOffset);
      expect(cs[i].overlapChars).toBeGreaterThan(0);
      expect(cs[i].startOffset).toBeGreaterThan(cs[i - 1].startOffset);
    }
  });

  it('content always matches its offset slice', () => {
    const cs = chunk(text, { chunkSize: 250, chunkOverlap: 60 });
    for (const c of cs) {
      expect(c.content).toBe(text.slice(c.startOffset, c.endOffset));
    }
  });

  it('zero overlap produces no chaining', () => {
    const cs = chunk(text, { chunkSize: 250, chunkOverlap: 0 });
    expect(cs.every((c) => c.overlapChars === 0)).toBe(true);
  });

  describe('bounded size across hostile inputs (madde 3)', () => {
    const CS = 200;
    it('long punctuation-free text stays within chunkSize', () => {
      const noPunct = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
      const cs = chunk(noPunct, { chunkSize: CS, chunkOverlap: 40 });
      expect(cs.length).toBeGreaterThan(1);
      expect(within(cs, CS)).toBe(true);
    });

    it('single oversized sentence is hard-split', () => {
      const long = 'alpha '.repeat(300).trim() + '.';
      const cs = chunk(long, { chunkSize: CS, chunkOverlap: 30, granularity: 'sentence' });
      expect(within(cs, CS)).toBe(true);
    });

    it('unbreakable long run is char-windowed', () => {
      const run = 'x'.repeat(1000);
      const cs = chunk(run, { chunkSize: CS, chunkOverlap: 40 });
      expect(within(cs, CS)).toBe(true);
      expect(cs.map((c) => c.content).join('')).toContain('x'.repeat(CS));
    });

    it('newline-heavy text works', () => {
      const nl = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
      expect(within(chunk(nl, { chunkSize: CS, chunkOverlap: 40, granularity: 'context' }), CS)).toBe(true);
    });

    it('whitespace-only and empty yield no chunks', () => {
      expect(chunk('   \n\t  ', { chunkSize: CS })).toHaveLength(0);
      expect(chunk('', { chunkSize: CS })).toHaveLength(0);
    });
  });

  describe('normalizeToJson', () => {
    it('flattens JSON string leaves, drops numbers', () => {
      const nd = normalizeToJson(JSON.stringify({ a: 'Hello', b: 'World', n: 7 }), 'application/json');
      expect(nd.format).toBe('json');
      expect(nd.text).toContain('Hello');
      expect(nd.text).toContain('World');
      expect(nd.text).not.toContain('7');
    });
    it('passes through plain text', () => {
      const nd = normalizeToJson('# Title\n\nbody', 'text/markdown');
      expect(nd.format).toBe('markdown');
      expect(nd.text).toContain('Title');
    });
  });

  it('estimates tokens as chars/4', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('x'.repeat(9))).toBe(3);
  });
});
