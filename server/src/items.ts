import { Request, Response } from 'express';
import { z } from 'zod';
import { pool, logger } from './db.js';
import { can } from './policy.js';
import { validateTransition, ItemStatus } from './transitions.js';
import { completeIdempotency } from './idempotency.js';

// Input Schemas
const CreateItemSchema = z.object({
  teamId: z.string().uuid(),
  type: z.enum([
    'customer_issue',
    'engineering_problem',
    'payment_investigation',
    'production_incident',
    'compliance_request',
    'operational_task',
  ]),
  title: z.string().min(3).max(255),
  description: z.string().min(5),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).default('medium'),
  assigneeId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  requiresApproval: z.boolean().default(false),
  tags: z.array(z.string().max(50)).default([]),
}).strict();

const UpdateItemSchema = z.object({
  title: z.string().min(3).max(255).optional(),
  description: z.string().min(5).optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  tags: z.array(z.string().max(50)).optional(),
}).strict();

const TransitionItemSchema = z.object({
  status: z.enum([
    'new',
    'triaged',
    'in_progress',
    'blocked',
    'awaiting_approval',
    'resolved',
    'closed',
  ]).optional(),
  action: z.enum(['triage', 'start_progress', 'block', 'unblock', 'submit_approval', 'approve', 'reject', 'resolve', 'close', 'reopen']).optional(),
  note: z.string().optional(),
  resolutionNote: z.string().optional(),
  rejectionNote: z.string().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
}).strict();

const AddCommentSchema = z.object({
  content: z.string().min(1).max(10000),
}).strict();

/**
 * Helper to build SQL WHERE clause scoped strictly to the caller's organization and team memberships.
 * Every item query is pinned to the caller's org (cross-org access is indistinguishable from
 * not-found). Non-admins are additionally filtered to their own teams in SQL.
 * Uses a single bind parameter ($paramStartIndex = caller's user id).
 */
function buildMembershipFilter(userId: string, isOrgAdmin: boolean, paramStartIndex: number): { sql: string; params: any[] } {
  const orgSql = `items.org_id = (SELECT org_id FROM users WHERE id = $${paramStartIndex})`;
  if (isOrgAdmin) {
    return { sql: orgSql, params: [userId] };
  }
  return {
    sql: `(${orgSql} AND items.team_id IN (SELECT team_id FROM team_memberships WHERE user_id = $${paramStartIndex}))`,
    params: [userId],
  };
}

/**
 * Keyset cursor encoding/decoding: (last_activity_at, id)
 */
function encodeCursor(lastActivityAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: lastActivityAt.toISOString(), id })).toString('base64url');
}

function decodeCursor(cursorStr?: string): { lastActivityAt: string; id: string } | null {
  if (!cursorStr) return null;
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (parsed.t && parsed.id) return { lastActivityAt: parsed.t, id: parsed.id };
    return null;
  } catch {
    return null;
  }
}

/**
 * Escapes PostgreSQL LIKE/ILIKE wildcards (%, _, \) so substring searches
 * match user inputs literally rather than acting as pattern wildcards.
 */
function escapeIlike(str: string): string {
  return str.replace(/[\\%_]/g, '\\$&');
}

/**
 * List items with Keyset Pagination and SQL Scoping
 */
