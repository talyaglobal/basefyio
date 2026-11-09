import { escapeLike } from './escape-like';

describe('escapeLike', () => {
  it('turns wildcards and the escape character into literals', () => {
    expect(escapeLike('a%z_b\\c')).toBe('a\\%z\\_b\\\\c');
  });
  it('leaves plain text alone', () => {
    expect(escapeLike('a@b.com #1')).toBe('a@b.com #1');
  });
});
