// Must precede every other import: the mail SDK reads its API base from the
// environment once, when it is first required.
import './mail-provider-env';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { BigIntSerializationInterceptor } from './common/interceptors/bigint-serialization.interceptor';
import { drainState } from './common/utils/drain-state';
import { RealtimeStreamService } from './common/realtime/realtime-stream.service';
import { RealtimeDataService } from './modules/realtime-data/realtime-data.service';
import {
  STORAGE_REQUEST_TIMEOUT_MS,
  isFormBody,
  isJsonBody,
  rewriteSupabasePaths,
} from './common/middleware/supabase-paths.middleware';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // How many proxies stand between the client and this process: Traefik is
  // one, a load balancer in front of it makes two. Express then derives
  // `req.ip` from the right-most X-Forwarded-For hop a trusted proxy did not
  // add, which is what the rate limiters, sign-in audit and realtime keys use.
  app.set('trust proxy', trustedProxyHops());

  // Supabase-compatible paths (`/auth/v1/…` at the root, `/api/p/<projectId>/…`),
  // before anything reads the URL — see the middleware for the shapes.
  app.use(rewriteSupabasePaths);

  // Nest's own parsers keep req.rawBody (the app was created with rawBody: true); registering
  // express.json() here instead made Nest skip its parser, and the Stripe webhook, which verifies
  // the signature over the raw bytes, could never see a body.
  //
  // A storage upload (`POST|PUT /storage/v1/object/<bucket>/<path>`) is the file itself,
  // streamed; when the file happens to be JSON the parser would swallow it before the
  // route could stream it to the store. The `type` predicate leaves those bodies alone;
  // the object routes that do take JSON (list, sign, move, copy, upload/sign) keep it.
  app.useBodyParser('json', { limit: '10mb', type: isJsonBody });
  app.useBodyParser('urlencoded', { extended: true, limit: '10mb', type: isFormBody });

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
      'x-bf-project',
      'prefer',
      'x-client-info',
      'x-supabase-api-version',
      // postgrest-js: schema selection, ranges, retries
      'accept-profile',
      'content-profile',
      'range',
      'range-unit',
      'x-retry-count',
      // storage-js: upsert, cache hints, resumable uploads
      'x-upsert',
      'cache-control',
      'tus-resumable',
      'upload-length',
      'upload-metadata',
      'upload-offset',
      'x-signature',
      'x-metadata',
    ],
    exposedHeaders: [
      'Content-Range',
      'X-Total-Count',
      'Link',
      'Preference-Applied',
      'Location',
      'X-Supabase-Api-Version',
      'Upload-Offset',
      'Upload-Length',
      'Tus-Resumable',
      // storage-js downloads: size, cache validation, file name, partial content
      'Content-Length',
      'ETag',
      'Content-Disposition',
      'Accept-Ranges',
    ],
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

  // Stopping without dropping anyone. The signal first marks the process as
  // draining — registered before Nest's own hook so the readiness route says
  // 503 before the listener closes — then Nest closes the server and lets the
  // requests in flight finish, and a deadline below Docker's 30 s grace
  // period (`stop_grace_period` in both compose files) makes sure a stuck
  // stream can never turn a restart into a kill.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      drainState.start();
      const server = app.getHttpServer();
      server.closeIdleConnections?.();
      // Streams are never idle, so they would hold the server open until the
      // deadline; tell their clients to reconnect elsewhere and end them now.
      const dashboardStreams = RealtimeStreamService.closeAllForDrain();
      let customerStreams = 0;
      try {
        customerStreams = app.get(RealtimeDataService, { strict: false }).closeAllForDrain();
      } catch {
        /* module not loaded in this build */
      }
      if (dashboardStreams + customerStreams > 0) {
        console.log(`Draining: asked ${dashboardStreams + customerStreams} realtime stream(s) to reconnect`);
      }
      setTimeout(() => process.exit(0), DRAIN_DEADLINE_MS).unref();
    });
  }
  app.enableShutdownHooks();

  await app.listen(port);

  // Longer than the proxy's idle timeout, so the proxy is never the one to
  // see a connection the API closed first (a race that surfaces as random
  // 502s under load).
  const server = app.getHttpServer();
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  // How long a client may take to send a whole request. Node applies one value
  // to every request, and a storage upload of a few hundred megabytes over a
  // slow link takes far longer than the two minutes everything else should. So
  // the server allows an upload's worth, and every request that is not one has
  // the old bound put back on its socket as an inactivity timeout below.
  server.requestTimeout = STORAGE_REQUEST_TIMEOUT_MS;

  console.log(`Platform API running on http://localhost:${port}`);
}

/** Below Docker's 30 s grace period, with room for the exit itself. */
const DRAIN_DEADLINE_MS = 25_000;

function trustedProxyHops(): number {
  const n = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

bootstrap();