export async function listItemsHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const query = req.query;

  const limit = Math.min(Math.max(parseInt((query.limit as string) || '25', 10), 1), 100);
  const cursor = decodeCursor(query.cursor as string | undefined);

  const conditions: string[] = ['items.archived_at IS NULL'];
  const params: any[] = [];

  // 1. Mandatory SQL membership scoping
  const memFilter = buildMembershipFilter(user.id, user.isOrgAdmin, params.length + 1);
  conditions.push(memFilter.sql);
  params.push(...memFilter.params);

  // 2. Team filter
  if (query.team_id) {
    params.push(query.team_id);
    conditions.push(`items.team_id = $${params.length}`);
  }

  // 3. Status filter
  if (query.status) {
    const statusArr = (query.status as string).split(',').map(s => s.trim());
    params.push(statusArr);
    conditions.push(`items.status = ANY($${params.length})`);
  }

  // 4. Priority filter
  if (query.priority) {
    const prioArr = (query.priority as string).split(',').map(p => p.trim());
    params.push(prioArr);
    conditions.push(`items.priority = ANY($${params.length})`);
  }

  // 5. Type filter
  if (query.type) {
    const typeArr = (query.type as string).split(',').map(t => t.trim());
    params.push(typeArr);
    conditions.push(`items.type = ANY($${params.length})`);
  }

  // 6. Assignee filter: 'me', 'unassigned', or specific UUID
  if (query.assignee) {
    if (query.assignee === 'me') {
      params.push(user.id);
      conditions.push(`items.assignee_id = $${params.length}`);
    } else if (query.assignee === 'unassigned') {
      conditions.push('items.assignee_id IS NULL');
    } else {
      params.push(query.assignee);
      conditions.push(`items.assignee_id = $${params.length}`);
    }
  }

  // 7. Tags filter
  if (query.tags) {
    const tagsArr = (query.tags as string).split(',').map(t => t.trim());
    params.push(tagsArr);
    conditions.push(`items.tags && $${params.length}`);
  }

  // 8. Due date range
  if (query.due_from) {
    params.push(query.due_from);
    conditions.push(`items.due_at >= $${params.length}`);
  }
  if (query.due_to) {
    params.push(query.due_to);
    conditions.push(`items.due_at <= $${params.length}`);
  }

  let withCte = '';
  let joinHits = '';

  // 9. Search: Index-friendly UNION of full-text search and trigram substring search (T3)
  if (query.search && typeof query.search === 'string' && query.search.trim().length > 0) {
    const rawSearch = query.search.trim();
    const escapedSearch = escapeIlike(rawSearch);

    params.push(user.orgId, rawSearch, escapedSearch);
    const orgIdx = params.length - 2;
    const rawIdx = params.length - 1;
    const escIdx = params.length;

    withCte = `
      WITH hits AS (
        SELECT id FROM items WHERE org_id = $${orgIdx} AND archived_at IS NULL
          AND search_vector @@ websearch_to_tsquery('english', $${rawIdx})
        UNION
        SELECT id FROM items WHERE org_id = $${orgIdx} AND archived_at IS NULL
          AND title ILIKE '%' || $${escIdx} || '%'
        UNION
        SELECT id FROM items WHERE org_id = $${orgIdx} AND archived_at IS NULL
          AND short_ref ILIKE '%' || $${escIdx} || '%'
      )
    `;
    joinHits = 'JOIN hits ON hits.id = items.id';
  }

  // 10. Keyset pagination predicate: (last_activity_at, id) < (cursorTime, cursorId)
  if (cursor) {
    params.push(cursor.lastActivityAt, cursor.id);
    conditions.push(`(items.last_activity_at, items.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  params.push(limit + 1); // fetch 1 extra to check hasNextPage

  const sql = `
    ${withCte}
    SELECT 
      items.id,
      items.short_ref,
      items.team_id,
      t.name as team_name,
      t.slug as team_slug,
      t.prefix as team_prefix,
      items.type,
      items.title,
      items.status,
      items.priority,
      items.reporter_id,
      u_rep.name as reporter_name,
      u_rep.email as reporter_email,
      items.assignee_id,
      u_asg.name as assignee_name,
      u_asg.email as assignee_email,
      items.due_at,
      items.requires_approval,
      items.approval_status,
      items.tags,
      items.version,
      items.created_at,
      items.updated_at,
      items.last_activity_at,
      items.closed_at
    FROM items
    ${joinHits}
    JOIN teams t ON t.id = items.team_id
    JOIN users u_rep ON u_rep.id = items.reporter_id
    LEFT JOIN users u_asg ON u_asg.id = items.assignee_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY items.last_activity_at DESC, items.id DESC
    LIMIT $${params.length}
  `;

  try {
    const result = await pool.query(sql, params);
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

    let nextCursor: string | null = null;
    if (hasMore && rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      nextCursor = encodeCursor(new Date(lastRow.last_activity_at), lastRow.id);
    }

    res.status(200).json({
      items: rows,
      pagination: {
        limit,
        hasMore,
        nextCursor,
      },
    });
  } catch (err) {
    logger.error({ err, requestId: req.requestId }, 'Failed to query items');
    res.status(500).json({
      error: {
        code: 'QUERY_FAILED',
        message: 'Failed to retrieve work items.',
        requestId: req.requestId,
      },
    });
  }
}

/**
 * Get single item by ID or short_ref
 * Items of teams the caller does not belong to return 404 NOT FOUND (never 403)
 */
export async function getItemHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const idOrRef = req.params.id;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrRef);

  const memFilter = buildMembershipFilter(user.id, user.isOrgAdmin, 2);

  const sql = `
    SELECT 
      items.*,
      t.name as team_name,
      t.slug as team_slug,
      t.prefix as team_prefix,
      u_rep.name as reporter_name,
      u_rep.email as reporter_email,
      u_asg.name as assignee_name,
      u_asg.email as assignee_email,
      u_app.name as approved_by_name,
      u_app.email as approved_by_email
    FROM items
    JOIN teams t ON t.id = items.team_id
    JOIN users u_rep ON u_rep.id = items.reporter_id
    LEFT JOIN users u_asg ON u_asg.id = items.assignee_id
    LEFT JOIN users u_app ON u_app.id = items.approved_by
    WHERE ${isUuid ? 'items.id = $1' : 'items.short_ref = $1'}
      AND items.archived_at IS NULL
      AND ${memFilter.sql}
  `;

  try {
    const result = await pool.query(sql, [idOrRef, ...memFilter.params]);

    if (result.rows.length === 0) {
      res.status(404).json({
        error: {
          code: 'ITEM_NOT_FOUND',
          message: 'Work item not found or you do not have permission to view this team.',
          requestId: req.requestId,
        },
      });
      return;
    }

    const item = result.rows[0];

    // Fetch initial activity timeline (keyset cursor for subsequent pages)
    const activityRes = await pool.query(
      `SELECT 
         al.id,
         al.item_id,
         al.actor_id,
         u.name as actor_name,
         u.email as actor_email,
         al.action,
         al.old_values,
         al.new_values,
         al.note,
         al.is_org_admin_override,
         al.created_at
       FROM activity_log al
       JOIN users u ON u.id = al.actor_id
       WHERE al.item_id = $1
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT 20`,
      [item.id]
    );

    function computeNextAttention(it: typeof item, u: { id: string }): string {
      if (it.status === 'new') {
        return 'Item requires initial triage and classification before work can commence.';
      }
      if (it.status === 'triaged') {
        if (!it.assignee_id) {
          return 'Item is triaged and unassigned. Claim this item or assign an operator to start work.';
        }
        return `Assigned to ${it.assignee_name || 'operator'}. Awaiting transition to In Progress.`;
      }
      if (it.status === 'in_progress') {
        if (it.assignee_id === u.id) {
          return 'You are the active operator. Complete investigation and resolve, or request approval.';
        }
        return `Active investigation by ${it.assignee_name || 'operator'}. Awaiting completion or escalation.`;
      }
      if (it.status === 'blocked') {
        return 'Work is blocked on an external dependency. Monitor for clearance or add resolution notes.';
      }
      if (it.status === 'awaiting_approval') {
        return 'Work completed. Awaiting review and approval from a Team Lead or Org Admin.';
      }
      if (it.status === 'resolved') {
        return 'Resolved. Pending final operational review and closure.';
      }
      if (it.status === 'closed') {
        return 'Closed. If regression occurs, reopen the item to restart triage.';
      }
      return 'Review item status and activity timeline.';
    }

    // Fetch comments
    const commentsRes = await pool.query(
      `SELECT 
         c.id,
         c.item_id,
         c.author_id,
         u.name as user_name,
         u.email as user_email,
         c.content,
         c.created_at
       FROM comments c
       JOIN users u ON u.id = c.author_id
       WHERE c.item_id = $1
       ORDER BY c.created_at ASC, c.id ASC`,
      [item.id]
    );

    const computedNext = computeNextAttention(item, user);

    // Emit ETag header with version
    res.setHeader('ETag', `"${item.version}"`);
    res.status(200).json({
      item,
      activity: activityRes.rows,
      comments: commentsRes.rows,
      computed_next: computedNext,
    });
  } catch (err) {
    logger.error({ err, idOrRef, requestId: req.requestId }, 'Failed retrieving item detail');
    res.status(500).json({
      error: {
        code: 'QUERY_FAILED',
        message: 'Failed to retrieve item.',
        requestId: req.requestId,
      },
    });
  }
}

/**
 * Create item with team counter row lock inside transaction
 */
export async function createItemHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const parseResult = CreateItemSchema.safeParse(req.body);

  if (!parseResult.success) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid item payload.',
        details: parseResult.error.flatten(),
        requestId: req.requestId,
      },
    });
    return;
  }

  const data = parseResult.data;

  // Authorization check
  const authCheck = can(user, 'create_item', { teamId: data.teamId });
  if (!authCheck.allowed) {
    res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: authCheck.reason || 'You do not have permission to create items in this team.',
        requestId: req.requestId,
      },
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 5000');
    await client.query('SET LOCAL lock_timeout = 2000');

    // Atomic counter row update: UPDATE teams SET item_counter = item_counter + 1 WHERE id=$1 RETURNING prefix, item_counter
    const counterRes = await client.query<{ prefix: string; item_counter: string }>(
      'UPDATE teams SET item_counter = item_counter + 1 WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING prefix, item_counter',
      [data.teamId, user.orgId]
    );

    if (counterRes.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({
        error: {
          code: 'TEAM_NOT_FOUND',
          message: 'The specified team does not exist.',
          requestId: req.requestId,
        },
      });
      return;
    }

    const { prefix, item_counter } = counterRes.rows[0];
    const shortRef = `${prefix}-${item_counter}`;

    const approvalStatus = data.requiresApproval ? 'pending' : 'not_required';

    const insertSql = `
      INSERT INTO items (
        short_ref, team_id, type, title, description, status, priority,
        reporter_id, assignee_id, due_at, requires_approval, approval_status,
        tags, version, created_at, updated_at, last_activity_at
      )
      VALUES ($1, $2, $3, $4, $5, 'new', $6, $7, $8, $9, $10, $11, $12, 1, NOW(), NOW(), NOW())
      RETURNING *
    `;

    const itemRes = await client.query(insertSql, [
      shortRef,
      data.teamId,
      data.type,
      data.title,
      data.description,
      data.priority,
      user.id,
      data.assigneeId || null,
      data.dueAt || null,
      data.requiresApproval,
      approvalStatus,
      data.tags,
    ]);

    const createdItem = itemRes.rows[0];

    // Append to activity_log in the SAME transaction
    await client.query(
      `INSERT INTO activity_log (item_id, actor_id, action, new_values, note, is_org_admin_override)
       VALUES ($1, $2, 'created', $3, 'Work item created', $4)`,
      [
        createdItem.id,
        user.id,
        JSON.stringify({
          short_ref: shortRef,
          title: data.title,
          type: data.type,
          priority: data.priority,
          requires_approval: data.requiresApproval,
        }),
        authCheck.isOrgAdminOverride || false,
      ]
    );

    // Write transactional outbox event
    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ('item.created', $1)`,
      [
        JSON.stringify({
          itemId: createdItem.id,
          teamId: data.teamId,
          shortRef,
          actorId: user.id,
          version: 1,
        }),
      ]
    );

    const responseBody = { item: createdItem };

    // Record idempotency completion if key is present
    if (req.idempotency) {
      await completeIdempotency(client, user.id, req.idempotency.key, 201, responseBody, {
        ETag: `"${createdItem.version}"`,
      });
    }

    await client.query('COMMIT');

    res.setHeader('ETag', `"${createdItem.version}"`);
    res.status(201).json(responseBody);
  } catch (err: any) {
    await client.query('ROLLBACK');
    logger.error({ err, requestId: req.requestId }, 'Failed creating item');
    res.status(500).json({
      error: {
        code: 'CREATE_FAILED',
        message: 'Failed to create work item.',
        requestId: req.requestId,
      },
    });
  } finally {
    client.release();
  }
}

