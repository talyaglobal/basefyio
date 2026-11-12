import {
  classifySeverity,
  describeHttpRequest,
  parseResource,
  shouldPersistHttpAudit,
  statusFromError,
} from './http-audit-classifier';
import { ConflictException, NotFoundException } from '@nestjs/common';

const P = '4769a207-960c-49a5-a59c-5a81762e5f1d';

describe('classifySeverity', () => {
  it('keeps successful reads LOW and failed reads low unless refused', () => {
    expect(classifySeverity('GET', 200, true)).toBe('LOW');
    expect(classifySeverity('GET', 404, false)).toBe('LOW');
    expect(classifySeverity('GET', 403, false)).toBe('MEDIUM');
    expect(classifySeverity('GET', 500, false)).toBe('MEDIUM');
  });

  it('ranks writes by what they do', () => {
    expect(classifySeverity('PATCH', 200, true)).toBe('MEDIUM');
    expect(classifySeverity('DELETE', 200, true)).toBe('HIGH');
    expect(classifySeverity('POST', 403, false)).toBe('HIGH');
    expect(classifySeverity('POST', 409, false)).toBe('MEDIUM');
    expect(classifySeverity('DELETE', 200, true, 'CRITICAL')).toBe('CRITICAL');
  });
});

describe('parseResource', () => {
  it('uses the route pattern to tell ids from nouns', () => {
    expect(
      parseResource(`/api/projects/${P}/storage/buckets/avatars`, '/api/projects/:projectId/storage/buckets/:bucketName', {
        projectId: P,
        bucketName: 'avatars',
      }),
    ).toEqual({ resourceType: 'buckets', resourceId: 'avatars', projectId: P });
  });

  it('skips verbs and joins bare nouns', () => {
    expect(parseResource('/api/account/api-tokens/t-1/roll', '/api/account/api-tokens/:id/roll', { id: 't-1' })).toEqual({
      resourceType: 'api-tokens',
      resourceId: 't-1',
      projectId: null,
    });
    expect(parseResource(`/api/projects/${P}/auth/config`).resourceType).toBe('auth.config');
  });

  it('falls back to id-shaped segments without a pattern', () => {
    expect(parseResource(`/api/projects/${P}/branches/${P}`)).toMatchObject({ resourceType: 'branches', projectId: P });
  });
});

describe('describeHttpRequest', () => {
  it('names a permanent project deletion and rates it CRITICAL', () => {
    const d = describeHttpRequest({ method: 'DELETE', path: `/api/projects/${P}/permanent`, statusCode: 200, success: true });
    expect(d).toMatchObject({ event: 'project.deleted.permanent', resourceType: 'project', resourceId: P, severity: 'CRITICAL' });
  });

  it('tells a token roll from a revoke', () => {
    expect(describeHttpRequest({ method: 'POST', path: '/api/account/api-tokens/t1/roll', statusCode: 201, success: true }).event).toBe(
      'api_token.rolled',
    );
    expect(describeHttpRequest({ method: 'DELETE', path: '/api/account/api-tokens/t1', statusCode: 200, success: true }).event).toBe(
      'api_token.revoked',
    );
  });

  it('records which fields a PATCH changed, without secret values', () => {
    const d = describeHttpRequest({
      method: 'PATCH',
      path: `/api/projects/${P}`,
      statusCode: 200,
      success: true,
      body: { tags: ['a'], folderId: null, secretValue: 'x', name: 'n' },
    });
    expect(d.fields).toEqual(['tags', 'folderId', 'secretValue', 'name']);
    expect(d.changes).toEqual({ tags: ['a'], folderId: null, name: 'n' });
  });

  it('picks up the id of a created resource', () => {
    const d = describeHttpRequest({
      method: 'POST',
      path: `/api/projects/${P}/storage/buckets`,
      statusCode: 201,
      success: true,
      responseBody: { name: 'avatars' },
    });
    expect(d).toMatchObject({ event: 'storage.bucket.created', resourceType: 'storage_bucket', resourceId: 'avatars' });
  });
});

describe('shouldPersistHttpAudit', () => {
  const original = process.env.AUDIT_HTTP_READS;
  afterEach(() => {
    if (original === undefined) delete process.env.AUDIT_HTTP_READS;
    else process.env.AUDIT_HTTP_READS = original;
  });

  it('keeps writes and failures, drops routine reads, keeps secret reads', () => {
    delete process.env.AUDIT_HTTP_READS;
    expect(shouldPersistHttpAudit('POST', '/api/projects', true)).toBe(true);
    expect(shouldPersistHttpAudit('GET', '/api/projects', false)).toBe(true);
    expect(shouldPersistHttpAudit('GET', '/api/project-folders', true)).toBe(false);
    expect(shouldPersistHttpAudit('GET', `/api/projects/${P}/credentials`, true)).toBe(true);
  });

  it('AUDIT_HTTP_READS=all restores the old behaviour', () => {
    process.env.AUDIT_HTTP_READS = 'all';
    expect(shouldPersistHttpAudit('GET', '/api/project-folders', true)).toBe(true);
  });
});

describe('statusFromError', () => {
  it('reads Nest exceptions and defaults to 500', () => {
    expect(statusFromError(new NotFoundException())).toBe(404);
    expect(statusFromError(new ConflictException())).toBe(409);
    expect(statusFromError({ status: 429 })).toBe(429);
    expect(statusFromError(new Error('x'))).toBe(500);
  });
});

describe('credential reads', () => {
  it('keeps every hand-out of project credentials, as a named event', () => {
    delete process.env.AUDIT_HTTP_READS;
    expect(shouldPersistHttpAudit('GET', `/api/projects/${P}/connect`, true)).toBe(true);
    expect(
      describeHttpRequest({ method: 'GET', path: `/api/projects/${P}/connect`, statusCode: 200, success: true }),
    ).toMatchObject({ event: 'project.credentials.read', resourceType: 'project', resourceId: P, severity: 'MEDIUM' });
  });
});
