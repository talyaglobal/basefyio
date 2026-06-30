import { IHetznerTokenResolver } from '../interfaces/hetzner-token-resolver.interface';

/**
 * In-memory test double for IHetznerTokenResolver.
 * Returns a preconfigured token without any external I/O.
 *
 * Use only in unit tests — never register this in production.
 */
export class MockHetznerTokenResolver implements IHetznerTokenResolver {
  private readonly callLog: string[] = [];

  constructor(private readonly token = 'mock-hetzner-token') {}

  async resolve(openbaoPath: string): Promise<string> {
    if (!openbaoPath || openbaoPath.trim() === '') {
      throw new Error('MockHetznerTokenResolver: openbaoPath must not be empty');
    }
    this.callLog.push(openbaoPath);
    return this.token;
  }

  /** Returns the list of paths that resolve() was called with. Useful in assertions. */
  calls(): string[] {
    return [...this.callLog];
  }

  wasCalled(): boolean {
    return this.callLog.length > 0;
  }
}