/**
 * Atomic Claim Endpoint:
 * Exactly one winner executes UPDATE ... WHERE id=$1 AND assignee_id IS NULL AND <open status> RETURNING *
 * Loser gets 409 ALREADY_CLAIMED with current owner
 */
export async function claimItemHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const itemId = req.params.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 5000');
    await client.query('SET LOCAL lock_timeout = 2000');

    // 1. Fetch item to verify team scoping and check if item exists
    const memFilter = buildMembershipFilter(user.id, user.isOrgAdmin, 2);
    const existingRes = await client.query(
      `SELECT items.*, u.name as current_assignee_name, u.email as current_assignee_email
       FROM items
       LEFT JOIN users u ON u.id = items.assignee_id
       WHERE items.id = $1 AND items.archived_at IS NULL AND ${memFilter.sql}`,
      [itemId, ...memFilter.params]
    );

    if (existingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({
        error: {
          code: 'ITEM_NOT_FOUND',
          message: 'Work item not found or you do not have permission to access it.',
          requestId: req.requestId,
        },
      });
      return;
    }

    const item = existingRes.rows[0];

    // Authorization check
    const authCheck = can(user, 'claim_item', { teamId: item.team_id, item });
    if (!authCheck.allowed) {
      await client.query('ROLLBACK');
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: authCheck.reason || 'You do not have permission to claim this item.',
          requestId: req.requestId,
        },
      });
      return;
    }

    // 2. Perform conditional atomic update
    // In accordance with state-machine workflow rules (T2, transitions.ts):
    // Claiming a 'new' item moves it to 'triaged' (with assignee set).
    // Subsequent progression 'triaged -> in_progress' is a separate intentional transition.
    // Claiming unassigned items in other active states ('blocked', 'awaiting_approval', 'triaged') retains their status.
    const targetStatus = item.status === 'new' ? 'triaged' : item.status;

    const claimRes = await client.query(
      `UPDATE items
       SET assignee_id = $1,
           status = $2,
           version = version + 1,
           updated_at = NOW(),
           last_activity_at = NOW()
       WHERE id = $3
         AND assignee_id IS NULL
         AND status NOT IN ('resolved', 'closed')
         AND archived_at IS NULL
       RETURNING *`,
      [user.id, targetStatus, itemId]
    );

    if (claimRes.rows.length === 0) {
      // Failed atomic condition: someone else claimed or status changed
      const winnerRes = await client.query(
        `SELECT u.id, u.name, u.email
         FROM items
         JOIN users u ON u.id = items.assignee_id
         WHERE items.id = $1`,
        [itemId]
      );
      await client.query('ROLLBACK');

      const owner = winnerRes.rows[0] || null;

      res.status(409).json({
        error: {
          code: 'ALREADY_CLAIMED',
          message: owner
            ? `Item was already claimed by ${owner.name} (${owner.email}).`
            : 'Item is already claimed or no longer available for claiming.',
          currentAssignee: owner,
          current_assignee: owner,
          requestId: req.requestId,
        },
      });
      return;
    }

    const claimedItem = claimRes.rows[0];

    // Append activity log
    await client.query(
      `INSERT INTO activity_log (item_id, actor_id, action, old_values, new_values, note, is_org_admin_override)
       VALUES ($1, $2, 'claimed', $3, $4, 'Item claimed by user', $5)`,
      [
        itemId,
        user.id,
        JSON.stringify({ assignee_id: null, status: item.status }),
        JSON.stringify({ assignee_id: user.id, status: targetStatus }),
        authCheck.isOrgAdminOverride || false,
      ]
    );

    // Write outbox event
    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ('item.claimed', $1)`,
      [
        JSON.stringify({
          itemId,
          teamId: item.team_id,
          actorId: user.id,
          assigneeId: user.id,
          version: claimedItem.version,
        }),
      ]
    );

    const responseBody = {
      success: true,
      item: claimedItem,
    };

    // Idempotency support
    if (req.idempotency) {
      await completeIdempotency(client, user.id, req.idempotency.key, 200, responseBody, {
        ETag: `"${claimedItem.version}"`,
      });
    }

    await client.query('COMMIT');

    res.setHeader('ETag', `"${claimedItem.version}"`);
    res.status(200).json(responseBody);
  } catch (err: any) {
    await client.query('ROLLBACK');
    logger.error({ err, itemId, requestId: req.requestId }, 'Failed processing claim');
    res.status(500).json({
      error: {
        code: 'CLAIM_FAILED',
        message: 'Internal error processing claim.',
        requestId: req.requestId,
      },
    });
  } finally {
    client.release();
  }
}

/**
 * Optimistic Concurrency Update with If-Match / ETag validation
 */
export async function updateItemHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const itemId = req.params.id;

  // 1. Validate If-Match header
  const ifMatch = req.headers['if-match'];
  if (!ifMatch) {
    res.status(428).json({
      error: {
        code: 'PRECONDITION_REQUIRED',
        message: 'Updating an item requires an If-Match header containing the current ETag version.',
        requestId: req.requestId,
      },
    });
    return;
  }

  const expectedVersion = parseInt(ifMatch.replace(/["\s]/g, ''), 10);
  if (isNaN(expectedVersion)) {
    res.status(400).json({
      error: {
        code: 'INVALID_IF_MATCH',
        message: 'If-Match header must be a valid integer version (e.g. "1").',
        requestId: req.requestId,
      },
    });
    return;
  }

  const parseResult = UpdateItemSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid update attributes.',
        details: parseResult.error.flatten(),
        requestId: req.requestId,
      },
    });
    return;
  }

  const updates = parseResult.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 5000');
    await client.query('SET LOCAL lock_timeout = 2000');

    // 2. Fetch current item with row lock
    const memFilter = buildMembershipFilter(user.id, user.isOrgAdmin, 2);
    const itemRes = await client.query(
      `SELECT *
       FROM items
       WHERE id = $1 AND archived_at IS NULL AND ${memFilter.sql}
       FOR UPDATE`,
      [itemId, ...memFilter.params]
    );

    if (itemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({
        error: {
          code: 'ITEM_NOT_FOUND',
          message: 'Work item not found or you do not have permission to view it.',
          requestId: req.requestId,
        },
      });
      return;
    }

    const currentItem = itemRes.rows[0];

    // 3. Stale version check: If-Match version mismatch -> 412 STALE_VERSION
    if (currentItem.version !== expectedVersion) {
      await client.query('ROLLBACK');
      res.status(412).json({
        error: {
          code: 'STALE_VERSION',
          message: `The item has been modified by another user (current version: ${currentItem.version}, provided: ${expectedVersion}).`,
          currentVersion: currentItem.version,
          currentItem,
          requestId: req.requestId,
        },
      });
      return;
    }

    // 4. Closed item check
    if (currentItem.status === 'closed') {
      await client.query('ROLLBACK');
      res.status(409).json({
        error: {
          code: 'ITEM_CLOSED',
          message: 'Closed items accept only comments and reopen.',
          requestId: req.requestId,
        },
      });
      return;
    }

    // 5. Authorization check
    if (updates.priority && updates.priority !== currentItem.priority) {
      const prioAuth = can(user, 'change_priority', { teamId: currentItem.team_id, item: currentItem });
      if (!prioAuth.allowed) {
        await client.query('ROLLBACK');
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: prioAuth.reason || 'You do not have permission to change priority.',
            requestId: req.requestId,
          },
        });
        return;
      }
    }

    if (updates.assigneeId !== undefined && updates.assigneeId !== currentItem.assignee_id) {
      const asgAuth = can(user, 'assign_item', { teamId: currentItem.team_id, item: currentItem });
      if (!asgAuth.allowed) {
        await client.query('ROLLBACK');
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: asgAuth.reason || 'Only team leads and admins can reassign items.',
            requestId: req.requestId,
          },
        });
        return;
      }
    }

    const editAuth = can(user, 'edit_item', { teamId: currentItem.team_id, item: currentItem });
    if (!editAuth.allowed) {
      await client.query('ROLLBACK');
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: editAuth.reason || 'You do not have permission to edit this item.',
          requestId: req.requestId,
        },
      });
      return;
    }

    // 6. Apply updates
    const title = updates.title ?? currentItem.title;
    const description = updates.description ?? currentItem.description;
    const priority = updates.priority ?? currentItem.priority;
    const assigneeId = updates.assigneeId !== undefined ? updates.assigneeId : currentItem.assignee_id;
    const dueAt = updates.dueAt !== undefined ? updates.dueAt : currentItem.due_at;
    const tags = updates.tags ?? currentItem.tags;

    const updateRes = await client.query(
      `UPDATE items
       SET title = $1,
           description = $2,
           priority = $3,
           assignee_id = $4,
           due_at = $5,
           tags = $6,
           version = version + 1,
           updated_at = NOW(),
           last_activity_at = NOW()
       WHERE id = $7 AND version = $8
       RETURNING *`,
      [title, description, priority, assigneeId, dueAt, tags, itemId, expectedVersion]
    );

    const updatedItem = updateRes.rows[0];
    if (!updatedItem) {
      await client.query('ROLLBACK');
      res.status(412).json({
        error: {
          code: 'STALE_VERSION',
          message: 'The item was modified by another operator during processing.',
          requestId: req.requestId,
        },
      });
      return;
    }

    // Activity log entry
    await client.query(
      `INSERT INTO activity_log (item_id, actor_id, action, old_values, new_values, note, is_org_admin_override)
       VALUES ($1, $2, 'updated', $3, $4, 'Item details updated', $5)`,
      [
        itemId,
        user.id,
        JSON.stringify({
          title: currentItem.title,
          priority: currentItem.priority,
          assignee_id: currentItem.assignee_id,
        }),
        JSON.stringify({
          title: updatedItem.title,
          priority: updatedItem.priority,
          assignee_id: updatedItem.assignee_id,
        }),
        editAuth.isOrgAdminOverride || false,
      ]
    );

    // Outbox event
    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ('item.updated', $1)`,
      [
        JSON.stringify({
          itemId,
          teamId: currentItem.team_id,
          actorId: user.id,
          version: updatedItem.version,
        }),
      ]
    );

    const responseBody = { item: updatedItem };

    if (req.idempotency) {
      await completeIdempotency(client, user.id, req.idempotency.key, 200, responseBody, {
        ETag: `"${updatedItem.version}"`,
      });
    }

    await client.query('COMMIT');

    res.setHeader('ETag', `"${updatedItem.version}"`);
    res.status(200).json(responseBody);
  } catch (err: any) {
    await client.query('ROLLBACK');
    logger.error({ err, itemId, requestId: req.requestId }, 'Failed updating item');
    res.status(500).json({
      error: {
        code: 'UPDATE_FAILED',
        message: 'Internal error updating item.',
        requestId: req.requestId,
      },
    });
  } finally {
    client.release();
  }
}

