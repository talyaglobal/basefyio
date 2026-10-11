// Must precede every other import: the mail SDK reads its API base from the
// environment once, when it is first required.
import './mail-provider-env';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { BigIntSerializationInterceptor } from './common/interceptors/bigint-serialization.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

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
    ],
    exposedHeaders: ['Content-Range', 'X-Total-Count'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

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
