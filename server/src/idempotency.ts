import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import pg from 'pg';
import { pool, logger } from './db.js';

export interface IdempotencyContext {
  key: string;
  requestHash: string;
}

declare global {
  namespace Express {
    interface Request {
      idempotency?: IdempotencyContext;
    }
  }
}

/**
 * Middleware that validates and reserves the Idempotency-Key.
 * Uses atomic pool queries so database connections are returned to the pool immediately.
 */
export async function requireIdempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.headers['idempotency-key'];

  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    res.status(400).json({
      error: {
        code: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Mutating requests require an Idempotency-Key header.',
        requestId: req.requestId,
      },
    });
    return;
  }

  const sanitizedKey = key.trim();
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'User authentication required for idempotency tracking.',
        requestId: req.requestId,
      },
    });
    return;
  }

  const requestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(req.body || {}))
    .digest('hex');

  try {
    // 1. Check existing key record
    const existing = await pool.query<{
      status: 'in_progress' | 'completed' | 'failed';
      request_hash: string;
      response_status: number | null;
      response_body: any;
      response_headers: any;
      locked_until: Date;
    }>(
      `SELECT status, request_hash, response_status, response_body, response_headers, locked_until
       FROM idempotency_keys
       WHERE user_id = $1 AND key = $2`,
      [userId, sanitizedKey]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];

      // Check request hash match: different body -> 422
      if (row.request_hash !== requestHash) {
        res.status(422).json({
          error: {
            code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
            message: 'An existing request was already made with this Idempotency-Key but with different payload content.',
            requestId: req.requestId,
          },
        });
        return;
      }

      // If completed, replay the stored response
      if (row.status === 'completed' && row.response_status) {
        if (row.response_headers && typeof row.response_headers === 'object') {
          for (const [hKey, hVal] of Object.entries(row.response_headers)) {
            res.setHeader(hKey, hVal as string);
          }
        }
        res.setHeader('X-Idempotent-Replay', 'true');
        res.status(row.response_status).json(row.response_body);
        return;
      }

      // If in_progress, check lock expiration
      if (row.status === 'in_progress') {
        const now = new Date();
        if (new Date(row.locked_until) > now) {
          res.setHeader('Retry-After', '2');
          res.status(409).json({
            error: {
              code: 'REQUEST_IN_PROGRESS',
              message: 'A request with this Idempotency-Key is currently being processed. Please retry shortly.',
              requestId: req.requestId,
            },
          });
          return;
        }

        // Lease expired from a crashed attempt; reclaim it
        await pool.query(
          `UPDATE idempotency_keys
           SET status = 'in_progress', request_hash = $1, locked_until = NOW() + INTERVAL '1 minute', updated_at = NOW()
           WHERE user_id = $2 AND key = $3`,
          [requestHash, userId, sanitizedKey]
        );
      }
    } else {
      // First attempt: insert in_progress key row
      // ON CONFLICT DO NOTHING handles two truly simultaneous inserts
      const insertRes = await pool.query(
        `INSERT INTO idempotency_keys (user_id, key, request_hash, status, locked_until)
         VALUES ($1, $2, $3, 'in_progress', NOW() + INTERVAL '1 minute')
         ON CONFLICT (user_id, key) DO NOTHING
         RETURNING id`,
        [userId, sanitizedKey, requestHash]
      );

      if (insertRes.rows.length === 0) {
        // Simultaneous insert won race; re-fetch to handle
        const raceRes = await pool.query<{
          status: string;
          request_hash: string;
          response_status: number | null;
          response_body: any;
        }>(
          'SELECT status, request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
          [userId, sanitizedKey]
        );
        if (raceRes.rows.length > 0) {
          const raceRow = raceRes.rows[0];
          if (raceRow.request_hash !== requestHash) {
            res.status(422).json({
              error: {
                code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
                message: 'An existing request was already made with this Idempotency-Key but with different payload content.',
                requestId: req.requestId,
              },
            });
            return;
          }
          if (raceRow.status === 'completed' && raceRow.response_status) {
            res.setHeader('X-Idempotent-Replay', 'true');
            res.status(raceRow.response_status).json(raceRow.response_body);
            return;
          }
          res.setHeader('Retry-After', '2');
          res.status(409).json({
            error: {
              code: 'REQUEST_IN_PROGRESS',
              message: 'A request with this Idempotency-Key is currently being processed. Please retry shortly.',
              requestId: req.requestId,
            },
          });
          return;
        }
      }
    }

    req.idempotency = {
      key: sanitizedKey,
      requestHash,
    };

    next();
  } catch (err: any) {
    logger.error({ err, key: sanitizedKey, requestId: req.requestId }, 'Failed processing idempotency check');
    res.status(500).json({
      error: {
        code: 'IDEMPOTENCY_ERROR',
        message: 'Database error occurred during idempotency validation.',
        requestId: req.requestId,
      },
    });
  }
}

/**
 * Saves completed idempotency response within the given transaction client.
 */
export async function completeIdempotency(
  client: pg.PoolClient,
  userId: string,
  key: string,
  status: number,
  body: any,
  headers?: Record<string, string>
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
     SET status = 'completed',
         response_status = $1,
         response_body = $2,
         response_headers = $3,
         updated_at = NOW()
     WHERE user_id = $4 AND key = $5`,
    [status, JSON.stringify(body), headers ? JSON.stringify(headers) : null, userId, key]
  );
}
