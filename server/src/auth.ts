import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { pool, logger } from './db.js';
import { UserContext, TeamRole } from './policy.js';
import { env } from './env.js';
import {
  hashPassword,
  verifyPassword,
  getDummyHash,
  validatePasswordPolicy,
} from './passwords.js';
import {
  hitRateLimit,
  peekRateLimit,
  clearRateLimit,
  sendRateLimited,
  hashKey,
} from './pgRateLimit.js';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: UserContext;
      requestId?: string;
    }
  }
}

// ----------------------------------------------------------------------------
// Session model
//   - Opaque random token in an HttpOnly cookie; only sha256(token + pepper) is stored.
//   - remember-me:   30-day sliding expiry (90-day absolute cap), persistent cookie.
//   - session-only:  12h idle / 24h absolute, cookie without Max-Age.
// ----------------------------------------------------------------------------
const COOKIE_PLAIN = 'newtonite_session';
const COOKIE_HOST = '__Host-newtonite_session';

const REMEMBER_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const REMEMBER_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token + env.SESSION_SECRET).digest('hex');
}

function isSecureRequest(req: Request): boolean {
  const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
  return process.env.NODE_ENV === 'production' && !isLocalhost;
}

export function sessionCookieName(req: Request): string {
  return isSecureRequest(req) ? COOKIE_HOST : COOKIE_PLAIN;
}

function readSessionToken(req: Request): string | undefined {
  return req.cookies?.[COOKIE_HOST] || req.cookies?.[COOKIE_PLAIN];
}

/**
 * Cookie options: HttpOnly, SameSite=Lax, host-only (no Domain), Path=/, Secure in production.
 * `remember` adds a persistent Max-Age; otherwise it is a browser-session cookie.
 */
export function getCookieOptions(req: Request, remember = false) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecureRequest(req),
    path: '/',
    ...(remember ? { maxAge: REMEMBER_IDLE_MS } : {}),
  };
}

function clearSessionCookies(req: Request, res: Response): void {
  const opts = getCookieOptions(req);
  res.clearCookie(sessionCookieName(req), opts);
  // Also clear the other variant in case the deployment mode changed.
  res.clearCookie(sessionCookieName(req) === COOKIE_HOST ? COOKIE_PLAIN : COOKIE_HOST, opts);
}

export async function createSession(
  req: Request,
  res: Response,
  userId: string,
  remember: boolean
): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const idle = remember ? REMEMBER_IDLE_MS : SESSION_IDLE_MS;
  const absolute = remember ? REMEMBER_ABSOLUTE_MS : SESSION_ABSOLUTE_MS;

  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, remember, expires_at, absolute_expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      userId,
      hashToken(token),
      remember,
      new Date(now + idle),
      new Date(now + absolute),
      (req.ip || '').slice(0, 64),
      String(req.headers['user-agent'] || '').slice(0, 300),
    ]
  );

  res.cookie(sessionCookieName(req), token, getCookieOptions(req, remember));
}

async function revokeByToken(token: string | undefined): Promise<void> {
  if (!token) return;
  await pool.query(`UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL`, [
    hashToken(token),
  ]);
}

