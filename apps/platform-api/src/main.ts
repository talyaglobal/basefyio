// Must precede every other import: the mail SDK reads its API base from the
// environment once, when it is first required.
import './mail-provider-env';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { BigIntSerializationInterceptor } from './common/interceptors/bigint-serialization.interceptor';

/**
 * Answer a body the parser could not read — malformed JSON, or one over the
 * size limit — with the same JSON error shape as every other error, instead of
 * Express' default HTML page.
 */
function bodyParseErrorHandler(err: any, _req: Request, res: Response, next: NextFunction) {
  const type = typeof err?.type === 'string' ? err.type : '';
  if (!type.startsWith('entity.') && !(err instanceof SyntaxError)) return next(err);
  const status = typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 400;
  const message =
    type === 'entity.too.large'
      ? 'Request body is too large'
      : type === 'entity.parse.failed' || err instanceof SyntaxError
        ? 'Malformed JSON in request body'
        : 'The request body could not be read';
  res.status(status).json({ statusCode: status, message, timestamp: new Date().toISOString() });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.use(
    helmet({
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      frameguard: { action: 'deny' },
      contentSecurityPolicy: false, // API doesn't serve HTML; CSP not needed
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  const rawOrigins =
    process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:3002';
  const allowedOrigins = rawOrigins.split(',').map((o) => o.trim()).filter((o) => o !== '*');

  app.enableCors({
    origin: (origin, callback) => {
      // Server-to-server requests (no origin header) are always allowed.
      if (!origin) return callback(null, true);
      // Dashboard / admin-ui origins — static allowlist.
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Every other origin is allowed on purpose: a customer builds a browser
      // app against their own project, and the SDK surface (rest/v1, sql,
      // storage) is authorised by the apikey header, which an attacker page
      // cannot obtain just by being open in the same browser.
      callback(null, true);
    },
    // Not credentialed, and that is what makes reflecting every origin safe.
    // Nothing here authenticates with cookies — tokens travel in the
    // Authorization header, which a page on another origin cannot read. With
    // credentials enabled, reflecting every origin would instead let any site
    // make authenticated requests for whoever is signed in. No client sends
    // credentials: 'include', so switching this off changes nothing today and
    // stops a future cookie from silently becoming a cross-site hole.
    credentials: false,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'apikey',
      'x-project-id',
      'prefer',
      'x-client-info',
      'x-supabase-api-version',
      // Optimistic concurrency on Data Engine documents (send back the ETag).
      'If-Match',
      // Paging the REST data API by header (`Range: 0-24`).
      'range',
      'range-unit',
    ],
    exposedHeaders: ['Content-Range', 'X-Total-Count', 'ETag', 'Preference-Applied', 'Range-Unit'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Body parsers come after CORS on purpose. A body that fails to parse ends
  // the request inside the parser; registered first, it answered before the
  // CORS headers were set, so a browser saw only "Failed to fetch" and could
  // not read the error at all.
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));
  app.use(bodyParseErrorHandler);

  // The Codefyio marketplace adapter is served at the root `/_codefyio/*`
  // (per its spec), so it is excluded from the global `/api` prefix.
  app.setGlobalPrefix('api', {
    exclude: [{ path: '_codefyio/(.*)', method: RequestMethod.ALL }],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new BigIntSerializationInterceptor());

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 4000);

  await app.listen(port);
  console.log(`Platform API running on http://localhost:${port}`);
}

bootstrap();
