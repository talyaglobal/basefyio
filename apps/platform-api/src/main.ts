import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
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
      // Allow server-to-server (no origin) and whitelisted origins only.
      // Never allow wildcard with credentials — browsers block it and it's insecure.
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'apikey',
      'x-project-id',
      'prefer',
      'x-client-info',
    ],
    exposedHeaders: ['Content-Range', 'X-Total-Count'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.setGlobalPrefix('api');

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