/**
 * State Transition Handler enforcing centralized transition matrix and rules
 */
export async function transitionItemHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const itemId = req.params.id;

  const parseResult = TransitionItemSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid transition payload.',
        details: parseResult.error.flatten(),
        requestId: req.requestId,
      },
    });
    return;
  }

  const rawData = parseResult.data;
  let targetStatus = rawData.status;
  const action = rawData.action;
  const resolutionNote = rawData.resolutionNote ?? rawData.note;
  const rejectionNote = rawData.rejectionNote ?? rawData.note;
  const assigneeId = rawData.assigneeId;

  if (!targetStatus) {
    if (action === 'approve') targetStatus = 'resolved';
    else if (action === 'reject') targetStatus = 'in_progress';
    else if (action === 'reopen') targetStatus = 'triaged';
    else {
      res.status(422).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: "Target 'status' is required for this transition.",
          requestId: req.requestId,
        },
      });
      return;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 5000');
    await client.query('SET LOCAL lock_timeout = 2000');

    const memFilter = buildMembershipFilter(user.id, user.isOrgAdmin, 2);
    const itemRes = await client.query(
      `SELECT * FROM items WHERE id = $1 AND archived_at IS NULL AND ${memFilter.sql} FOR UPDATE`,
      [itemId, ...memFilter.params]
    );

    if (itemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({
        error: {
          code: 'ITEM_NOT_FOUND',
          message: 'Work item not found or you do not have permission to view it.',
          requestId: req.requestId,
        },
      });
      return;
    }

    const item = itemRes.rows[0];

    // Optimistic concurrency check if If-Match header is provided
    const ifMatch = req.headers['if-match'];
    let expectedVersion: number | null = null;
    if (ifMatch) {
      expectedVersion = parseInt(ifMatch.replace(/["\s]/g, ''), 10);
      if (isNaN(expectedVersion)) {
        await client.query('ROLLBACK');
        res.status(400).json({
          error: {
            code: 'INVALID_IF_MATCH',
            message: 'If-Match header must be a valid integer version (e.g. "1").',
            requestId: req.requestId,
          },
        });
        return;
      }
      if (item.version !== expectedVersion) {
        await client.query('ROLLBACK');
        res.status(412).json({
          error: {
            code: 'STALE_VERSION',
            message: `The item has been modified by another user (current version: ${item.version}, provided: ${expectedVersion}).`,
            currentVersion: item.version,
            currentItem: item,
            requestId: req.requestId,
          },
        });
        return;
      }
    }

    // If reopening, action flag is true
    const isReopenAction = action === 'reopen' || (item.status === 'closed' || item.status === 'resolved') && targetStatus === 'triaged';
    const isApprovalAction = action === 'approve' || targetStatus === 'resolved' && item.status === 'awaiting_approval';
    const isRejectionAction = action === 'reject' || targetStatus === 'in_progress' && item.status === 'awaiting_approval';

    // 1. Authorization & Separation of Duties check (enforce role & separation of duties before transition validation)
    if (isApprovalAction) {
      const approveAuth = can(user, 'approve_item', { teamId: item.team_id, item });
      if (!approveAuth.allowed) {
        await client.query('ROLLBACK');
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: approveAuth.reason || 'You do not have permission to approve this item.',
            requestId: req.requestId,
          },
        });
        return;
      }
    } else if (isRejectionAction) {
      const rejectAuth = can(user, 'reject_item', { teamId: item.team_id, item });
      if (!rejectAuth.allowed) {
        await client.query('ROLLBACK');
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: rejectAuth.reason || 'You do not have permission to reject this item.',
            requestId: req.requestId,
          },
        });
        return;
      }
    } else if (targetStatus === 'resolved') {
      const resolveAuth = can(user, 'resolve_item', { teamId: item.team_id, item });
      if (!resolveAuth.allowed) {
        await client.query('ROLLBACK');
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: resolveAuth.reason || 'You do not have permission to resolve this item.',
            requestId: req.requestId,
          },
        });
        return;
      }
    } else if (targetStatus === 'closed') {
      const closeAuth = can(user, 'close_item', { teamId: item.team_id, item });
      if (!closeAuth.allowed) {
        await client.query('ROLLBACK');
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: closeAuth.reason || 'You do not have permission to close this item.',
            requestId: req.requestId,
          },
        });
        return;
      }
    } else if (isReopenAction) {
      const reopenAuth = can(user, 'reopen_item', { teamId: item.team_id, item });
      if (!reopenAuth.allowed) {
        await client.query('ROLLBACK');
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: reopenAuth.reason || 'You do not have permission to reopen this item.',
            requestId: req.requestId,
          },
        });
        return;
      }
    }

    // 2. Validate state machine transition rules
    const effectiveAssigneeId = assigneeId !== undefined ? assigneeId : item.assignee_id;
    const transitionValidation = validateTransition({
      currentStatus: item.status as ItemStatus,
      targetStatus: targetStatus as ItemStatus,
      requiresApproval: item.requires_approval,
      assigneeId: effectiveAssigneeId,
      resolutionNote: resolutionNote ?? item.resolution_note,
      rejectionNote,
      isApprovalAction,
      isRejectionAction,
      isReopenAction,
    });

    if (!transitionValidation.valid) {
      await client.query('ROLLBACK');
      res.status(409).json({
        error: {
          code: 'INVALID_TRANSITION',
          message: transitionValidation.error || 'Requested state transition is invalid.',
          requestId: req.requestId,
        },
      });
      return;
    }

    // 3. Prepare update values
    const newApprovalStatus = transitionValidation.nextApprovalStatus ?? item.approval_status;
    const approvedBy = isApprovalAction ? user.id : item.approved_by;
    const finalResolutionNote = resolutionNote !== undefined ? resolutionNote : item.resolution_note;
    const closedAt = (targetStatus === 'closed') ? new Date().toISOString() : (isReopenAction ? null : item.closed_at);

    const updateSql = expectedVersion !== null
      ? `UPDATE items
         SET status = $1,
             approval_status = $2,
             approved_by = $3,
             resolution_note = $4,
             assignee_id = $5,
             closed_at = $6,
             version = version + 1,
             updated_at = NOW(),
             last_activity_at = NOW()
         WHERE id = $7 AND version = $8
         RETURNING *`
      : `UPDATE items
         SET status = $1,
             approval_status = $2,
             approved_by = $3,
             resolution_note = $4,
             assignee_id = $5,
             closed_at = $6,
             version = version + 1,
             updated_at = NOW(),
             last_activity_at = NOW()
         WHERE id = $7
         RETURNING *`;

    const updateParams = expectedVersion !== null
      ? [targetStatus, newApprovalStatus, approvedBy, finalResolutionNote, effectiveAssigneeId, closedAt, itemId, expectedVersion]
      : [targetStatus, newApprovalStatus, approvedBy, finalResolutionNote, effectiveAssigneeId, closedAt, itemId];

    const updateRes = await client.query(updateSql, updateParams);
    const updatedItem = updateRes.rows[0];

    if (!updatedItem) {
      await client.query('ROLLBACK');
      res.status(412).json({
        error: {
          code: 'STALE_VERSION',
          message: 'The item was modified by another operator during transition.',
          requestId: req.requestId,
        },
      });
      return;
    }

    // 4. Activity log
    const activityAction = isReopenAction
      ? 'reopened'
      : isApprovalAction
      ? 'approved'
      : isRejectionAction
      ? 'rejected'
      : 'status_changed';

    await client.query(
      `INSERT INTO activity_log (item_id, actor_id, action, old_values, new_values, note, is_org_admin_override)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        itemId,
        user.id,
        activityAction,
        JSON.stringify({ status: item.status, approval_status: item.approval_status }),
        JSON.stringify({ status: targetStatus, approval_status: newApprovalStatus }),
        rejectionNote || resolutionNote || `Transitioned from ${item.status} to ${targetStatus}`,
        user.isOrgAdmin,
      ]
    );

    // 5. Outbox Event
    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ('item.transitioned', $1)`,
      [
        JSON.stringify({
          itemId,
          teamId: item.team_id,
          actorId: user.id,
          oldStatus: item.status,
          newStatus: targetStatus,
          version: updatedItem.version,
        }),
      ]
    );

    const responseBody = { item: updatedItem };

    if (req.idempotency) {
      await completeIdempotency(client, user.id, req.idempotency.key, 200, responseBody, {
        ETag: `"${updatedItem.version}"`,
      });
    }

    await client.query('COMMIT');

    res.setHeader('ETag', `"${updatedItem.version}"`);
    res.status(200).json(responseBody);
  } catch (err: any) {
    await client.query('ROLLBACK');
    logger.error({ err, itemId, requestId: req.requestId }, 'Failed transitioning item');
    res.status(500).json({
      error: {
        code: 'TRANSITION_FAILED',
        message: 'Internal error processing state transition.',
        requestId: req.requestId,
      },
    });
  } finally {
    client.release();
  }
}

