import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { DEMO_PASSWORD } from '../src/seed.js';

export const app = createApp();

export interface AuthContext {
  cookie: string;
  user: {
    id: string;
    email: string;
    name: string;
    isOrgAdmin: boolean;
  };
}

/**
 * Logs in as a specific user and returns the session cookie for subsequent requests
 */
export async function loginAs(email: string): Promise<AuthContext> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('X-Requested-With', 'XMLHttpRequest')
    .send({
      email,
      password: DEMO_PASSWORD,
    });

  if (res.status !== 200) {
    throw new Error(`Failed to log in as ${email}: status ${res.status} body: ${JSON.stringify(res.body)}`);
  }

  const cookieHeader = res.headers['set-cookie'];
  const sessionCookie = Array.isArray(cookieHeader)
    ? cookieHeader.find(c => c.startsWith('newtonite_session=')) || cookieHeader[0]
    : (cookieHeader as string);

  return {
    cookie: sessionCookie.split(';')[0],
    user: res.body.user,
  };
}

/**
 * Creates an authorized Supertest agent pre-configured with session cookie and CSRF header
 */
export function authenticatedRequest(auth: AuthContext) {
  const agent = request(app);
  return {
    get: (url: string) => agent.get(url).set('Cookie', auth.cookie),
    post: (url: string) => agent.post(url).set('Cookie', auth.cookie).set('X-Requested-With', 'XMLHttpRequest'),
    patch: (url: string) => agent.patch(url).set('Cookie', auth.cookie).set('X-Requested-With', 'XMLHttpRequest'),
    delete: (url: string) => agent.delete(url).set('Cookie', auth.cookie).set('X-Requested-With', 'XMLHttpRequest'),
  };
}

/**
 * Retrieves the test team by slug
 */
export async function getTeamBySlug(slug: string): Promise<{ id: string; name: string; prefix: string }> {
  const res = await pool.query<{ id: string; name: string; prefix: string }>(
    'SELECT id, name, prefix FROM teams WHERE slug = $1',
    [slug]
  );
  if (res.rows.length === 0) {
    throw new Error(`Team with slug ${slug} not found in database.`);
  }
  return res.rows[0];
}

/**
 * Retrieves a user by email
 */
export async function getUserByEmail(email: string): Promise<{ id: string; name: string; email: string }> {
  const res = await pool.query<{ id: string; name: string; email: string }>(
    'SELECT id, name, email FROM users WHERE LOWER(email) = LOWER($1)',
    [email]
  );
  if (res.rows.length === 0) {
    throw new Error(`User with email ${email} not found.`);
  }
  return res.rows[0];
}
