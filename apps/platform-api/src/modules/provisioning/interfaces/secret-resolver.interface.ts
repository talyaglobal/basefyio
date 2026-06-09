export const SECRET_RESOLVER = 'SECRET_RESOLVER';

/**
 * Resolves an OpenBao/Vault path to its secret value.
 * The executor boundary never calls this directly — providers are responsible
 * for resolution. This interface is defined here to establish the contract
 * for future phases where the platform-api may pre-fetch secrets.
 */
export interface ISecretResolver {
  resolve(openbaoPath: string): Promise<string>;
}
