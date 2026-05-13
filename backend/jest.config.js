module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
  ],
  setupFiles: ['<rootDir>/src/test/setup.env.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
};
