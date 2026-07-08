import { SetMetadata } from '@nestjs/common';

export const SCOPES_KEY = 'required_scopes';

/** Declare the scope(s) a platform API token must hold to call this route. */
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);
