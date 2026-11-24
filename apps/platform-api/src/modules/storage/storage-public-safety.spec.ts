import { downloadOnlyHeaders, servedAs, withoutAnonymousListing } from './storage-public-safety';

const publicPolicy = (bucket: string, withListing: boolean) =>
  JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/*`] },
      ...(withListing
        ? [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:ListBucket'], Resource: [`arn:aws:s3:::${bucket}`] }]
        : []),
    ],
  });

describe('withoutAnonymousListing', () => {
  it('removes the anonymous ListBucket statement and keeps anonymous GetObject', () => {
    const next = JSON.parse(withoutAnonymousListing(publicPolicy('bf-p-docs', true))!);
    expect(next.Statement).toEqual([
      { Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::bf-p-docs/*'] },
    ]);
    expect(next.Version).toBe('2012-10-17');
  });

  it('leaves a policy without anonymous listing alone (null = nothing to write)', () => {
    expect(withoutAnonymousListing(publicPolicy('bf-p-docs', false))).toBeNull();
  });

  it('strips only the listing action from a mixed statement', () => {
    const mixed = JSON.stringify({
      Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject', 's3:ListBucket'], Resource: ['x'] }],
    });
    expect(JSON.parse(withoutAnonymousListing(mixed)!).Statement).toEqual([
      { Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: ['x'] },
    ]);
  });

  it('never touches a listing granted to a named principal', () => {
    const named = JSON.stringify({
      Statement: [{ Effect: 'Allow', Principal: { AWS: ['arn:aws:iam::1:user/app'] }, Action: ['s3:ListBucket'], Resource: ['x'] }],
    });
    expect(withoutAnonymousListing(named)).toBeNull();
  });

  it('treats a policy it cannot read as nothing to change', () => {
    expect(withoutAnonymousListing('not json')).toBeNull();
  });
});

describe('downloadOnlyHeaders', () => {
  it('stores pages, SVG, XML and scripts as downloads', () => {
    for (const t of ['text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'TEXT/HTML']) {
      expect(downloadOnlyHeaders(t)).toEqual({ 'Content-Disposition': 'attachment' });
    }
  });

  it('leaves images, video, PDFs and data files viewable in the browser', () => {
    for (const t of ['image/png', 'image/jpeg', 'video/mp4', 'application/pdf', 'text/plain', 'application/json', '', undefined]) {
      expect(downloadOnlyHeaders(t as any)).toEqual({});
    }
  });
});


/** N2: whatever type was stored, only safe types are shown in place. */
describe('servedAs', () => {
  it.each([
    'text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'application/xhtml+xml',
    'application/rss+xml', 'application/atom+xml', 'text/xml', 'application/javascript',
    'application/x-shockwave-flash', 'multipart/x-mixed-replace', '', undefined,
  ])('sends %p as an opaque download', (stored) => {
    expect(servedAs(stored as string | undefined, false)).toEqual({ contentType: 'application/octet-stream', inline: false });
  });

  it.each(['image/png', 'image/jpeg', 'video/mp4', 'audio/mpeg', 'application/pdf', 'text/plain; charset=utf-8', 'font/woff2'])(
    'shows %p in place unless a download was asked for',
    (stored) => {
      expect(servedAs(stored, false)).toEqual({ contentType: stored, inline: true });
      expect(servedAs(stored, true)).toEqual({ contentType: stored, inline: false });
    },
  );
});
