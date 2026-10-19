import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { pool, logger } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 64-bit advisory lock key specific to newtonite migrations (hash of 'newtonite_migration_lock')
const MIGRATION_ADVISORY_LOCK_ID = 8492049102;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function runMigrations(customPool?: pg.Pool): Promise<MigrationResult> {
  const activePool = customPool || pool;
  const client = await activePool.connect();

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  try {
    logger.info('Acquiring migration advisory lock...');
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_ID]);
    logger.info('Migration advisory lock acquired.');

    // Ensure _migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Fetch already applied migrations
    const res = await client.query<{ name: string }>('SELECT name FROM _migrations ORDER BY id ASC');
    const appliedSet = new Set(res.rows.map(r => r.name));
    res.rows.forEach(r => alreadyApplied.push(r.name));

    // Look for migrations directory (handles both src/ migrations and dist/ migrations)
    const candidates = [
      path.resolve(__dirname, '../migrations'),
      path.resolve(__dirname, '../../migrations'),
      path.resolve(process.cwd(), 'migrations'),
      path.resolve(process.cwd(), 'server/migrations'),
    ];

    let migrationsDir = '';
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        migrationsDir = cand;
        break;
      }
    }

    if (!migrationsDir) {
      throw new Error(`Migrations directory not found in candidates: ${candidates.join(', ')}`);
    }

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    logger.info({ migrationsDir, count: files.length }, 'Discovered migration files');

    for (const file of files) {
      if (appliedSet.has(file)) {
        continue;
      }

      logger.info({ file }, `Applying migration: ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sqlContent = fs.readFileSync(filePath, 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sqlContent);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        logger.info({ file }, `Applied migration successfully: ${file}`);
      } catch (migrationErr) {
        await client.query('ROLLBACK');
        logger.error({ file, err: migrationErr }, `Migration failed: ${file}`);
        throw migrationErr;
      }
    }

    logger.info({ appliedCount: applied.length }, 'All migrations finished successfully.');
    return { applied, alreadyApplied };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_ID]);
      logger.info('Migration advisory lock released.');
    } catch (unlockErr) {
      logger.error({ err: unlockErr }, 'Failed to release migration advisory lock');
    }
    client.release();
  }
}

// If run directly from CLI
if (process.argv[1] && (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'))) {
  runMigrations()
    .then((result) => {
      console.log(`Migrations complete. Newly applied: ${result.applied.length}. Previously applied: ${result.alreadyApplied.length}.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
