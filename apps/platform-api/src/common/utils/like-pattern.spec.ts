import { escapeLikePattern } from './like-pattern';

/** What PostgreSQL's LIKE does with the default escape character, for checking the escaping. */
function likeMatches(value: string, pattern: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'is').test(value);
}

/** Prisma's `contains` wraps the value in % on both sides. */
const contains = (value: string, needle: string) => likeMatches(value, `%${needle}%`);

describe('escapeLikePattern', () => {
  it('escapes the LIKE wildcards and the escape character itself', () => {
    expect(escapeLikePattern('%')).toBe('\\%');
    expect(escapeLikePattern('_')).toBe('\\_');
    expect(escapeLikePattern('a%z')).toBe('a\\%z');
    expect(escapeLikePattern('c:\\path_1')).toBe('c:\\\\path\\_1');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLikePattern('volkan.akyuz@example.com')).toBe('volkan.akyuz@example.com');
    expect(escapeLikePattern('#')).toBe('#');
  });

  it('turns "%" and "_" searches into plain-text matches', () => {
    const emails = ['volkan.akyuz@example.com', 'aozkarsli@example.com', 'first_last@example.com', '50%off@example.com'];
    const search = (q: string) => emails.filter((e) => contains(e, escapeLikePattern(q)));

    // Unescaped, "%" matched every row and "a%z" matched across the address.
    expect(emails.filter((e) => contains(e, '%'))).toHaveLength(4);
    expect(emails.filter((e) => contains(e, 'a%z'))).toHaveLength(2);

    expect(search('%')).toEqual(['50%off@example.com']);
    expect(search('_')).toEqual(['first_last@example.com']);
    expect(search('a%z')).toEqual([]);
    expect(search('akyuz')).toEqual(['volkan.akyuz@example.com']);
  });
});
