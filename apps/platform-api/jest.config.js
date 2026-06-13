/** Jest config for platform-api unit tests. */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: { strictNullChecks: true, esModuleInterop: true } },
    ],
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@basefyio/blueprint$':
      '<rootDir>/../../../packages/blueprint/src/index.ts',
    // Strip .js extensions from ESM-style imports inside @basefyio/blueprint
    '^(\\.{1,2}/.+)\\.js$': '$1',
  },
};
