import pg from 'pg';
import fs from 'fs';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  name: 'newtonite-db',
  redact: {
    paths: [
      'password',
      'currentPassword',
      'newPassword',
      'temporaryPassword',
      'authorization',
      'cookie',
      '*.password',
      '*.currentPassword',
      '*.newPassword',
      '*.temporaryPassword',
      'req.headers.authorization',
      'req.headers.cookie',
      'generatedAdminCredentials',
    ],
    censor: '[REDACTED]',
  },
});

const { Pool, Client } = pg;

export interface DbConfig {
  connectionString: string;
  ssl?: pg.ConnectionConfig['ssl'];
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  keepAlive?: boolean;
  statement_timeout?: number;
}

export function parseDatabaseUrl(rawUrl?: string): { url: string; ssl: pg.ConnectionConfig['ssl'] } {
  const connectionUrl = rawUrl || process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/newtonite';
  
  let parsed: URL;
  try {
    parsed = new URL(connectionUrl);
  } catch {
    throw new Error(`Invalid DATABASE_URL format: ${connectionUrl}`);
  }

  const sslMode = parsed.searchParams.get('sslmode');
  // Strip sslmode from the URL so pg does not conflict with our ssl options object
  parsed.searchParams.delete('sslmode');
  const cleanUrl = parsed.toString();

  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';

  let ssl: pg.ConnectionConfig['ssl'] = false;

  if (process.env.DB_SSL_CA) {
    try {
      const ca = fs.existsSync(process.env.DB_SSL_CA)
        ? fs.readFileSync(process.env.DB_SSL_CA, 'utf8')
        : process.env.DB_SSL_CA;
      ssl = {
        rejectUnauthorized: true,
        ca,
      };
    } catch (caErr) {
      logger.warn({ err: caErr }, 'Failed reading DB_SSL_CA file; falling back to rejectUnauthorized: false');
      ssl = { rejectUnauthorized: false };
    }
  } else if (!isLocal || sslMode === 'require' || process.env.NODE_ENV === 'production') {
    ssl = { rejectUnauthorized: false };
  }

  return { url: cleanUrl, ssl };
}

const { url: defaultUrl, ssl: defaultSsl } = parseDatabaseUrl(process.env.DATABASE_URL);

if (process.env.NODE_ENV === 'test') {
  if (!defaultUrl.toLowerCase().includes('test')) {
    throw new Error(
      `[SAFETY GUARD ABORT]: Tests must run against a dedicated test database containing 'test' in DATABASE_URL. Found: ${defaultUrl}`
    );
  }
}

export const poolMax = parseInt(process.env.DB_POOL_MAX || '5', 10);

export const pool = new Pool({
  connectionString: defaultUrl,
  ssl: defaultSsl,
  max: poolMax,
  keepAlive: true,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 15000, // 15s query timeout to prevent hangs
});

export function setPoolMax(max: number): void {
  (pool as any).options.max = max;
}

// Critical: attach error handler so unhandled idle client error does not crash the Node process
pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle pg client in pool');
});

/**
 * Creates a dedicated long-lived Client for LISTEN/NOTIFY.
 * Must NOT be taken from the main transaction pool.
 */
export function createListenClient(customUrl?: string): pg.Client {
  const { url, ssl } = parseDatabaseUrl(customUrl || process.env.DATABASE_URL);
  const client = new Client({
    connectionString: url,
    ssl,
    keepAlive: true,
  });

  client.on('error', (err) => {
    logger.error({ err }, 'Error on dedicated LISTEN pg Client');
  });

  return client;
}

export default pool;
