import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, PayloadTooLargeException, UnauthorizedException } from '@nestjs/common';
import { StorageFacadeError, SupabaseStorageExceptionFilter, toStorageError } from './storage-facade.errors';

describe('toStorageError', () => {
  it('passes a StorageFacadeError through with its own HTTP status', () => {
    expect(toStorageError(StorageFacadeError.duplicate())).toEqual({
      status: 400,
      body: { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' },
    });
    expect(toStorageError(StorageFacadeError.payloadTooLarge()).status).toBe(413);
  });

  it('maps Nest exceptions to Supabase\'s names and HTTP 400', () => {
    expect(toStorageError(new NotFoundException('Bucket "x" not found'))).toEqual({
      status: 400,
      body: { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' },
    });
    expect(toStorageError(new NotFoundException('Object "x" not found')).body).toEqual({
      statusCode: '404',
      error: 'not_found',
      message: 'Object not found',
    });
    expect(toStorageError(new ConflictException('exists')).body).toEqual({
      statusCode: '409',
      error: 'Duplicate',
      message: 'The resource already exists',
    });
    expect(toStorageError(new ForbiddenException('no')).body).toEqual({ statusCode: '403', error: 'Unauthorized', message: 'no' });
    expect(toStorageError(new UnauthorizedException('Missing apikey')).body).toEqual({ statusCode: '401', error: 'Unauthorized', message: 'Missing apikey' });
    expect(toStorageError(new BadRequestException(['a must be b', 'c'])).body).toEqual({
      statusCode: '400',
      error: 'InvalidRequest',
      message: 'a must be b; c',
    });
  });

  it('keeps the HTTP status for codes clients act on', () => {
    expect(toStorageError(new PayloadTooLargeException('big')).status).toBe(413);
  });

  it('hides the detail of an unexpected error', () => {
    expect(toStorageError(new Error('db password is hunter2'))).toEqual({
      status: 500,
      body: { statusCode: '500', error: 'InternalError', message: 'Internal server error' },
    });
  });
});

describe('SupabaseStorageExceptionFilter', () => {
  function respond(exception: unknown, headersSent = false) {
    const res: any = {
      headersSent,
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      send: jest.fn(),
      destroy: jest.fn(),
    };
    const host: any = { switchToHttp: () => ({ getResponse: () => res }) };
    new SupabaseStorageExceptionFilter().catch(exception, host);
    return res;
  }

  it('writes the mapped body as JSON', () => {
    const res = respond(StorageFacadeError.notFound());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith({ statusCode: '404', error: 'not_found', message: 'Object not found' });
  });

  it('closes the connection when the headers already went out mid-stream', () => {
    const res = respond(new Error('stream broke'), true);
    expect(res.destroy).toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });
});
