import { isPublicId, newPublicId, PUBLIC_ID_LENGTH } from './public-id';

describe('newPublicId', () => {
  it('is twenty lowercase base-36 characters', () => {
    for (let i = 0; i < 200; i++) {
      const id = newPublicId();
      expect(id).toHaveLength(PUBLIC_ID_LENGTH);
      expect(isPublicId(id)).toBe(true);
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => newPublicId()));
    expect(seen.size).toBe(2000);
  });

  it('tells a public id from a uuid', () => {
    expect(isPublicId('bbjhvprglckpgrhazpvx')).toBe(true);
    expect(isPublicId('2c2d9e3e-2b4b-4a5d-9c8e-1f2a3b4c5d6e')).toBe(false);
    expect(isPublicId('BBJHVPRGLCKPGRHAZPVX')).toBe(false);
  });
});
