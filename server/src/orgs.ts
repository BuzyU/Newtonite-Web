import { Request, Response } from 'express';
import { z } from 'zod';
import { pool, logger } from './db.js';
import { createSession } from './auth.js';
import { hashPassword, validatePasswordPolicy } from './passwords.js';
import { hitRateLimit, sendRateLimited } from './pgRateLimit.js';

export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,48})[a-z0-9]$/;
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'www', 'login', 'signup', 'orgs', 'new', 'static', 'assets', 'support', 'help',
]);

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function derivePrefix(name: string, taken: Set<string>): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const base = (letters.slice(0, 3) || 'TEAM').padEnd(3, 'X');
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base.slice(0, 3)}${n++}`;
  }
  return candidate;
}

const CreateOrgSchema = z
  .object({
    orgName: z.string().trim().min(2).max(120),
    slug: z.string().trim().toLowerCase().optional(),
    adminName: z.string().trim().min(1).max(100),
    adminEmail: z.string().trim().toLowerCase().email().max(255),
    password: z.string().max(1024),
    teams: z
      .array(z.object({ name: z.string().trim().min(2).max(100) }).strict())
      .max(10)
      .optional(),
  })
  .strict();

function validSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug) && !RESERVED_SLUGS.has(slug);
}

/** GET /orgs/slug-available?slug=acme */
export async function slugAvailableHandler(req: Request, res: Response): Promise<void> {
  const slug = String(req.query.slug || '').trim().toLowerCase();
  if (!validSlug(slug)) {
    res.status(200).json({ slug, available: false, reason: 'invalid' });
    return;
  }
  const r = await pool.query('SELECT 1 FROM organizations WHERE slug = $1', [slug]);
  res.status(200).json({ slug, available: r.rows.length === 0, reason: r.rows.length ? 'taken' : null });
}

/**
 * POST /orgs: sign-up wizard backend. Creates the organization, first org admin, optional
 * starter teams (the admin joins each as team admin) and the first session in ONE transaction.
 */
export async function createOrgHandler(req: Request, res: Response): Promise<void> {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const rl = await hitRateLimit('org_create', ip, 5, 60 * 60);
  if (!rl.allowed) {
    sendRateLimited(req, res, rl, `Too many sign-ups from this address. Try again in ${rl.retryAfterSeconds} seconds.`);
    return;
  }

  const parsed = CreateOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid organization details.',
        details: parsed.error.flatten(),
        requestId: req.requestId,
      },
    });
    return;
  }
  const data = parsed.data;
  const slug = data.slug || slugify(data.orgName);

  if (!validSlug(slug)) {
    res.status(422).json({
      error: {
        code: 'INVALID_SLUG',
        message: 'Organization URL must be 3-50 characters: lowercase letters, numbers and hyphens.',
        requestId: req.requestId,
      },
    });
    return;
  }

  const policyError = validatePasswordPolicy(data.password, { email: data.adminEmail, name: data.adminName });
  if (policyError) {
    res.status(422).json({
      error: { code: 'WEAK_PASSWORD', message: policyError, requestId: req.requestId },
    });
    return;
  }

  const passwordHash = await hashPassword(data.password);
  const teamNames = data.teams && data.teams.length > 0 ? data.teams.map((t) => t.name) : ['General'];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orgRes = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [data.orgName, slug]
    );
    const orgId = orgRes.rows[0].id;

    const userRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, is_org_admin, org_id)
       VALUES ($1, $2, $3, TRUE, $4) RETURNING id`,
      [data.adminEmail, passwordHash, data.adminName, orgId]
    );
    const userId = userRes.rows[0].id;

    const takenPrefixes = new Set<string>();
    const takenSlugs = new Set<string>();
    for (const name of teamNames) {
      const prefix = derivePrefix(name, takenPrefixes);
      takenPrefixes.add(prefix);
      let teamSlug = slugify(name) || 'team';
      let n = 2;
      while (takenSlugs.has(teamSlug)) teamSlug = `${slugify(name) || 'team'}-${n++}`;
      takenSlugs.add(teamSlug);

      const teamRes = await client.query<{ id: string }>(
        `INSERT INTO teams (name, slug, prefix, item_counter, org_id) VALUES ($1, $2, $3, 1000, $4) RETURNING id`,
        [name, teamSlug, prefix, orgId]
      );
      await client.query(`INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [
        teamRes.rows[0].id,
        userId,
      ]);
    }

    await client.query(
      `INSERT INTO admin_audit_log (org_id, actor_id, action, target_type, target_id, details)
       VALUES ($1, $2, 'org.created', 'organization', $1::text, $3)`,
      [orgId, userId, JSON.stringify({ slug, teams: teamNames.length })]
    );

    await client.query('COMMIT');

    await createSession(req, res, userId, false);
    res.status(201).json({
      organization: { id: orgId, name: data.orgName, slug },
      user: { id: userId, email: data.adminEmail, name: data.adminName, isOrgAdmin: true, orgId },
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (err?.code === '23505') {
      const constraint: string = err.constraint || '';
      if (constraint.includes('slug') && !constraint.includes('teams')) {
        res.status(409).json({
          error: { code: 'SLUG_TAKEN', message: 'That organization URL is already taken.', requestId: req.requestId },
        });
        return;
      }
      if (constraint.includes('email')) {
        res.status(409).json({
          error: {
            code: 'EMAIL_TAKEN',
            message: 'An account with that email already exists.',
            requestId: req.requestId,
          },
        });
        return;
      }
      res.status(409).json({
        error: { code: 'CONFLICT', message: 'Some details already exist.', requestId: req.requestId },
      });
      return;
    }
    logger.error({ err, requestId: req.requestId }, 'Organization creation failed');
    res.status(500).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Could not create the organization.', requestId: req.requestId },
    });
  } finally {
    client.release();
  }
}
