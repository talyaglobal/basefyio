import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { BigIntSerializationInterceptor } from './common/interceptors/bigint-serialization.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.use(helmet());

  const rawOrigins = process.env.CORS_ORIGIN || 'http://localhost:3000';
  const allowedOrigins = rawOrigins.split(',').map((o) => o.trim());
  const allowAll = allowedOrigins.includes('*');

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowAll || allowedOrigins.includes(origin)) {
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
