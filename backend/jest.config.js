module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Test files share one Postgres database, and setup.ts wipes users/
  // categories/transactions globally in beforeAll — running files in
  // parallel workers races that wipe against other files' in-flight tests.
  maxWorkers: 1,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
  ],
  setupFiles: ['<rootDir>/src/test/setup.env.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
};
