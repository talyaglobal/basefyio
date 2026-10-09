import { SetMetadata } from '@nestjs/common';

export const API_KEY_SCOPE_KEY = 'api_key_scope';

/**
 * How much authority a route demands from an API key.
 *
 * A project has two keys. The service key is secret and server-side; the anon
 * key is public — it ships inside every customer's browser bundle, so anyone
 * who opens the network tab has it. A route that an anon key can reach is a
 * route the whole internet can reach.
 *
 *  - 'service'        the secret service key only: administration, DDL,
 *                     configuration, anything that reads across tenants.
 *  - 'authenticated'  an end user signed in to the project's own realm (anon
 *                     key + a verified Bearer JWT), or the service key.
 *  - 'anon'           genuinely public: sign-up, sign-in, and reads that
 *                     Postgres RLS already constrains.
 *
 * Declared on a handler or on a whole controller; the handler wins. The check
 * lives inside ApiKeyGuard rather than in a guard of its own, so a new route
 * on a controller marked 'service' is protected the moment it is written —
 * forgetting to add a guard cannot open a hole.
 *
 * Dashboard JWT callers are unaffected: they never carry an API key, and their
 * authority is settled by JwtAuthGuard and the management-permission checks.
 */
export type ApiKeyScope = 'service' | 'authenticated' | 'anon';

/** Secret service key only. Rejects the public anon key. */
export const ServiceKeyOnly = () => SetMetadata(API_KEY_SCOPE_KEY, 'service' as ApiKeyScope);

/** A signed-in end user of the project (or the service key). Rejects a bare anon key. */
export const AuthenticatedKeyOnly = () =>
  SetMetadata(API_KEY_SCOPE_KEY, 'authenticated' as ApiKeyScope);

/**
 * Explicitly public. Carve-out for a route on a controller that is otherwise
 * service-only — sign-up and sign-in being the obvious cases.
 */
export const AnonKeyAllowed = () => SetMetadata(API_KEY_SCOPE_KEY, 'anon' as ApiKeyScope);
