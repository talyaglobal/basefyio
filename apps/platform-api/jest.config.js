/** Jest config for platform-api unit tests. */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // esModuleInterop is on here but off in tsconfig.json, so specs may
        // write `import request from 'supertest'` and get the interop helper
        // at run time. The cost is that `import * as Docker from 'dockerode'`
        // — valid in the build, and used by the infrastructure service — is
        // then seen as non-constructable, which failed any spec that reached
        // that import chain before it ran a single assertion. The two
        // diagnostics below are exactly that mismatch and nothing else;
        // `tsc --noEmit` against tsconfig.json still type-checks the real
        // build, so nothing goes unchecked.
        tsconfig: { strictNullChecks: true, esModuleInterop: true },
        diagnostics: { ignoreCodes: [2349, 2351] },
      },
    ],
  },
  // The Keycloak admin client is ESM-only, so requiring it under ts-jest
  // throws before a single assertion runs — and it is imported, directly or
  // through a service, by a large part of the codebase. Unit tests inject
  // their own Keycloak double; this maps the package to an inert stub so the
  // import resolves. See test/keycloak-admin-client.stub.js.
  moduleNameMapper: {
    '^@keycloak/keycloak-admin-client$': '<rootDir>/../test/keycloak-admin-client.stub.js',
  },
  testEnvironment: 'node',
  // Jest's default is one worker per CPU core minus one. On a 16-core laptop that is 15 node processes, each
  // holding a ts-jest compiler, which freezes the machine while the suite runs. Two workers keep it usable;
  // CI (which has the machine to itself) uses half the cores. Override with JEST_WORKERS=<n> or --maxWorkers.
  maxWorkers: process.env.JEST_WORKERS || (process.env.CI ? '50%' : 2),
};
