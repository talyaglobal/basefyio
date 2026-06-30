import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Frozen account guard — no-op in the OSS edition.
 * The commercial billing/account-suspension logic has been removed.
 */
@Injectable()
export class FrozenAccountGuard implements CanActivate {
  async canActivate(_context: ExecutionContext): Promise<boolean> {
    return true;
  }
}
