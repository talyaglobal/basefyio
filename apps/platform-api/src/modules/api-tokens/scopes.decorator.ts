import { SetMetadata } from '@nestjs/common';

export const SCOPES_KEY = 'required_scopes';
export const JWT_ONLY_KEY = 'platform_token_refused';

/**
 * Declare the scope(s) a platform API token must hold to call this route. A token request to a
 * route without @Scopes is refused (fail closed), so a route only becomes reachable with a token
 * once it names the scope that unlocks it. Convention: GET → `<resource>:read`, any other verb →
 * `<resource>:write` (`sql:run` for SQL).
 */
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);

/**
 * Mark a route on a token-enabled controller as dashboard-session only: a platform API token gets
 * 403 here whatever scopes it holds. Used for identity, ownership, security and payment actions.
 */
export const JwtOnly = () => SetMetadata(JWT_ONLY_KEY, true);
