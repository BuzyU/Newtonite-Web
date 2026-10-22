import pg from 'pg';
import { pool, logger } from './db.js';

export interface OutboxRow {
  id: string;
  event_type: string;
  payload: any;
  status: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  lease_timeout_at: Date | null;
  next_attempt_at: Date;
  last_error: string | null;
}

export class OutboxWorker {
  private workerId: string;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private activePool: pg.Pool;

  constructor(customPool?: pg.Pool) {
    this.workerId = `worker-${process.pid}-${Math.random().toString(36).substring(2, 7)}`;
    this.activePool = customPool || pool;
  }

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info({ workerId: this.workerId }, 'Starting OutboxWorker...');

    // Poll outbox every 1 second
    this.scheduleNextPoll(100);

    // Run SLA and stale scanner every 30 seconds
    this.scanTimer = setInterval(() => {
      this.runSlaScanner().catch((err) => {
        logger.error({ err, workerId: this.workerId }, 'Error running SLA scanner');
      });
    }, 30000);

    // Initial scanner run after 2 seconds
    setTimeout(() => {
      this.runSlaScanner().catch(() => {});
    }, 2000);
  }

  public stop(): void {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);
    logger.info({ workerId: this.workerId }, 'OutboxWorker stopped');
  }

  private scheduleNextPoll(delayMs = 1000): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(async () => {
      try {
        const processedCount = await this.processBatch();
        const nextDelay = processedCount > 0 ? 50 : 1000;
        this.scheduleNextPoll(nextDelay);
      } catch (err) {
        logger.error({ err, workerId: this.workerId }, 'Error during outbox poll cycle');
        this.scheduleNextPoll(3000);
      }
    }, delayMs);
  }

  /**
   * Claims and processes a batch of outbox rows using FOR UPDATE SKIP LOCKED
   */
  public async processBatch(): Promise<number> {
    const client = await this.activePool.connect();
    try {
      await client.query('BEGIN');

      // Claim up to 10 events:
      // (status in ('pending', 'failed') AND next_attempt_at <= NOW())
      // OR lease has expired on a crashed worker (status = 'processing' AND lease_timeout_at < NOW())
      const claimSql = `
        SELECT *
        FROM outbox_events
        WHERE (
          (status IN ('pending', 'failed') AND next_attempt_at <= NOW())
          OR (status = 'processing' AND lease_timeout_at < NOW())
        )
        ORDER BY created_at ASC
        LIMIT 10
        FOR UPDATE SKIP LOCKED
      `;

      const claimRes = await client.query<OutboxRow>(claimSql);
      if (claimRes.rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      // Mark claimed rows as processing with lease timeout (30 seconds)
      const claimedIds = claimRes.rows.map((r) => r.id);
      await client.query(
        `UPDATE outbox_events
         SET status = 'processing',
             locked_by = $1,
             locked_at = NOW(),
             lease_timeout_at = NOW() + INTERVAL '30 seconds',
             attempts = attempts + 1
         WHERE id = ANY($2::uuid[])`,
        [this.workerId, claimedIds]
      );

      await client.query('COMMIT');

      // Process each row individually
      for (const event of claimRes.rows) {
        await this.handleSingleEvent(event);
      }

      return claimRes.rows.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Handles a single event and updates status to completed or failed/dead_letter
   */
  public async handleSingleEvent(event: OutboxRow): Promise<void> {
    const client = await this.activePool.connect();
    try {
      await client.query('BEGIN');

      // Dispatch business logic according to event type
      await this.dispatchHandler(client, event);

      // Mark completed
      await client.query(
        `UPDATE outbox_events
         SET status = 'completed',
             processed_at = NOW(),
             last_error = NULL
         WHERE id = $1`,
        [event.id]
      );

      await client.query('COMMIT');
      logger.info({ eventId: event.id, eventType: event.event_type }, 'Outbox event processed successfully');
    } catch (handlerErr: any) {
      await client.query('ROLLBACK');

      const nextAttempts = event.attempts + 1;
      const isDeadLetter = nextAttempts >= event.max_attempts;
      // Exponential backoff: 2 ^ attempts seconds
      const backoffSeconds = Math.min(Math.pow(2, nextAttempts), 300);

      logger.warn(
        {
          err: handlerErr.message,
          eventId: event.id,
          attempts: nextAttempts,
          isDeadLetter,
          backoffSeconds,
        },
        'Failed processing outbox event'
      );

      await this.activePool.query(
        `UPDATE outbox_events
         SET status = $1,
             last_error = $2,
             attempts = $3,
             next_attempt_at = NOW() + ($4 || ' seconds')::interval,
             lease_timeout_at = NULL,
             locked_by = NULL
         WHERE id = $5`,
        [
          isDeadLetter ? 'dead_letter' : 'failed',
          handlerErr.message || 'Unknown handler error',
          nextAttempts,
          backoffSeconds.toString(),
          event.id,
        ]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Dispatches business handlers based on event_type.
   * Handlers use ON CONFLICT (dedupe_key) DO NOTHING to ensure idempotency.
   */
  private async dispatchHandler(client: pg.PoolClient, event: OutboxRow): Promise<void> {
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;

    switch (event.event_type) {
      case 'item.created': {
        const { itemId, teamId, shortRef, actorId } = payload;
        // Notify team leads that a new item was created
        const leadsRes = await client.query<{ user_id: string }>(
          `SELECT user_id FROM team_memberships WHERE team_id = $1 AND role IN ('lead', 'admin') AND user_id != $2`,
          [teamId, actorId]
        );

        for (const lead of leadsRes.rows) {
          const dedupeKey = `item.created:${itemId}:${lead.user_id}`;
          await client.query(
            `INSERT INTO notifications (user_id, item_id, type, title, message, dedupe_key)
             VALUES ($1, $2, 'item_created', 'New Work Item Created', $3, $4)
             ON CONFLICT (dedupe_key) DO NOTHING`,
            [lead.user_id, itemId, `Work item ${shortRef} was created in your team.`, dedupeKey]
          );
        }
        break;
      }

      case 'item.claimed': {
        const { itemId, assigneeId } = payload;
        // Fetch item details
        const itemRes = await client.query<{ short_ref: string; reporter_id: string }>(
          `SELECT short_ref, reporter_id FROM items WHERE id = $1`,
          [itemId]
        );
        if (itemRes.rows.length > 0) {
          const item = itemRes.rows[0];
          if (item.reporter_id !== assigneeId) {
            const dedupeKey = `item.claimed:${itemId}:${assigneeId}`;
            await client.query(
              `INSERT INTO notifications (user_id, item_id, type, title, message, dedupe_key)
               VALUES ($1, $2, 'item_claimed', 'Work Item Claimed', $3, $4)
               ON CONFLICT (dedupe_key) DO NOTHING`,
              [item.reporter_id, itemId, `Work item ${item.short_ref} was claimed by an assignee.`, dedupeKey]
            );
          }
        }
        break;
      }

      case 'item.commented': {
        const { commentId, itemId, content, mentionedEmails } = payload;

        // Verify item exists
        const itemCheck = await client.query<{ org_id: string }>(
          `SELECT org_id FROM items WHERE id = $1`,
          [itemId]
        );
        if (itemCheck.rows.length === 0) {
          throw new Error(`Referenced item ${itemId} does not exist in items table`);
        }
        const itemOrgId = itemCheck.rows[0].org_id;

        // If specific users were @mentioned, notify them and simulate sending an email
        if (Array.isArray(mentionedEmails) && mentionedEmails.length > 0) {
          for (const email of mentionedEmails) {
            // Mentions resolve ONLY inside the item's organization (no cross-tenant notifications)
            const uRes = await client.query<{ id: string; email: string; name: string }>(
              `SELECT id, email, name FROM users
               WHERE (LOWER(email) = LOWER($1) OR LOWER(email) LIKE LOWER($2))
                 AND is_active = TRUE
                 AND org_id = $3`,
              [email, `${email}%`, itemOrgId]
            );
            if (uRes.rows.length > 0) {
              const mentionedUser = uRes.rows[0];
              const dedupeKey = `comment.mention:${commentId}:${mentionedUser.id}`;

              await client.query(
                `INSERT INTO notifications (user_id, item_id, type, title, message, dedupe_key)
                 VALUES ($1, $2, 'mention', 'You were mentioned in a comment', $3, $4)
                 ON CONFLICT (dedupe_key) DO NOTHING`,
                [
                  mentionedUser.id,
                  itemId,
                  `You were mentioned: "${content.slice(0, 150)}"`,
                  dedupeKey,
                ]
              );

              // Record simulated email
              await client.query(
                `INSERT INTO simulated_emails (recipient_email, subject, body)
                 VALUES ($1, $2, $3)`,
                [
                  mentionedUser.email,
                  `Notification: You were mentioned in work item comment`,
                  `Hello ${mentionedUser.name},\n\nYou were mentioned in a comment:\n\n"${content}"\n\nPlease check the operational dashboard to respond.`,
                ]
              );
              logger.info({ recipient: mentionedUser.email }, 'Simulated notification email dispatched');
            }
          }
        }
        break;
      }

      case 'item.transitioned': {
        const { itemId, newStatus, actorId } = payload;
        const itemRes = await client.query<{ short_ref: string; reporter_id: string; assignee_id: string | null; team_id: string }>(
          `SELECT short_ref, reporter_id, assignee_id, team_id FROM items WHERE id = $1`,
          [itemId]
        );

        if (itemRes.rows.length > 0) {
          const item = itemRes.rows[0];
          // If awaiting approval, notify team leads
          if (newStatus === 'awaiting_approval') {
            const leads = await client.query<{ user_id: string }>(
              `SELECT user_id FROM team_memberships WHERE team_id = $1 AND role IN ('lead', 'admin') AND user_id != $2`,
              [item.team_id, actorId]
            );
            for (const lead of leads.rows) {
              const dedupeKey = `approval_required:${itemId}:${lead.user_id}:${event.id}`;
              await client.query(
                `INSERT INTO notifications (user_id, item_id, type, title, message, dedupe_key)
                 VALUES ($1, $2, 'approval_required', 'Approval Required', $3, $4)
                 ON CONFLICT (dedupe_key) DO NOTHING`,
                [lead.user_id, itemId, `Work item ${item.short_ref} is awaiting lead approval.`, dedupeKey]
              );
            }
          }
        }
        break;
      }

      default:
        logger.info({ eventType: event.event_type }, 'No special handler registered; marking event handled.');
        break;
    }
  }

  /**
   * Periodic SLA & Stale Scanner:
   * Idempotent per (item_id, kind, window_label) using sla_checks table
   */
  public async runSlaScanner(): Promise<number> {
    const client = await this.activePool.connect();
    let eventsCreated = 0;

    try {
      await client.query('BEGIN');

      // 1. Scan for overdue items
      const overdueItems = await client.query<{
        id: string;
        short_ref: string;
        assignee_id: string | null;
        due_at: Date;
      }>(`
        SELECT id, short_ref, assignee_id, due_at
        FROM items
        WHERE due_at < NOW()
          AND status NOT IN ('resolved', 'closed')
          AND archived_at IS NULL
        LIMIT 50
      `);

      for (const item of overdueItems.rows) {
        if (!item.assignee_id) continue;
        const windowLabel = new Date().toISOString().slice(0, 10); // 1 check per calendar day
        const dedupeKey = `overdue:${item.id}:${windowLabel}`;

        const checkRes = await client.query(
          `INSERT INTO sla_checks (dedupe_key, item_id, kind, window_label)
           VALUES ($1, $2, 'overdue', $3)
           ON CONFLICT (dedupe_key) DO NOTHING
           RETURNING id`,
          [dedupeKey, item.id, windowLabel]
        );

        if (checkRes.rows.length > 0) {
          // New check recorded; emit notification
          await client.query(
            `INSERT INTO notifications (user_id, item_id, type, title, message, dedupe_key)
             VALUES ($1, $2, 'overdue', 'Work Item Overdue', $3, $4)
             ON CONFLICT (dedupe_key) DO NOTHING`,
            [
              item.assignee_id,
              item.id,
              `Work item ${item.short_ref} has exceeded its due date.`,
              `notif:${dedupeKey}`,
            ]
          );
          eventsCreated++;
        }
      }

      // 2. Scan for items gone quiet (no activity for >= 3 days)
      const quietItems = await client.query<{
        id: string;
        short_ref: string;
        assignee_id: string | null;
        reporter_id: string;
        last_activity_at: Date;
      }>(`
        SELECT id, short_ref, assignee_id, reporter_id, last_activity_at
        FROM items
        WHERE last_activity_at < (NOW() - INTERVAL '3 days')
          AND status NOT IN ('resolved', 'closed')
          AND archived_at IS NULL
        LIMIT 50
      `);

      for (const item of quietItems.rows) {
        const recipient = item.assignee_id || item.reporter_id;
        const windowLabel = new Date().toISOString().slice(0, 10);
        const dedupeKey = `quiet:${item.id}:${windowLabel}`;

        const checkRes = await client.query(
          `INSERT INTO sla_checks (dedupe_key, item_id, kind, window_label)
           VALUES ($1, $2, 'gone_quiet', $3)
           ON CONFLICT (dedupe_key) DO NOTHING
           RETURNING id`,
          [dedupeKey, item.id, windowLabel]
        );

        if (checkRes.rows.length > 0) {
          await client.query(
            `INSERT INTO notifications (user_id, item_id, type, title, message, dedupe_key)
             VALUES ($1, $2, 'gone_quiet', 'Item Inactive for 3+ Days', $3, $4)
             ON CONFLICT (dedupe_key) DO NOTHING`,
            [
              recipient,
              item.id,
              `Work item ${item.short_ref} has seen no updates for 3 days. Please review progress.`,
              `notif:${dedupeKey}`,
            ]
          );
          eventsCreated++;
        }
      }

      await client.query('COMMIT');
      if (eventsCreated > 0) {
        logger.info({ eventsCreated }, 'SLA scanner generated new notifications');
      }
      return eventsCreated;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err }, 'SLA scanner encountered an error');
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Serverless-friendly drain: process outbox batches until the queue is empty or the time budget
 * is spent. Safe to run concurrently from several invocations (FOR UPDATE SKIP LOCKED).
 */
export async function drainOutbox(maxMs = 8000, customPool?: pg.Pool): Promise<{ processed: number; batches: number }> {
  const worker = new OutboxWorker(customPool);
  const deadline = Date.now() + maxMs;
  let processed = 0;
  let batches = 0;
  while (Date.now() < deadline) {
    const n = await worker.processBatch();
    if (n === 0) break;
    processed += n;
    batches++;
  }
  return { processed, batches };
}

/** Daily maintenance: SLA scan plus pruning of sessions, rate limits, change feed, and old outbox events (T4). */
export async function runMaintenance(customPool?: pg.Pool): Promise<Record<string, number>> {
  const activePool = customPool || pool;
  const worker = new OutboxWorker(activePool);
  const slaNotifications = await worker.runSlaScanner();
  const sessions = await activePool.query(
    `DELETE FROM sessions WHERE revoked_at < NOW() - INTERVAL '7 days'
        OR absolute_expires_at < NOW() - INTERVAL '7 days' OR expires_at < NOW() - INTERVAL '7 days'`
  );
  const rateLimits = await activePool.query(`DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '2 hours'`);
  const changeFeed = await activePool.query(`DELETE FROM change_feed WHERE created_at < NOW() - INTERVAL '1 day'`);
  const outboxEvents = await activePool.query(
    `DELETE FROM outbox_events WHERE status = 'completed' AND processed_at < NOW() - INTERVAL '14 days'`
  );
  return {
    slaNotifications,
    sessionsPruned: sessions.rowCount ?? 0,
    rateLimitsPruned: rateLimits.rowCount ?? 0,
    changeFeedPruned: changeFeed.rowCount ?? 0,
    outboxEventsPruned: outboxEvents.rowCount ?? 0,
  };
}

// CLI standalone runner (for Docker or local worker process)
if (process.argv[1] && (process.argv[1].endsWith('worker.ts') || process.argv[1].endsWith('worker.js'))) {
  const worker = new OutboxWorker();
  worker.start();

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM; stopping worker...');
    worker.stop();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    logger.info('Received SIGINT; stopping worker...');
    worker.stop();
    process.exit(0);
  });
}
