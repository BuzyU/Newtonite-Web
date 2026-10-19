import { describe, it, expect } from 'vitest';
import { pool } from '../src/db.js';

describe('Database Security: Row Level Security (RLS) enforcement', () => {
  it('every table in schema public has row level security enabled', async () => {
    const res = await pool.query<{ tablename: string; rowsecurity: boolean }>(`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename ASC
    `);

    expect(res.rows.length).toBeGreaterThan(0);

    const unprotectedTables: string[] = [];

    for (const row of res.rows) {
      // _migrations table is created by the migration runner; all application tables must have RLS
      if (row.tablename === '_migrations') continue;

      if (!row.rowsecurity) {
        unprotectedTables.push(row.tablename);
      }
    }

    expect(
      unprotectedTables,
      `The following tables in public schema lack Row Level Security (RLS): ${unprotectedTables.join(', ')}`
    ).toEqual([]);
  });
});