/**
 * CSRF defence: SameSite=Lax cookies, a mandatory custom header on every non-safe method,
 * and an Origin check when the browser sends one.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const fail = (message: string) => {
    res.status(403).json({
      error: { code: 'CSRF_VALIDATION_FAILED', message, requestId: req.requestId },
    });
  };

  const customHeader = req.headers['x-requested-with'] || req.headers['x-newtonite-csrf'];
  if (!customHeader) {
    return fail('Security validation failed: Request must include the custom header X-Requested-With.');
  }

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originOk = false;
    try {
      const o = new URL(origin);
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
      const appOrigin = env.APP_ORIGIN ? env.APP_ORIGIN.replace(/\/$/, '') : '';
      if (appOrigin && origin === appOrigin) originOk = true;
      else if (o.host === host) originOk = true;
      else if (process.env.NODE_ENV !== 'production' && (o.hostname === 'localhost' || o.hostname === '127.0.0.1')) {
        originOk = true;
      }
    } catch {
      originOk = false;
    }
    if (!originOk) {
      return fail('Security validation failed: Origin is not allowed.');
    }
  } else if (origin === 'null') {
    return fail('Security validation failed: Origin is not allowed.');
  }

  next();
}

const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  '/api/v1/auth/me',
  '/api/v1/auth/change-password',
  '/api/v1/auth/logout',
]);

function unauthenticated(req: Request, res: Response, code: string, message: string, status = 401): void {
  res.status(status).json({ error: { code, message, requestId: req.requestId } });
}

/**
 * Authentication middleware: resolves the Postgres session, checks idle/absolute expiry,
 * revocation, account and organization state, loads team memberships, and enforces the
 * must-change-password gate.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = readSessionToken(req);
  if (!token) {
    unauthenticated(req, res, 'UNAUTHENTICATED', 'Authentication session is required.');
    return;
  }

  try {
    const sRes = await pool.query<{
      sid: string;
      remember: boolean;
      expires_at: Date;
      absolute_expires_at: Date;
      revoked_at: Date | null;
      last_seen_at: Date;
      id: string;
      email: string;
      name: string;
      is_org_admin: boolean;
      is_active: boolean;
      must_change_password: boolean;
      org_id: string;
      org_status: string;
      org_name: string;
      org_slug: string;
    }>(
      `SELECT s.id AS sid, s.remember, s.expires_at, s.absolute_expires_at, s.revoked_at, s.last_seen_at,
              u.id, u.email, u.name, u.is_org_admin, u.is_active, u.must_change_password, u.org_id,
              o.status AS org_status, o.name AS org_name, o.slug AS org_slug
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN organizations o ON o.id = u.org_id
       WHERE s.token_hash = $1`,
      [hashToken(token)]
    );

    const row = sRes.rows[0];
    const now = Date.now();
    if (
      !row ||
      row.revoked_at ||
      row.expires_at.getTime() <= now ||
      row.absolute_expires_at.getTime() <= now
    ) {
      clearSessionCookies(req, res);
      unauthenticated(req, res, 'INVALID_SESSION', 'Your session has expired or is invalid. Please log in again.');
      return;
    }

    if (!row.is_active) {
      clearSessionCookies(req, res);
      unauthenticated(req, res, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated.');
      return;
    }
    if (row.org_status !== 'active') {
      unauthenticated(req, res, 'ORG_SUSPENDED', 'This organization is suspended.', 403);
      return;
    }

    // Sliding expiry, throttled to one write per minute per session.
    if (now - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
      const idle = row.remember ? REMEMBER_IDLE_MS : SESSION_IDLE_MS;
      const newExpiry = new Date(Math.min(now + idle, row.absolute_expires_at.getTime()));
      await pool.query(`UPDATE sessions SET last_seen_at = NOW(), expires_at = $2 WHERE id = $1`, [
        row.sid,
        newExpiry,
      ]);
      if (row.remember) {
        res.cookie(sessionCookieName(req), token, getCookieOptions(req, true));
      }
    }

    const memRes = await pool.query<{ team_id: string; role: TeamRole }>(
      `SELECT tm.team_id, tm.role FROM team_memberships tm
       JOIN teams t ON t.id = tm.team_id
       WHERE tm.user_id = $1 AND t.archived_at IS NULL`,
      [row.id]
    );
    const memberships = new Map<string, TeamRole>();
    for (const r of memRes.rows) memberships.set(r.team_id, r.role);

    req.user = {
      id: row.id,
      email: row.email,
      name: row.name,
      isOrgAdmin: row.is_org_admin,
      memberships,
      orgId: row.org_id,
      orgName: row.org_name,
      orgSlug: row.org_slug,
      mustChangePassword: row.must_change_password,
      sessionId: row.sid,
    };

    const path = req.originalUrl.split('?')[0];
    if (row.must_change_password && !PASSWORD_CHANGE_ALLOWED_PATHS.has(path)) {
      res.status(403).json({
        error: {
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: 'You must change your temporary password before continuing.',
          requestId: req.requestId,
        },
      });
      return;
    }

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

/** Requires an authenticated org admin. Must run after requireAuth. */
export function requireOrgAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.isOrgAdmin) {
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Organization admin access is required.', requestId: req.requestId },
    });
    return;
  }
  next();
}

