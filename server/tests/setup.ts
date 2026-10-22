/**
 * Vitest Global Setup for Server Tests
 *
 * SAFETY GUARD: Aborts test execution if DATABASE_URL does not contain 'test'
 * to strictly prevent tests from ever running against demo or production databases.
 */
const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/newtonite_test';

if (!dbUrl.toLowerCase().includes('test')) {
  const errMsg = `[SAFETY GUARD ABORT]: Tests must run against a dedicated test database (e.g. newtonite_test), but DATABASE_URL="${dbUrl}" does not contain "test". Aborting test suite execution.`;
  console.error(errMsg);
  throw new Error(errMsg);
}

// Ensure process.env.DATABASE_URL is set so db.ts connects to the test database
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = dbUrl;
}
