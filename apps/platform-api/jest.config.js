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
};