async function buildUserPayload(user: {
  id: string;
  email: string;
  name: string;
  isOrgAdmin: boolean;
  orgId: string;
  orgName?: string;
  orgSlug?: string;
  mustChangePassword?: boolean;
}) {
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
     WHERE tm.user_id = $1 AND t.archived_at IS NULL
     ORDER BY t.name`,
    [user.id]
  );
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isOrgAdmin: user.isOrgAdmin,
    orgId: user.orgId,
    orgName: user.orgName,
    orgSlug: user.orgSlug,
    mustChangePassword: !!user.mustChangePassword,
    teams: teamsRes.rows.map((r) => ({
      teamId: r.team_id,
      teamName: r.name,
      teamSlug: r.slug,
      prefix: r.prefix,
      role: r.role,
    })),
  };
}

const GENERIC_LOGIN_ERROR = 'Incorrect email or password.';

/**
 * Login: argon2id verification with timing equalisation, generic errors, and Postgres-backed
 * rate limits (per IP+email, per account, per IP). Every login issues a NEW session
 * (prevents session fixation) and revokes any session presented with the request.
 */
export async function loginHandler(req: Request, res: Response): Promise<void> {
  const { email, password, remember } = req.body || {};

  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    res.status(422).json({
      error: { code: 'VALIDATION_ERROR', message: 'Both email and password are required.', requestId: req.requestId },
    });
    return;
  }
  if (password.length > 1024) {
    res.status(422).json({
      error: { code: 'VALIDATION_ERROR', message: 'Password is too long.', requestId: req.requestId },
    });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const WINDOW = 15 * 60;
  const pairKey = `${clientIp}|${hashKey(normalizedEmail)}`;
  const acctKey = hashKey(normalizedEmail);

  try {
    const [pair, acct, ip] = await Promise.all([
      peekRateLimit('login_pair', pairKey, 5, WINDOW),
      peekRateLimit('login_acct', acctKey, 10, WINDOW),
      peekRateLimit('login_ip', clientIp, 30, WINDOW),
    ]);
    const blocked = [pair, acct, ip].find((r) => !r.allowed);
    if (blocked) {
      sendRateLimited(
        req,
        res,
        blocked,
        `Too many failed login attempts. Please wait ${blocked.retryAfterSeconds} seconds before trying again.`
      );
      return;
    }

    const userRes = await pool.query<{
      id: string;
      email: string;
      password_hash: string;
      name: string;
      is_org_admin: boolean;
      is_active: boolean;
      must_change_password: boolean;
      org_id: string;
      org_status: string;
      org_name: string;
      org_slug: string;
    }>(
      `SELECT u.id, u.email, u.password_hash, u.name, u.is_org_admin, u.is_active, u.must_change_password,
              u.org_id, o.status AS org_status, o.name AS org_name, o.slug AS org_slug
       FROM users u JOIN organizations o ON o.id = u.org_id
       WHERE LOWER(u.email) = $1`,
      [normalizedEmail]
    );

    const user = userRes.rows[0];
    // Always run one argon2 verification so response time does not reveal account existence.
    const passwordValid = await verifyPassword(user ? user.password_hash : await getDummyHash(), password);

    if (!user || !passwordValid) {
      await Promise.all([
        hitRateLimit('login_pair', pairKey, 5, WINDOW),
        hitRateLimit('login_acct', acctKey, 10, WINDOW),
        hitRateLimit('login_ip', clientIp, 30, WINDOW),
      ]);
      res.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: GENERIC_LOGIN_ERROR, requestId: req.requestId },
      });
      return;
    }

    // Only after a correct password do we reveal account state.
    if (!user.is_active) {
      res.status(403).json({
        error: {
          code: 'ACCOUNT_DEACTIVATED',
          message: 'This account has been deactivated. Contact your organization admin.',
          requestId: req.requestId,
        },
      });
      return;
    }
    if (user.org_status !== 'active') {
      res.status(403).json({
        error: { code: 'ORG_SUSPENDED', message: 'This organization is suspended.', requestId: req.requestId },
      });
      return;
    }

    await clearRateLimit('login_pair', pairKey);
    await clearRateLimit('login_acct', acctKey);

    // Session fixation defence: drop any presented session, always mint a fresh token.
    await revokeByToken(readSessionToken(req));
    await createSession(req, res, user.id, remember === true);
    await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    res.status(200).json({
      user: await buildUserPayload({
        id: user.id,
        email: user.email,
        name: user.name,
        isOrgAdmin: user.is_org_admin,
        orgId: user.org_id,
        orgName: user.org_name,
        orgSlug: user.org_slug,
        mustChangePassword: user.must_change_password,
      }),
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
 * Optional Google SSO via Supabase: validates the Supabase access token,
 * confirms email verification, enforces Google provider, looks up the
 * pre-invited user by email (no auto-creation), and mints a Postgres session.
 * Disabled (404) unless GOOGLE_LOGIN_ENABLED=true.
 *
 * Note: external_id / auth_provider columns were removed in migration 006.
 * Linking is purely by normalized email. This is safe because Supabase is the
 * one who verified the Google identity.
 */
export async function googleLoginHandler(req: Request, res: Response): Promise<void> {
  if (!env.GOOGLE_LOGIN_ENABLED) {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Google Sign-In is not enabled for this deployment.', requestId: req.requestId },
    });
    return;
  }

  const { accessToken } = req.body || {};
  if (!accessToken || typeof accessToken !== 'string') {
    res.status(422).json({
      error: { code: 'VALIDATION_ERROR', message: 'accessToken is required.', requestId: req.requestId },
    });
    return;
  }

  const { getTokenValidator } = await import('./tokenValidator.js');
  const validator = getTokenValidator();

  let supabaseUser: import('./tokenValidator.js').SupabaseUser;
  try {
    supabaseUser = await validator.validate(accessToken);
  } catch {
    res.status(401).json({
      error: { code: 'INVALID_TOKEN', message: 'Supabase token verification failed.', requestId: req.requestId },
    });
    return;
  }

  // Require email_confirmed_at (Google verified the email)
  if (!supabaseUser.email_confirmed_at) {
    res.status(403).json({
      error: { code: 'UNVERIFIED_EMAIL', message: 'Google email is not verified.', requestId: req.requestId },
    });
    return;
  }

  // Require Google provider
  const provider = supabaseUser.app_metadata?.provider;
  if (provider !== 'google') {
    res.status(403).json({
      error: { code: 'UNVERIFIED_EMAIL', message: 'Only Google provider tokens are accepted.', requestId: req.requestId },
    });
    return;
  }

  const email = (supabaseUser.email || '').trim().toLowerCase();
  if (!email) {
    res.status(403).json({
      error: { code: 'UNVERIFIED_EMAIL', message: 'No verified email in token.', requestId: req.requestId },
    });
    return;
  }

  try {
    const userRes = await pool.query<{
      id: string; email: string; name: string; is_org_admin: boolean;
      is_active: boolean; must_change_password: boolean;
      org_id: string; org_status: string; org_name: string; org_slug: string;
    }>(
      `SELECT u.id, u.email, u.name, u.is_org_admin, u.is_active, u.must_change_password,
              u.org_id, o.status AS org_status, o.name AS org_name, o.slug AS org_slug
       FROM users u JOIN organizations o ON o.id = u.org_id
       WHERE LOWER(u.email) = $1`,
      [email]
    );

    const user = userRes.rows[0];
    if (!user) {
      res.status(403).json({
        error: { code: 'NOT_INVITED', message: 'Ask your team admin to add you.', requestId: req.requestId },
      });
      return;
    }

    if (!user.is_active) {
      res.status(403).json({
        error: { code: 'ACCOUNT_DEACTIVATED', message: 'This account has been deactivated.', requestId: req.requestId },
      });
      return;
    }
    if (user.org_status !== 'active') {
      res.status(403).json({
        error: { code: 'ORG_SUSPENDED', message: 'This organization is suspended.', requestId: req.requestId },
      });
      return;
    }

    await revokeByToken(readSessionToken(req));
    await createSession(req, res, user.id, false);
    await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    res.status(200).json({
      user: await buildUserPayload({
        id: user.id, email: user.email, name: user.name, isOrgAdmin: user.is_org_admin,
        orgId: user.org_id, orgName: user.org_name, orgSlug: user.org_slug,
        mustChangePassword: user.must_change_password,
      }),
    });
  } catch (err) {
    logger.error({ err, requestId: req.requestId }, 'Google SSO login failed');
    res.status(500).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'An internal error occurred.', requestId: req.requestId },
    });
  }
}

/** Logout: revokes the server-side session and clears the cookie. */
export async function logoutHandler(req: Request, res: Response): Promise<void> {
  try {
    await revokeByToken(readSessionToken(req));
  } catch (err) {
    logger.error({ err, requestId: req.requestId }, 'Failed revoking session on logout');
  }
  clearSessionCookies(req, res);
  res.status(200).json({ success: true, message: 'Logged out successfully.' });
}

/** Logout everywhere: revokes every session of the current user. */
export async function logoutAllHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  await pool.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
  clearSessionCookies(req, res);
  res.status(200).json({ success: true });
}

/** Change password: verifies the current one, enforces policy, revokes all OTHER sessions. */
export async function changePasswordHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const { currentPassword, newPassword } = req.body || {};

  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'currentPassword and newPassword are required.',
        requestId: req.requestId,
      },
    });
    return;
  }

  const rl = await hitRateLimit('change_password', user.id, 10, 15 * 60);
  if (!rl.allowed) {
    sendRateLimited(req, res, rl, `Too many attempts. Please wait ${rl.retryAfterSeconds} seconds.`);
    return;
  }

  const row = await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [user.id]);
  if (!row.rows[0] || !(await verifyPassword(row.rows[0].password_hash, currentPassword))) {
    res.status(401).json({
      error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.', requestId: req.requestId },
    });
    return;
  }

  const policyError = validatePasswordPolicy(newPassword, { email: user.email, name: user.name });
  if (policyError || newPassword === currentPassword) {
    res.status(422).json({
      error: {
        code: 'WEAK_PASSWORD',
        message: policyError || 'New password must be different from the current password.',
        requestId: req.requestId,
      },
    });
    return;
  }

  const newHash = await hashPassword(newPassword);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE users SET password_hash = $2, must_change_password = FALSE WHERE id = $1`, [
      user.id,
      newHash,
    ]);
    await client.query(
      `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [user.id, user.sessionId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.status(200).json({ success: true });
}

/** Current user identity endpoint (/api/v1/auth/me) */
export async function meHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    unauthenticated(req, res, 'UNAUTHENTICATED', 'No active session found.');
    return;
  }

  try {
    res.status(200).json({ user: await buildUserPayload(req.user) });
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

/** Deletes expired/revoked sessions (called from the maintenance job). */
export async function pruneSessions(): Promise<number> {
  const res = await pool.query(
    `DELETE FROM sessions
     WHERE revoked_at < NOW() - INTERVAL '7 days'
        OR absolute_expires_at < NOW() - INTERVAL '7 days'
        OR expires_at < NOW() - INTERVAL '7 days'`
  );
  return res.rowCount ?? 0;
}
