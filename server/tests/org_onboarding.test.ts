import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { app, authenticatedRequest, loginAs, AuthContext } from './helpers.js';
import { pool } from '../src/db.js';

describe('Organization Onboarding and Admin User Provisioning', () => {
  let adminAuth: AuthContext;
  let normalMemberAuth: AuthContext;

  beforeAll(async () => {
    adminAuth = await loginAs('admin@newtonite.local');
    normalMemberAuth = await loginAs('elena.member@newtonite.local');
  });

  describe('POST /api/v1/auth/register-org', () => {
    it('rejects registration with missing required fields with 422', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register-org')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({
          orgName: '',
          adminEmail: 'invalid',
          password: 'short',
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toBeDefined();
    });

    it('rejects duplicate email with 409 EMAIL_ALREADY_EXISTS', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register-org')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({
          orgName: 'Duplicate Org',
          adminName: 'Alice Admin',
          adminEmail: 'admin@newtonite.local', // Already exists in seed
          password: 'SecureAdminPassword#2026!',
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    });

    it('successfully creates an organization, admin account, default teams, and establishes session', async () => {
      const uniqueSuffix = crypto.randomBytes(4).toString('hex');
      const testEmail = `founder.${uniqueSuffix}@acme-corp.test`;
      const testOrgName = `Acme Enterprise ${uniqueSuffix}`;
      const testPassword = `SecureP@ss${uniqueSuffix}99`;

      const res = await request(app)
        .post('/api/v1/auth/register-org')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({
          orgName: testOrgName,
          adminName: 'Acme Founder',
          adminEmail: testEmail,
          password: testPassword,
        });

      expect(res.status).toBe(201);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe(testEmail);
      expect(res.body.user.name).toBe('Acme Founder');
      expect(res.body.user.is_org_admin).toBe(true);

      // Verify Set-Cookie header exists and sets session
      const cookieHeader = res.headers['set-cookie'];
      expect(cookieHeader).toBeDefined();
      const hasSession = Array.isArray(cookieHeader)
        ? cookieHeader.some((c) => c.includes('newtonite_session='))
        : (cookieHeader as string).includes('newtonite_session=');
      expect(hasSession).toBe(true);

      // Verify organization was persisted in database
      const orgRes = await pool.query('SELECT * FROM organizations WHERE name = $1', [testOrgName]);
      expect(orgRes.rows.length).toBe(1);
      const createdOrgId = orgRes.rows[0].id;

      // Verify default teams were created
      const teamsRes = await pool.query('SELECT * FROM teams WHERE org_id = $1', [createdOrgId]);
      expect(teamsRes.rows.length).toBe(3);
      const slugs = teamsRes.rows.map((t) => t.slug);
      expect(slugs).toContain('operations');
      expect(slugs).toContain('engineering');
      expect(slugs).toContain('payments');

      // Verify admin membership in default teams
      const membershipRes = await pool.query(
        `SELECT tm.* FROM team_memberships tm
         JOIN users u ON u.id = tm.user_id
         WHERE u.email = $1`,
        [testEmail]
      );
      expect(membershipRes.rows.length).toBe(3);
      for (const m of membershipRes.rows) {
        expect(m.role).toBe('admin');
      }

      // Verify the new administrator can log in using their credentials
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({
          email: testEmail,
          password: testPassword,
        });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.user.is_org_admin).toBe(true);
    });
  });

  describe('GET /api/v1/admin/users', () => {
    it('forbids normal non-admin members with 403', async () => {
      const client = authenticatedRequest(normalMemberAuth);
      const res = await client.get('/api/v1/admin/users');
      expect(res.status).toBe(403);
    });

    it('returns the organization user roster for an organization admin', async () => {
      const client = authenticatedRequest(adminAuth);
      const res = await client.get('/api/v1/admin/users');
      expect(res.status).toBe(200);
      expect(res.body.users).toBeInstanceOf(Array);
      expect(res.body.users.length).toBeGreaterThan(0);

      const first = res.body.users[0];
      expect(first.email).toBeDefined();
      expect(first.name).toBeDefined();
      expect(typeof first.isOrgAdmin).toBe('boolean');
      expect(first.teams).toBeInstanceOf(Array);
    });
  });

  describe('POST /api/v1/admin/users', () => {
    it('forbids normal non-admin members from creating users with 403', async () => {
      const client = authenticatedRequest(normalMemberAuth);
      const res = await client.post('/api/v1/admin/users').send({
        name: 'Hacker User',
        email: 'hacker@test.com',
      });
      expect(res.status).toBe(403);
    });

    it('allows org admin to provision a new user with temporary password and team assignment', async () => {
      const client = authenticatedRequest(adminAuth);
      const uniqueHex = crypto.randomBytes(4).toString('hex');
      const newEmail = `dev.${uniqueHex}@newtonite.local`;
      const newName = `Provisioned Dev ${uniqueHex}`;
      const tempPass = `TempPass!${uniqueHex}9`;

      // Get an existing team in Marcus's org
      const teamsRes = await client.get('/api/v1/teams');
      expect(teamsRes.status).toBe(200);
      const targetTeam = teamsRes.body.teams[0];

      const res = await client.post('/api/v1/admin/users').send({
        name: newName,
        email: newEmail,
        password: tempPass,
        isOrgAdmin: false,
        teamId: targetTeam.id,
        role: 'member',
      });

      expect(res.status).toBe(201);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe(newEmail);
      expect(res.body.user.name).toBe(newName);
      expect(res.body.temporaryPassword).toBe(tempPass);

      // Verify the provisioned user can log in with the temporary password
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({
          email: newEmail,
          password: tempPass,
        });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.user.email).toBe(newEmail);
    });
  });
});