/**
 * Lead Approval Endpoint (BUG-01)
 * POST /api/v1/items/:id/approve
 */
export async function approveItemHandler(req: Request, res: Response): Promise<void> {
  req.body = { ...req.body, action: 'approve', status: 'resolved', resolutionNote: req.body?.note || req.body?.resolutionNote };
  return transitionItemHandler(req, res);
}

/**
 * Lead Rejection Endpoint (BUG-01)
 * POST /api/v1/items/:id/reject
 */
export async function rejectItemHandler(req: Request, res: Response): Promise<void> {
  req.body = { ...req.body, action: 'reject', status: 'in_progress', rejectionNote: req.body?.note || req.body?.rejectionNote };
  return transitionItemHandler(req, res);
}

/**
 * Reopen Endpoint (BUG-01)
 * POST /api/v1/items/:id/reopen
 */
export async function reopenItemHandler(req: Request, res: Response): Promise<void> {
  req.body = { ...req.body, action: 'reopen', status: 'triaged', resolutionNote: req.body?.note || req.body?.resolutionNote };
  return transitionItemHandler(req, res);
}

/**
 * Keyset-paginated Timeline / Activity Log for an item
 */
export async function getItemActivityHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const itemId = req.params.id;
  const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '50', 10), 1), 100);

  const memFilter = buildMembershipFilter(user.id, user.isOrgAdmin, 2);

  // Keyset cursor for activity_log: (created_at, id)
  const cursorStr = req.query.cursor as string | undefined;
  let cursorCondition = '';
  const params: any[] = [itemId, ...memFilter.params];

  if (cursorStr) {
    try {
      const decoded = JSON.parse(Buffer.from(cursorStr, 'base64url').toString('utf8'));
      if (decoded.t && decoded.id) {
        params.push(decoded.t, decoded.id);
        cursorCondition = `AND (al.created_at, al.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
      }
    } catch {
      // ignore invalid cursor
    }
  }

  params.push(limit + 1);

  const sql = `
    SELECT 
      al.id,
      al.item_id,
      al.actor_id,
      u.name as actor_name,
      u.email as actor_email,
      al.action,
      al.old_values,
      al.new_values,
      al.note,
      al.is_org_admin_override,
      al.created_at
    FROM activity_log al
    JOIN items ON items.id = al.item_id
    JOIN users u ON u.id = al.actor_id
    WHERE al.item_id = $1
      AND items.archived_at IS NULL
      AND ${memFilter.sql}
      ${cursorCondition}
    ORDER BY al.created_at DESC, al.id DESC
    LIMIT $${params.length}
  `;

  try {
    const result = await pool.query(sql, params);
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

    let nextCursor: string | null = null;
    if (hasMore && rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({ t: new Date(lastRow.created_at).toISOString(), id: lastRow.id })
      ).toString('base64url');
    }

    res.status(200).json({
      activity: rows,
      pagination: {
        limit,
        hasMore,
        nextCursor,
      },
    });
  } catch (err) {
    logger.error({ err, itemId, requestId: req.requestId }, 'Failed querying item activity');
    res.status(500).json({
      error: {
        code: 'QUERY_FAILED',
        message: 'Failed to retrieve activity timeline.',
        requestId: req.requestId,
      },
    });
  }
}

/**
 * Comments on an item with @mention parsing
 */
export async function addCommentHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const itemId = req.params.id;

  const parseResult = AddCommentSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid comment content.',
        requestId: req.requestId,
      },
    });
    return;
  }

  const { content } = parseResult.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 5000');
    await client.query('SET LOCAL lock_timeout = 2000');

    const memFilter = buildMembershipFilter(user.id, user.isOrgAdmin, 2);
    const itemRes = await client.query(
      `SELECT items.* FROM items WHERE items.id = $1 AND items.archived_at IS NULL AND ${memFilter.sql} FOR UPDATE`,
      [itemId, ...memFilter.params]
    );

    if (itemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({
        error: {
          code: 'ITEM_NOT_FOUND',
          message: 'Work item not found or you do not have permission to access it.',
          requestId: req.requestId,
        },
      });
      return;
    }

    const item = itemRes.rows[0];

    const authCheck = can(user, 'comment_item', { teamId: item.team_id, item });
    if (!authCheck.allowed) {
      await client.query('ROLLBACK');
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: authCheck.reason || 'You do not have permission to comment on this item.',
          requestId: req.requestId,
        },
      });
      return;
    }

    // Insert comment
    const commentRes = await client.query(
      `INSERT INTO comments (item_id, author_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [itemId, user.id, content]
    );

    const comment = commentRes.rows[0];

    // Update item last_activity_at
    await client.query(
      'UPDATE items SET last_activity_at = NOW(), updated_at = NOW() WHERE id = $1',
      [itemId]
    );

    // Record activity log
    await client.query(
      `INSERT INTO activity_log (item_id, actor_id, action, note, is_org_admin_override)
       VALUES ($1, $2, 'commented', $3, $4)`,
      [itemId, user.id, `Added comment: ${content.slice(0, 100)}...`, authCheck.isOrgAdminOverride || false]
    );

    // Parse @mentions e.g. @priya.lead or @username
    const mentions = content.match(/@([a-zA-Z0-9._-]+)/g) || [];
    const mentionedEmails = mentions.map(m => m.slice(1).toLowerCase());

    // Outbox event for comment & mentions
    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ('item.commented', $1)`,
      [
        JSON.stringify({
          commentId: comment.id,
          itemId,
          teamId: item.team_id,
          authorId: user.id,
          content,
          mentionedEmails,
        }),
      ]
    );

    const responseBody = {
      comment: {
        ...comment,
        author_name: user.name,
        author_email: user.email,
      },
    };

    if (req.idempotency) {
      await completeIdempotency(client, user.id, req.idempotency.key, 201, responseBody);
    }

    await client.query('COMMIT');

    res.status(201).json(responseBody);
  } catch (err: any) {
    await client.query('ROLLBACK');
    logger.error({ err, itemId, requestId: req.requestId }, 'Failed adding comment');
    res.status(500).json({
      error: {
        code: 'COMMENT_FAILED',
        message: 'Internal error adding comment.',
        requestId: req.requestId,
      },
    });
  } finally {
    client.release();
  }
}

/**
 * List comments on an item
 */
export async function getItemCommentsHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const itemId = req.params.id;

  const memFilter = buildMembershipFilter(user.id, user.isOrgAdmin, 2);

  const sql = `
    SELECT 
      c.id,
      c.item_id,
      c.author_id,
      u.name as author_name,
      u.email as author_email,
      c.content,
      c.created_at
    FROM comments c
    JOIN items ON items.id = c.item_id
    JOIN users u ON u.id = c.author_id
    WHERE c.item_id = $1
      AND items.archived_at IS NULL
      AND ${memFilter.sql}
    ORDER BY c.created_at ASC, c.id ASC
  `;

  try {
    const result = await pool.query(sql, [itemId, ...memFilter.params]);
    res.status(200).json({ comments: result.rows });
  } catch (err) {
    logger.error({ err, itemId, requestId: req.requestId }, 'Failed querying comments');
    res.status(500).json({
      error: {
        code: 'QUERY_FAILED',
        message: 'Failed to retrieve comments.',
        requestId: req.requestId,
      },
    });
  }
}

/**
 * Dashboard "My Attention" aggregates
 */
export async function getAttentionDashboardHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;

  const memFilter = buildMembershipFilter(user.id, user.isOrgAdmin, 1);

  try {
    // 1. Awaiting my approval (items in user's teams requiring approval where user is lead/admin)
    const awaitingApprovalSql = `
      SELECT items.id, items.short_ref, items.title, items.priority, items.type, items.created_at, t.prefix as team_prefix
      FROM items
      JOIN teams t ON t.id = items.team_id
      JOIN team_memberships tm ON tm.team_id = items.team_id AND tm.user_id = $1
      WHERE items.status = 'awaiting_approval'
        AND items.requires_approval = TRUE
        AND items.archived_at IS NULL
        AND (tm.role IN ('lead', 'admin') OR $2 = TRUE)
        AND items.reporter_id != $1
        AND (items.assignee_id IS NULL OR items.assignee_id != $1)
      ORDER BY items.created_at ASC
      LIMIT 10
    `;

    // 2. Mine overdue or due soon (<= 48h)
    const mineDueSql = `
      SELECT items.id, items.short_ref, items.title, items.priority, items.status, items.due_at, t.prefix as team_prefix
      FROM items
      JOIN teams t ON t.id = items.team_id
      WHERE items.assignee_id = $1
        AND items.status NOT IN ('resolved', 'closed')
        AND items.archived_at IS NULL
        AND items.due_at IS NOT NULL
        AND items.due_at <= (NOW() + INTERVAL '48 hours')
      ORDER BY items.due_at ASC
      LIMIT 10
    `;

    // 3. Urgent unassigned items in caller's teams
    const urgentUnassignedSql = `
      SELECT items.id, items.short_ref, items.title, items.type, items.created_at, t.prefix as team_prefix
      FROM items
      JOIN teams t ON t.id = items.team_id
      WHERE items.assignee_id IS NULL
        AND items.priority = 'urgent'
        AND items.status NOT IN ('resolved', 'closed')
        AND items.archived_at IS NULL
        AND ${memFilter.sql}
      ORDER BY items.created_at ASC
      LIMIT 10
    `;

    // 4. Gone quiet: open items in caller's teams with no activity for N days (default 3)
    const goneQuietSql = `
      SELECT items.id, items.short_ref, items.title, items.status, items.priority, items.last_activity_at, t.prefix as team_prefix
      FROM items
      JOIN teams t ON t.id = items.team_id
      WHERE items.status NOT IN ('resolved', 'closed')
        AND items.archived_at IS NULL
        AND items.last_activity_at < (NOW() - INTERVAL '3 days')
        AND ${memFilter.sql}
      ORDER BY items.last_activity_at ASC
      LIMIT 10
    `;

    // 5. Unread notifications for user
    const notificationsSql = `
      SELECT id, title, message, type, item_id, created_at
      FROM notifications
      WHERE user_id = $1 AND is_read = FALSE
      ORDER BY created_at DESC
      LIMIT 10
    `;

    const [awaitingApproval, mineDue, urgentUnassigned, goneQuiet, unreadNotifications] = await Promise.all([
      pool.query(awaitingApprovalSql, [user.id, user.isOrgAdmin]),
      pool.query(mineDueSql, [user.id]),
      pool.query(urgentUnassignedSql, memFilter.params),
      pool.query(goneQuietSql, memFilter.params),
      pool.query(notificationsSql, [user.id]),
    ]);

    res.status(200).json({
      awaiting_approval: awaitingApproval.rows,
      mine_due_soon: mineDue.rows,
      urgent_unassigned: urgentUnassigned.rows,
      mentions: unreadNotifications.rows,
      gone_quiet: goneQuiet.rows,
    });
  } catch (err) {
    logger.error({ err, requestId: req.requestId }, 'Failed fetching attention dashboard data');
    res.status(500).json({
      error: {
        code: 'DASHBOARD_FAILED',
        message: 'Failed to retrieve attention dashboard.',
        requestId: req.requestId,
      },
    });
  }
}
