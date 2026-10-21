import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { pool } from './db.js';

/**
 * Postgres-backed fixed-window rate limiter. State lives in the `rate_limits` table so it is
 * shared by every serverless instance (an in-memory Map is per-instance and effectively useless
 * on Vercel). One atomic upsert per check.
 */
export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

export async function hitRateLimit(
  scope: string,
  key: string,
  max: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStartSec = nowSec - (nowSec % windowSeconds);
  const windowStart = new Date(windowStartSec * 1000);
  const res = await pool.query<{ count: number }>(
    `INSERT INTO rate_limits (scope, key, window_start, count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (scope, key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [scope, key.slice(0, 200), windowStart]
  );
  const count = res.rows[0].count;
  return {
    allowed: count <= max,
    count,
    retryAfterSeconds: Math.max(1, windowStartSec + windowSeconds - nowSec),
  };
}

/** Read-only check (does not increment). */
export async function peekRateLimit(scope: string, key: string, max: number, windowSeconds: number): Promise<RateLimitResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStartSec = nowSec - (nowSec % windowSeconds);
  const res = await pool.query<{ count: number }>(
    `SELECT count FROM rate_limits WHERE scope = $1 AND key = $2 AND window_start = $3`,
    [scope, key.slice(0, 200), new Date(windowStartSec * 1000)]
  );
  const count = res.rows[0]?.count ?? 0;
  return { allowed: count < max, count, retryAfterSeconds: Math.max(1, windowStartSec + windowSeconds - nowSec) };
}

export async function clearRateLimit(scope: string, key: string): Promise<void> {
  await pool.query(`DELETE FROM rate_limits WHERE scope = $1 AND key = $2`, [scope, key.slice(0, 200)]);
}

export async function pruneRateLimits(): Promise<number> {
  const res = await pool.query(`DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '2 hours'`);
  return res.rowCount ?? 0;
}

export function hashKey(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function sendRateLimited(req: Request, res: Response, r: RateLimitResult, message: string): void {
  res.setHeader('Retry-After', String(r.retryAfterSeconds));
  res.status(429).json({
    error: { code: 'RATE_LIMIT_EXCEEDED', message, requestId: req.requestId },
  });
}

/** Express middleware factory for per-IP limits on a route. */
export function pgIpRateLimiter(scope: string, max: number, windowSeconds: number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const r = await hitRateLimit(scope, `ip:${ip}`, max, windowSeconds);
      if (!r.allowed) {
        sendRateLimited(req, res, r, `Too many requests. Please wait ${r.retryAfterSeconds} seconds.`);
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
