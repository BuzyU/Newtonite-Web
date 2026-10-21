import { Request, Response, NextFunction } from 'express';

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const writeLimitMap = new Map<string, RateLimitRecord>();

// Clean up stale entries periodically
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of writeLimitMap.entries()) {
    if (now >= record.resetAt) {
      writeLimitMap.delete(key);
    }
  }
}, 60000);
cleanupInterval.unref();

export function resetWriteRateLimits(): void {
  writeLimitMap.clear();
}

/**
 * Middleware to protect mutating endpoints from runaway scripts and DoS.
 * Default: 120 writes per minute per user ID / IP.
 */
export function writeRateLimiter(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const maxWrites = parseInt(process.env.WRITE_RATE_LIMIT || '120', 10);
  const windowMs = 60 * 1000; // 1 minute
  const now = Date.now();

  const identifier = req.user?.id || req.ip || req.socket.remoteAddress || 'unknown';
  const key = `write:${identifier}`;

  let record = writeLimitMap.get(key);
  if (!record || now >= record.resetAt) {
    record = { count: 0, resetAt: now + windowMs };
    writeLimitMap.set(key, record);
  }

  record.count += 1;

  if (record.count > maxWrites) {
    const retryAfterSeconds = Math.ceil((record.resetAt - now) / 1000);
    res.setHeader('Retry-After', retryAfterSeconds.toString());
    res.status(429).json({
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: `Write rate limit exceeded. Please wait ${retryAfterSeconds} seconds before sending more write requests.`,
        requestId: req.requestId,
      },
    });
    return;
  }

  next();
}
