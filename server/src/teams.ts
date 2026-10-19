import { Request, Response } from 'express';
import { pool, logger } from './db.js';

/**
 * List teams visible to user (or all teams if org admin)
 */
export async function listTeamsHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;

  const sql = user.isOrgAdmin
    ? `SELECT id, name, slug, prefix, item_counter, created_at FROM teams ORDER BY name ASC`
    : `SELECT t.id, t.name, t.slug, t.prefix, t.item_counter, t.created_at, tm.role
       FROM teams t
       JOIN team_memberships tm ON tm.team_id = t.id AND tm.user_id = $1
       ORDER BY t.name ASC`;

  const params = user.isOrgAdmin ? [] : [user.id];

  try {
    const result = await pool.query(sql, params);
    res.status(200).json({ teams: result.rows });
  } catch (err) {
    logger.error({ err, requestId: req.requestId }, 'Failed querying teams');
    res.status(500).json({
      error: {
        code: 'QUERY_FAILED',
        message: 'Failed to retrieve teams.',
        requestId: req.requestId,
      },
    });
  }
}

/**
 * List team members for a team
 */
export async function listTeamMembersHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const teamId = req.params.id;

  // Authorization check
  const hasAccess = user.isOrgAdmin || user.memberships.has(teamId);
  if (!hasAccess) {
    res.status(404).json({
      error: {
        code: 'TEAM_NOT_FOUND',
        message: 'Team not found or you do not have permission to view members.',
        requestId: req.requestId,
      },
    });
    return;
  }

  const sql = `
    SELECT 
      tm.id,
      tm.team_id,
      tm.user_id,
      u.name,
      u.email,
      tm.role,
      tm.created_at
    FROM team_memberships tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = $1
    ORDER BY 
      CASE tm.role 
        WHEN 'admin' THEN 1 
        WHEN 'lead' THEN 2 
        WHEN 'member' THEN 3 
        ELSE 4 
      END ASC,
      u.name ASC
  `;

  try {
    const result = await pool.query(sql, [teamId]);
    res.status(200).json({ members: result.rows });
  } catch (err) {
    logger.error({ err, teamId, requestId: req.requestId }, 'Failed querying team members');
    res.status(500).json({
      error: {
        code: 'QUERY_FAILED',
        message: 'Failed to retrieve team members.',
        requestId: req.requestId,
      },
    });
  }
}

/**
 * Admin: List dead-letter outbox events
 */
export async function listDeadLettersHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  if (!user.isOrgAdmin) {
    res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'Only organizational administrators can view dead-letter events.',
        requestId: req.requestId,
      },
    });
    return;
  }

  const sql = `
    SELECT id, event_type, payload, status, attempts, max_attempts, last_error, created_at, next_attempt_at
    FROM outbox_events
    WHERE status IN ('dead_letter', 'failed')
    ORDER BY created_at DESC
    LIMIT 100
  `;

  try {
    const result = await pool.query(sql);
    res.status(200).json({ deadLetters: result.rows });
  } catch (err) {
    logger.error({ err, requestId: req.requestId }, 'Failed querying dead-letter events');
    res.status(500).json({
      error: {
        code: 'QUERY_FAILED',
        message: 'Failed to retrieve dead-letter events.',
        requestId: req.requestId,
      },
    });
  }
}

/**
 * Admin: Retry a dead-letter event
 */
export async function retryDeadLetterHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  if (!user.isOrgAdmin) {
    res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'Only organizational administrators can retry dead-letter events.',
        requestId: req.requestId,
      },
    });
    return;
  }

  const eventId = req.params.id;

  try {
    const result = await pool.query(
      `UPDATE outbox_events
       SET status = 'pending',
           attempts = 0,
           next_attempt_at = NOW(),
           locked_by = NULL,
           lease_timeout_at = NULL,
           last_error = NULL
       WHERE id = $1 AND status IN ('dead_letter', 'failed')
       RETURNING id, event_type, status`,
      [eventId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: {
          code: 'EVENT_NOT_FOUND',
          message: 'Dead-letter event not found or not in a failed state.',
          requestId: req.requestId,
        },
      });
      return;
    }

    res.status(200).json({ success: true, event: result.rows[0] });
  } catch (err) {
    logger.error({ err, eventId, requestId: req.requestId }, 'Failed retrying dead-letter event');
    res.status(500).json({
      error: {
        code: 'RETRY_FAILED',
        message: 'Failed to retry dead-letter event.',
        requestId: req.requestId,
      },
    });
  }
}
