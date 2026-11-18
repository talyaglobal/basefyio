import { ALLOWED_EXTENSIONS } from './project-database.service';

describe('ALLOWED_EXTENSIONS', () => {
  it('lets a customer enable postgis', () => {
    expect(ALLOWED_EXTENSIONS.has('postgis')).toBe(true);
  });

  it('still refuses extensions outside the list', () => {
    expect(ALLOWED_EXTENSIONS.has('plpython3u')).toBe(false);
  });
});
