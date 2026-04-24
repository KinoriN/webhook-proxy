/**
 * SSEManager Durable Object — Server-Sent Events management for Cloudflare Workers
 * Uses Durable Object alarms for reliable periodic cleanup.
 *
 * Key insight: In CF Workers, we cannot reliably detect disconnected SSE clients
 * from the DO side (controller.desiredSize stays non-null, enqueue doesn't throw).
 * Instead, we track time since last successful interaction and remove stale clients.
 * - Broadcasts update lastActive (proves client channel is still flowing)
 * - Alarm runs every 30s, removes clients with no activity for 90s+
 * - request.signal.abort IS reliable for the proxy layer between Worker↔DO,
 *   so clients that properly close SSE get removed immediately
 */

import type { SSEMessage, WebhookEvent } from "./shared/types";

interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController;
  filters?: {
    channelId?: string;
  };
  connectedAt: number;
  lastActive: number; // last time we sent data or confirmed alive
}

const ALARM_INTERVAL_MS = 30_000; // alarm fires every 30s
const CLIENT_STALE_MS = 90_000; // 90s without activity = stale client

export class SSEManager implements DurableObject {
  private clients: Map<string, SSEClient> = new Map();
  private idCounter = 0;
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Record<string, unknown>) {
    this.state = state;
  }

  /** Durable Object alarm handler — reliable cleanup even when DO is idle */
  async alarm(): Promise<void> {
    this.cleanupStaleClients();

    // Always schedule next alarm if there are clients
    if (this.clients.size > 0) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /** Ensure alarm is scheduled */
  private ensureAlarm(): void {
    // setAlarm will overwrite existing alarm if sooner/later, which is fine
    if (this.clients.size > 0) {
      this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /** Handle incoming fetch requests */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname;

    // SSE connection endpoint
    if (action === "/stream" || action === "/" || action === "") {
      const channelId = url.searchParams.get("channelId");
      const filters: { channelId?: string } = {};
      if (channelId) {
        filters.channelId = channelId;
      }

      const stream = new ReadableStream({
        start: (controller) => {
          const clientId = this.addClient(controller, filters);
          this.ensureAlarm();

          // Handle client disconnect via abort signal
          request.signal.addEventListener("abort", () => {
            this.removeClient(clientId);
          });
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // Cancel endpoint — explicit client disconnect
    if (action === "/cancel") {
      let clientId: string | undefined;
      try {
        const body = (await request.json()) as { clientId?: string };
        clientId = body.clientId;
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (!clientId) {
        return new Response(JSON.stringify({ error: "Missing clientId" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const existed = this.clients.has(clientId);
      if (existed) {
        this.removeClient(clientId);
      }

      return new Response(JSON.stringify({ cancelled: existed, clientId }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Cleanup endpoint — force-remove stale clients
    if (action === "/cleanup") {
      const removed = this.cleanupStaleClients();
      return new Response(
        JSON.stringify({
          removed,
          remaining: this.clients.size,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Broadcast endpoint
    if (action === "/broadcast") {
      const eventData: WebhookEvent = await request.json();
      this.broadcast(eventData);
      return new Response(
        JSON.stringify({ broadcast: true, clients: this.clients.size }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Stats endpoint
    if (action === "/stats") {
      return new Response(JSON.stringify(this.stats()), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Heartbeat ping from client — proves client is still alive
    if (action === "/ping") {
      let clientId: string | undefined;
      try {
        const body = (await request.json()) as { clientId?: string };
        clientId = body.clientId;
      } catch {
        // ignore
      }
      if (clientId) {
        const client = this.clients.get(clientId);
        if (client) {
          client.lastActive = Date.now();
        }
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  /** Add an SSE client */
  private addClient(
    controller: ReadableStreamDefaultController,
    filters?: { channelId?: string },
  ): string {
    const id = `sse_${++this.idCounter}_${Date.now()}`;
    const now = Date.now();
    const client: SSEClient = {
      id,
      controller,
      filters,
      connectedAt: now,
      lastActive: now,
    };
    this.clients.set(id, client);

    // Send connection success event with clientId
    this.sendToClient(client, {
      type: "connected",
      data: {
        clientId: id,
        channelId: filters?.channelId,
        message: "SSE connection established ✨",
      },
    });

    return id;
  }

  /** Remove an SSE client */
  private removeClient(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      try {
        client.controller.close();
      } catch {
        // ignore
      }
    }
    this.clients.delete(id);
  }

  /** Broadcast a webhook event to all matching clients */
  broadcast(event: WebhookEvent): void {
    const deadIds: string[] = [];

    for (const client of this.clients.values()) {
      if (
        client.filters?.channelId &&
        client.filters.channelId !== event.channelId
      ) {
        // Update lastActive even for filtered-out clients (they're still connected)
        client.lastActive = Date.now();
        continue;
      }
      const ok = this.sendToClient(client, {
        type: "webhook",
        data: event,
      });
      if (!ok) {
        deadIds.push(client.id);
      }
    }

    for (const id of deadIds) {
      this.removeClient(id);
    }
  }

  /** Send a message to a single client. Returns true if sent, false if dead. */
  private sendToClient(client: SSEClient, message: SSEMessage): boolean {
    try {
      const sseMessage = `event: ${message.type}\ndata: ${JSON.stringify(message.data)}\n\n`;
      const encoder = new TextEncoder();
      client.controller.enqueue(encoder.encode(sseMessage));
      client.lastActive = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  /** Remove clients that haven't had any activity for CLIENT_STALE_MS */
  private cleanupStaleClients(): number {
    const now = Date.now();
    const staleIds: string[] = [];

    for (const client of this.clients.values()) {
      // Also try desiredSize check as an extra signal
      try {
        if (client.controller.desiredSize === null) {
          staleIds.push(client.id);
          continue;
        }
      } catch {
        staleIds.push(client.id);
        continue;
      }

      // Main strategy: timeout-based cleanup
      if (now - client.lastActive > CLIENT_STALE_MS) {
        staleIds.push(client.id);
      }
    }

    for (const id of staleIds) {
      this.removeClient(id);
    }

    return staleIds.length;
  }

  /** Return stats about connected clients */
  stats(): {
    connectedClients: number;
    clients: Array<{
      id: string;
      filters?: { channelId?: string };
      connectedAt: number;
    }>;
  } {
    return {
      connectedClients: this.clients.size,
      clients: Array.from(this.clients.values()).map((c) => ({
        id: c.id,
        filters: c.filters,
        connectedAt: c.connectedAt,
      })),
    };
  }
}
