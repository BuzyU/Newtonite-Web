import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { pool, logger } from './db.js';
import { UserContext, TeamRole } from './policy.js';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: UserContext;
      requestId?: string;
    }
  }
}

const SESSION_COOKIE_NAME = 'newtonite_session';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev_session_secret_at_least_32_characters_long_newtonite_secure';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// In-memory rate limiting map for login attempts: key -> { count, resetAt }
const loginRateLimitMap = new Map<string, { count: number; resetAt: number }>();

function signSession(data: { userId: string; issuedAt: number }): string {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${hmac}`;
}

function verifySession(token: string): { userId: string; issuedAt: number } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedHmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedHmac))) {
    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (Date.now() - decoded.issuedAt > SESSION_MAX_AGE_MS) {
        return null; // Expired
      }
      return decoded;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Cookie options:
 * - httpOnly: true
 * - SameSite: Lax
 * - host-only: no Domain attribute
 * - Secure: true in production (off for localhost)
 */
export function getCookieOptions(req: Request) {
  const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
  const isSecure = process.env.NODE_ENV === 'production' && !isLocalhost;

  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecure,
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  };
}

/**
 * CSRF Defence Middleware:
 * SameSite cookie plus mandatory custom header (X-Requested-With) on all non-safe HTTP methods.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const customHeader = req.headers['x-requested-with'] || req.headers['x-newtonite-csrf'];
  if (!customHeader) {
    res.status(403).json({
      error: {
        code: 'CSRF_VALIDATION_FAILED',
        message: 'Security validation failed: Request must include the custom header X-Requested-With.',
        requestId: req.requestId,
      },
    });
    return;
  }

  next();
}

/**
 * Authentication Middleware:
 * Loads session, verifies validity, and populates req.user with memberships.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    res.status(401).json({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication session is required.',
        requestId: req.requestId,
      },
    });
    return;
  }

  const session = verifySession(token);
  if (!session) {
    res.clearCookie(SESSION_COOKIE_NAME, getCookieOptions(req));
    res.status(401).json({
      error: {
        code: 'INVALID_SESSION',
        message: 'Your session has expired or is invalid. Please log in again.',
        requestId: req.requestId,
      },
    });
    return;
  }

  try {
    const userRes = await pool.query<{
      id: string;
      email: string;
      name: string;
      is_org_admin: boolean;
      team_id: string | null;
      role: TeamRole | null;
    }>(
      `SELECT u.id, u.email, u.name, u.is_org_admin, tm.team_id, tm.role
       FROM users u
       LEFT JOIN team_memberships tm ON tm.user_id = u.id
       WHERE u.id = $1`,
      [session.userId]
    );

    if (userRes.rows.length === 0) {
      res.clearCookie(SESSION_COOKIE_NAME, getCookieOptions(req));
      res.status(401).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'Authenticated user no longer exists.',
          requestId: req.requestId,
        },
      });
      return;
    }

    const firstRow = userRes.rows[0];
    const memberships = new Map<string, TeamRole>();

    for (const r of userRes.rows) {
      if (r.team_id && r.role) {
        memberships.set(r.team_id, r.role);
      }
    }

    req.user = {
      id: firstRow.id,
      email: firstRow.email,
      name: firstRow.name,
      isOrgAdmin: firstRow.is_org_admin,
      memberships,
    };

    next();
  } catch (dbErr) {
    logger.error({ err: dbErr, requestId: req.requestId }, 'Error resolving authenticated user session');
    res.status(503).json({
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'Database query timed out during session verification.',
        requestId: req.requestId,
      },
    });
  }
}

/**
 * Login Handler with IP+email keyed rate limiting and generic error messages.
 */
export async function loginHandler(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body || {};

  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Both email and password are required.',
        requestId: req.requestId,
      },
    });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const rateLimitKey = `${clientIp}:${normalizedEmail}`;

  const now = Date.now();
  const rateLimitEntry = loginRateLimitMap.get(rateLimitKey);

  if (rateLimitEntry) {
    if (now < rateLimitEntry.resetAt) {
      if (rateLimitEntry.count >= 5) {
        const retryAfterSeconds = Math.ceil((rateLimitEntry.resetAt - now) / 1000);
        res.setHeader('Retry-After', retryAfterSeconds.toString());
        res.status(429).json({
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `Too many failed login attempts for this account. Please wait ${retryAfterSeconds} seconds before trying again.`,
            requestId: req.requestId,
          },
        });
        return;
      }
    } else {
      loginRateLimitMap.delete(rateLimitKey);
    }
  }

  try {
    const userRes = await pool.query<{
      id: string;
      email: string;
      password_hash: string;
      name: string;
      is_org_admin: boolean;
      team_id: string | null;
      role: TeamRole | null;
      team_name: string | null;
      team_slug: string | null;
    }>(
      `SELECT u.id, u.email, u.password_hash, u.name, u.is_org_admin,
              tm.team_id, tm.role, t.name as team_name, t.slug as team_slug
       FROM users u
       LEFT JOIN team_memberships tm ON tm.user_id = u.id
       LEFT JOIN teams t ON t.id = tm.team_id
       WHERE LOWER(u.email) = $1`,
      [normalizedEmail]
    );

    if (userRes.rows.length === 0) {
      // Record failed attempt
      const current = loginRateLimitMap.get(rateLimitKey) || { count: 0, resetAt: now + 15 * 60 * 1000 };
      current.count += 1;
      loginRateLimitMap.set(rateLimitKey, current);

      res.status(401).json({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password.',
          requestId: req.requestId,
        },
      });
      return;
    }

    const firstRow = userRes.rows[0];
    const passwordValid = await bcrypt.compare(password, firstRow.password_hash);

    if (!passwordValid) {
      const current = loginRateLimitMap.get(rateLimitKey) || { count: 0, resetAt: now + 15 * 60 * 1000 };
      current.count += 1;
      loginRateLimitMap.set(rateLimitKey, current);

      res.status(401).json({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password.',
          requestId: req.requestId,
        },
      });
      return;
    }

    // Reset rate limiter on successful login
    loginRateLimitMap.delete(rateLimitKey);

    // Create session cookie
    const token = signSession({ userId: firstRow.id, issuedAt: now });
    res.cookie(SESSION_COOKIE_NAME, token, getCookieOptions(req));

    const teamsList: Array<{ teamId: string; teamName: string; teamSlug: string; role: TeamRole }> = [];
    for (const r of userRes.rows) {
      if (r.team_id && r.role && r.team_name && r.team_slug) {
        teamsList.push({
          teamId: r.team_id,
          teamName: r.team_name,
          teamSlug: r.team_slug,
          role: r.role,
        });
      }
    }

    res.status(200).json({
      user: {
        id: firstRow.id,
        email: firstRow.email,
        name: firstRow.name,
        isOrgAdmin: firstRow.is_org_admin,
        teams: teamsList,
      },
    });
  } catch (err) {
    logger.error({ err, requestId: req.requestId }, 'Login execution failed');
    res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An internal error occurred during login authentication.',
        requestId: req.requestId,
      },
    });
  }
}

/**
 * Logout Handler: clears session cookie.
 */
export function logoutHandler(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, getCookieOptions(req));
  res.status(200).json({ success: true, message: 'Logged out successfully.' });
}

/**
 * Current user identity endpoint (/api/v1/auth/me)
 */
export async function meHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'No active session found.',
        requestId: req.requestId,
      },
    });
    return;
  }

  try {
    const teamsRes = await pool.query<{
      team_id: string;
      name: string;
      slug: string;
      prefix: string;
      role: TeamRole;
    }>(
      `SELECT tm.team_id, t.name, t.slug, t.prefix, tm.role
       FROM team_memberships tm
       JOIN teams t ON t.id = tm.team_id
       WHERE tm.user_id = $1`,
      [req.user.id]
    );

    res.status(200).json({
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        isOrgAdmin: req.user.isOrgAdmin,
        teams: teamsRes.rows.map(r => ({
          teamId: r.team_id,
          teamName: r.name,
          teamSlug: r.slug,
          prefix: r.prefix,
          role: r.role,
        })),
      },
    });
  } catch (err) {
    logger.error({ err, requestId: req.requestId }, 'Failed retrieving profile in /auth/me');
    res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve profile details.',
        requestId: req.requestId,
      },
    });
  }
}
