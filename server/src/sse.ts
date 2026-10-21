import { Request, Response } from 'express';
import pg from 'pg';
import { createListenClient, logger } from './db.js';
import { UserContext } from './policy.js';

export interface SseClient {
  id: string;
  user: UserContext;
  res: Response;
  connectedAt: Date;
}

const sseClients = new Map<string, SseClient>();
let listenClient: pg.Client | null = null;
let isReconnecting = false;
let heartbeatTimer: NodeJS.Timeout | null = null;

/**
 * Initializes the dedicated LISTEN client with auto-reconnect and backoff.
 */
export async function initSseListener(): Promise<void> {
  if (listenClient) return;

  async function connectListener(attempt = 1) {
    try {
      listenClient = createListenClient();
      await listenClient.connect();
      logger.info('Dedicated Postgres LISTEN client connected to newtonite_events channel');

      await listenClient.query('LISTEN newtonite_events');

      listenClient.on('notification', (msg) => {
        if (!msg.payload) return;
        try {
          const event = JSON.parse(msg.payload);
          broadcastEvent(event);
        } catch (err) {
          logger.error({ err, payload: msg.payload }, 'Failed parsing PG notification payload');
        }
      });

      listenClient.on('end', () => {
        logger.warn('Postgres LISTEN client connection ended; reconnecting...');
        handleReconnect();
      });

      listenClient.on('error', (err) => {
        logger.error({ err }, 'Error in Postgres LISTEN client');
        handleReconnect();
      });

      // After reconnect, broadcast resync to all connected SSE clients
      if (attempt > 1) {
        broadcastResync();
      }
    } catch (err) {
      logger.error({ err, attempt }, 'Failed connecting Postgres LISTEN client; scheduling retry');
      handleReconnect(attempt + 1);
    }
  }

  function handleReconnect(nextAttempt = 1) {
    if (isReconnecting) return;
    isReconnecting = true;
    listenClient = null;

    const delay = Math.min(1000 * Math.pow(2, nextAttempt), 30000);
    setTimeout(async () => {
      isReconnecting = false;
      await connectListener(nextAttempt);
    }, delay);
  }

  await connectListener();

  // Periodic heartbeat every 20 seconds to keep HTTP connections alive
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      for (const client of sseClients.values()) {
        try {
          client.res.write(': heartbeat\n\n');
        } catch {
          sseClients.delete(client.id);
        }
      }
    }, 20000);
  }
}

/**
 * Broadcasts an event filtered strictly by the client's team membership.
 * Re-checks team membership against the database on each broadcast so removed members immediately stop receiving events.
 * Events lacking a team_id are strictly delivered only to Org Admins.
 */
export async function broadcastEvent(event: {
  id?: string;
  event_type: string;
  team_id?: string;
  item_id?: string;
  version?: number | string;
  created_at?: string;
}): Promise<void> {
  const eventId = event.id || Date.now().toString();
  const data = JSON.stringify({
    type: event.event_type,
    itemId: event.item_id,
    teamId: event.team_id,
    version: event.version,
    timestamp: event.created_at || new Date().toISOString(),
  });

  // Dynamic live DB membership verification
  const allowedUserIds = new Set<string>();
  if (event.team_id) {
    const nonAdminUserIds = Array.from(
      new Set(
        Array.from(sseClients.values())
          .filter((c) => !c.user.isOrgAdmin)
          .map((c) => c.user.id)
      )
    );

    if (nonAdminUserIds.length > 0) {
      try {
        const { pool } = await import('./db.js');
        const memRes = await pool.query(
          `SELECT user_id FROM team_memberships WHERE team_id = $1 AND user_id = ANY($2::uuid[])`,
          [event.team_id, nonAdminUserIds]
        );
        for (const row of memRes.rows) {
          allowedUserIds.add(row.user_id);
        }
      } catch (err) {
        logger.error({ err, teamId: event.team_id }, 'Failed querying live team memberships during SSE broadcast');
      }
    }
  }

  for (const [clientId, client] of sseClients.entries()) {
    // 1. If event has team_id: user must be org admin OR currently verified in team_memberships
    if (event.team_id) {
      const hasAccess = client.user.isOrgAdmin || allowedUserIds.has(client.user.id);
      if (!hasAccess) {
        client.user.memberships.delete(event.team_id);
        continue; // Never leak events to users outside the team or recently removed
      }
    } else {
      // 2. Events lacking team_id (e.g. org-wide notices or DLQ updates):
      // Only delivered to Org Admins. Regular operators never receive unscoped events.
      if (!client.user.isOrgAdmin) {
        continue;
      }
    }

    try {
      client.res.write(`id: ${eventId}\nevent: item_update\ndata: ${data}\n\n`);
    } catch {
      sseClients.delete(clientId);
    }
  }
}

/**
 * Broadcasts a 'resync' signal to all clients, prompting TanStack Query to invalidate caches
 */
export function broadcastResync(): void {
  for (const [clientId, client] of sseClients.entries()) {
    try {
      client.res.write(`event: resync\ndata: {}\n\n`);
    } catch {
      sseClients.delete(clientId);
    }
  }
}

/**
 * Drop all active SSE connections for a specific user ID (e.g. when membership revoked or logged out)
 */
export function dropUserSseClients(userId: string): void {
  for (const [clientId, client] of sseClients.entries()) {
    if (client.user.id === userId) {
      try {
        client.res.end();
      } catch {
        // ignore
      }
      sseClients.delete(clientId);
    }
  }
}

export function getSseClientCount(): number {
  return sseClients.size;
}

export function getSseClients(): Map<string, SseClient> {
  return sseClients;
}

/**
 * Express SSE endpoint handler: /api/v1/events
 */
export function sseHandler(req: Request, res: Response): void {
  const user = req.user!;
  const clientId = `${user.id}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  // Essential SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disables proxy buffering in Nginx / Vercel

  res.flushHeaders();

  // Initial connected handshake
  res.write(`id: ${Date.now()}\nevent: connected\ndata: ${JSON.stringify({ clientId, userId: user.id })}\n\n`);

  // Handle Last-Event-ID or reconnect query: emit resync so client immediately catches up
  const lastEventId = req.headers['last-event-id'] || req.query.lastEventId;
  if (lastEventId) {
    res.write(`event: resync\ndata: ${JSON.stringify({ lastEventId })}\n\n`);
  }

  const sseClient: SseClient = {
    id: clientId,
    user,
    res,
    connectedAt: new Date(),
  };

  sseClients.set(clientId, sseClient);
  logger.info({ clientId, userId: user.id }, 'SSE client connected');

  req.on('close', () => {
    sseClients.delete(clientId);
    logger.info({ clientId, userId: user.id }, 'SSE client disconnected');
  });
}

/**
 * Graceful shutdown helper
 */
export async function closeSseHub(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const client of sseClients.values()) {
    try {
      client.res.end();
    } catch {
      // ignore
    }
  }
  sseClients.clear();
  if (listenClient) {
    try {
      await listenClient.end();
    } catch {
      // ignore
    }
    listenClient = null;
  }
}
