import { Injectable } from '@nestjs/common';
import { ISecretResolver } from '../interfaces/secret-resolver.interface';

/** Pass-through resolver for local/test environments: returns the path unchanged. */
@Injectable()
export class NoopSecretResolver implements ISecretResolver {
  async resolve(openbaoPath: string): Promise<string> {
    return openbaoPath;
  }
}
