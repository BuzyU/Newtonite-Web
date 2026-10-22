import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';
import { pool } from '../src/db.js';
import { env } from '../src/env.js';
import { setTokenValidator, TokenValidator, SupabaseUser } from '../src/tokenValidator.js';

class MockTokenValidator implements TokenValidator {
  constructor(private fn: (token: string) => Promise<SupabaseUser>) {}
  async validate(accessToken: string): Promise<SupabaseUser> {
    return this.fn(accessToken);
  }
}

describe('Optional Continue with Google via Supabase Auth', () => {
  const originalFlag = env.GOOGLE_LOGIN_ENABLED;

  afterAll(() => {
    env.GOOGLE_LOGIN_ENABLED = originalFlag;
    setTokenValidator(null);
  });

  it('returns 404 NOT_FOUND when GOOGLE_LOGIN_ENABLED is false', async () => {
    env.GOOGLE_LOGIN_ENABLED = false;

    const res = await request(app)
      .post('/api/v1/auth/google')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ accessToken: 'any-token' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 401 INVALID_TOKEN when Supabase token is invalid or expired', async () => {
    env.GOOGLE_LOGIN_ENABLED = true;

    setTokenValidator(
      new MockTokenValidator(async () => {
        const err = new Error('Supabase token verification failed');
        (err as any).status = 401;
        throw err;
      })
    );

    const res = await request(app)
      .post('/api/v1/auth/google')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ accessToken: 'invalid-token-123' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('returns 403 UNVERIFIED_EMAIL when email is missing or not verified by Google', async () => {
    env.GOOGLE_LOGIN_ENABLED = true;

    setTokenValidator(
      new MockTokenValidator(async () => ({
        id: 'supabase-user-unverified',
        email: 'unverified.user@gmail.com',
        email_confirmed_at: null,
        app_metadata: { provider: 'google' },
        user_metadata: { email_verified: false },
      }))
    );

    const res = await request(app)
      .post('/api/v1/auth/google')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ accessToken: 'unverified-token' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNVERIFIED_EMAIL');
  });

  it('never authenticates an existing user if the email is unverified', async () => {
    env.GOOGLE_LOGIN_ENABLED = true;

    setTokenValidator(
      new MockTokenValidator(async () => ({
        id: 'attacker-supabase-uuid-666',
        email: 'marcus.lead@newtonite.local',
        email_confirmed_at: null,
        app_metadata: { provider: 'google' },
        user_metadata: { email_verified: false },
      }))
    );

    const beforeCheck = await pool.query(
      `SELECT count(*)::int as count FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE LOWER(u.email) = 'marcus.lead@newtonite.local'`
    );

    const res = await request(app)
      .post('/api/v1/auth/google')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ accessToken: 'attacker-unverified-marcus-token' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNVERIFIED_EMAIL');
    expect(res.headers['set-cookie']).toBeUndefined();

    // Confirm no session was created for this attempt
    const afterCheck = await pool.query(
      `SELECT count(*)::int as count FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE LOWER(u.email) = 'marcus.lead@newtonite.local'`
    );
    expect(afterCheck.rows[0].count).toBe(beforeCheck.rows[0].count);
  });

  it('rejects provider tokens that do not come from Google provider', async () => {
    env.GOOGLE_LOGIN_ENABLED = true;

    setTokenValidator(
      new MockTokenValidator(async () => ({
        id: 'supabase-github-user-123',
        email: 'priya.lead@newtonite.local',
        email_confirmed_at: '2026-01-01T00:00:00Z',
        app_metadata: { provider: 'github' },
      }))
    );

    const res = await request(app)
      .post('/api/v1/auth/google')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ accessToken: 'github-token' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNVERIFIED_EMAIL');
  });

  it('returns 403 NOT_INVITED when verified Google email does not belong to any local team user', async () => {
    env.GOOGLE_LOGIN_ENABLED = true;

    setTokenValidator(
      new MockTokenValidator(async () => ({
        id: 'supabase-stranger-id',
        email: 'uninvited.operator@external.com',
        email_confirmed_at: '2026-01-01T00:00:00Z',
        app_metadata: { provider: 'google' },
      }))
    );

    const res = await request(app)
      .post('/api/v1/auth/google')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ accessToken: 'stranger-token' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_INVITED');
    expect(res.body.error.message).toBe('Ask your team admin to add you.');

    // Verify user was never created
    const checkRes = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [
      'uninvited.operator@external.com',
    ]);
    expect(checkRes.rows.length).toBe(0);
  });

  it('authenticates a known invited email, mints a Postgres session cookie, and returns team scopes', async () => {
    env.GOOGLE_LOGIN_ENABLED = true;

    setTokenValidator(
      new MockTokenValidator(async () => ({
        id: 'supabase-google-priya-uuid-123',
        email: 'priya.lead@newtonite.local',
        email_confirmed_at: '2026-01-01T00:00:00Z',
        app_metadata: { provider: 'google' },
      }))
    );

    const res = await request(app)
      .post('/api/v1/auth/google')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ accessToken: 'valid-priya-token' });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('priya.lead@newtonite.local');
    expect(res.body.user.teams.length).toBeGreaterThan(0);

    // Verify session cookie format
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieStr).toContain('newtonite_session=');
    expect(cookieStr.toLowerCase()).toContain('httponly');
    expect(cookieStr.toLowerCase()).toContain('samesite=lax');

    // Verify a session row was inserted in our sessions table
    const dbCheck = await pool.query(
      `SELECT s.id FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE LOWER(u.email) = 'priya.lead@newtonite.local'
         AND s.revoked_at IS NULL
       ORDER BY s.created_at DESC
       LIMIT 1`
    );
    expect(dbCheck.rows).toHaveLength(1);

    // Second login returns the same user id
    const resSecond = await request(app)
      .post('/api/v1/auth/google')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ accessToken: 'valid-priya-token' });

    expect(resSecond.status).toBe(200);
    expect(resSecond.body.user.id).toBe(res.body.user.id);
  });

  it('returns 403 UNVERIFIED_EMAIL for the same email from a different provider', async () => {
    // Without external_id, we rely on email + provider check.
    // An attacker using a different provider (e.g. github) won't pass the provider=google gate.
    env.GOOGLE_LOGIN_ENABLED = true;

    setTokenValidator(
      new MockTokenValidator(async () => ({
        id: 'attacker-different-provider-999',
        email: 'priya.lead@newtonite.local',
        email_confirmed_at: '2026-01-01T00:00:00Z',
        app_metadata: { provider: 'github' },
      }))
    );

    const res = await request(app)
      .post('/api/v1/auth/google')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ accessToken: 'attacker-token' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNVERIFIED_EMAIL');
  });
});
