import { isBeta, releaseStage } from './release-stage';

describe('releaseStage', () => {
  const previous = process.env.RELEASE_STAGE;
  afterEach(() => {
    if (previous === undefined) delete process.env.RELEASE_STAGE;
    else process.env.RELEASE_STAGE = previous;
  });

  it('is beta when nothing says otherwise', () => {
    delete process.env.RELEASE_STAGE;
    expect(releaseStage()).toBe('beta');
    expect(isBeta()).toBe(true);
  });

  it('is beta for anything that is not an explicit ga', () => {
    process.env.RELEASE_STAGE = 'BETA';
    expect(isBeta()).toBe(true);
    process.env.RELEASE_STAGE = 'preview';
    expect(isBeta()).toBe(true);
  });

  it('is ga only when written down', () => {
    process.env.RELEASE_STAGE = ' GA ';
    expect(releaseStage()).toBe('ga');
    expect(isBeta()).toBe(false);
  });
});
