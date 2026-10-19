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
 * Payload carries only ids, version, and event type.
 */
export function broadcastEvent(event: {
  id?: string;
  event_type: string;
  team_id?: string;
  item_id?: string;
  version?: number | string;
  created_at?: string;
}): void {
  const eventId = event.id || Date.now().toString();
  const data = JSON.stringify({
    type: event.event_type,
    itemId: event.item_id,
    teamId: event.team_id,
    version: event.version,
    timestamp: event.created_at || new Date().toISOString(),
  });

  for (const [clientId, client] of sseClients.entries()) {
    // Team scoping check: If the event has a teamId, user must belong to that team or be org admin
    if (event.team_id) {
      const hasAccess = client.user.isOrgAdmin || client.user.memberships.has(event.team_id);
      if (!hasAccess) {
        continue; // Never leak team B events to team A users
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
