/**
 * webhook-proxy — Cloudflare Worker entry point
 * Hono framework with KV + Durable Objects for persistent webhook proxy
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  addEvent,
  getChannelById,
  getChannelByToken,
  getStats,
  listChannels,
  queryEvents,
  registerChannel,
} from "./kv-store";
import type { Env, WebhookChannel } from "./shared/types";
import { SSEManager } from "./sse-do";

// --- Helper: get SSEManager DO stub ---
function getSSEManagerStub(env: Env): DurableObjectStub {
  const id = env.SSE_MANAGER.idFromName("default");
  return env.SSE_MANAGER.get(id);
}

// DO stub URLs use an internal scheme — we construct paths directly
const DO_BASE_URL = "http://sse-do.internal";

// --- Hono app ---
const app = new Hono<{ Bindings: Env }>();

// CORS middleware — allow all origins for webhook proxy
app.use("/api/*", cors());

// --- API Routes ---

/**
 * POST /api/webhook/register
 * Register a new webhook channel, returns random token URL
 */
app.post("/api/webhook/register", async (c) => {
  let label: string | undefined;

  try {
    const body = await c.req.json();
    label = body.label;
  } catch {
    // No body or invalid JSON — OK, label stays undefined
  }

  const kv = c.env.WEBHOOK_PROXY_KV;
  const channel = await registerChannel(kv, label);

  // Build URLs from the request
  const baseUrl = new URL(c.req.url).origin;
  const webhookUrl = `${baseUrl}/api/webhook/in/${channel.token}`;

  return c.json(
    {
      channel: {
        id: channel.id,
        token: channel.token,
        label: channel.label,
        createdAt: channel.createdAt,
        lastEventAt: channel.lastEventAt,
        eventCount: channel.eventCount,
      },
      webhookUrl,
      streamUrl: `${baseUrl}/api/webhook/stream?channelId=${channel.id}`,
      historyUrl: `${baseUrl}/api/webhook/history?token=${channel.token}`,
    },
    201,
  );
});

/**
 * GET /api/webhook/channels
 * List channels matching given IDs (query param: ids, comma-separated)
 * When ids is not provided, returns empty list (channel isolation)
 */
app.get("/api/webhook/channels", async (c) => {
  const idsParam = c.req.query("ids");
  if (!idsParam) {
    return c.json({ channels: [], total: 0 });
  }

  const kv = c.env.WEBHOOK_PROXY_KV;
  const ids = idsParam.split(",").filter(Boolean);
  const channels: WebhookChannel[] = [];

  for (const id of ids) {
    const channel = await getChannelById(kv, id);
    if (channel) {
      channels.push(channel);
    }
  }

  return c.json({
    channels,
    total: channels.length,
  });
});

/**
 * GET /api/webhook/channel/:id
 * Get a single channel by ID — used when user manually adds an existing channel
 */
app.get("/api/webhook/channel/:id", async (c) => {
  const id = c.req.param("id");
  const kv = c.env.WEBHOOK_PROXY_KV;
  const channel = await getChannelById(kv, id);

  if (!channel) {
    return c.json({ error: "Channel not found" }, 404);
  }

  return c.json({ channel });
});

/**
 * POST|PUT|DELETE|PATCH|GET /api/webhook/in/:token
 * Receive webhook requests from external services
 * Validates token, stores event, broadcasts via SSE DO
 */
app.all("/api/webhook/in/:token", async (c) => {
  const token = c.req.param("token");

  // Validate token
  const kv = c.env.WEBHOOK_PROXY_KV;
  const channel = await getChannelByToken(kv, token);
  if (!channel) {
    return c.json(
      {
        error:
          "Invalid webhook token. Please register a channel first via POST /api/webhook/register",
      },
      404,
    );
  }

  // Extract headers as-is
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Extract query parameters
  const query: Record<string, string> = {};
  const url = new URL(c.req.url);
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  // Extract request body
  let body: unknown;
  try {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      body = await c.req.json();
    } else if (contentType.includes("text/") || contentType.includes("xml")) {
      body = await c.req.text();
    } else if (
      contentType.includes("form-data") ||
      contentType.includes("x-www-form-urlencoded")
    ) {
      body = await c.req.text();
    } else {
      // Try JSON first, fall back to text
      try {
        body = await c.req.json();
      } catch {
        body = await c.req.text();
      }
    }
  } catch {
    body = null;
  }

  // Store event in KV
  const event = await addEvent(kv, {
    channelId: channel.id,
    channelToken: channel.token,
    channelLabel: channel.label,
    method: c.req.method,
    headers,
    body,
    query,
    path: url.pathname,
  });

  // Broadcast via SSE Durable Object
  const stub = getSSEManagerStub(c.env);
  const broadcastUrl = `${DO_BASE_URL}/broadcast`;
  await stub.fetch(
    new Request(broadcastUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    }),
  );

  return c.json(
    {
      received: true,
      id: event.id,
      channel: channel.label,
      timestamp: event.timestamp,
    },
    200,
  );
});

/**
 * GET /api/webhook/stream
 * SSE endpoint — real-time webhook event stream
 * Optional query param: channelId (filter to specific channel)
 */
app.get("/api/webhook/stream", async (c) => {
  const channelId = c.req.query("channelId");
  const stub = getSSEManagerStub(c.env);

  const streamUrl = channelId
    ? `${DO_BASE_URL}/stream?channelId=${channelId}`
    : `${DO_BASE_URL}/stream`;

  const response = await stub.fetch(
    new Request(streamUrl, {
      headers: c.req.raw.headers,
    }),
  );

  return new Response(response.body, {
    headers: response.headers,
    status: response.status,
  });
});

/**
 * POST /api/webhook/sse-ping
 * Client heartbeat ping — proves SSE client is still alive
 */
app.post("/api/webhook/sse-ping", async (c) => {
  const stub = getSSEManagerStub(c.env);
  const body = await c.req.text();
  const response = await stub.fetch(
    new Request(`${DO_BASE_URL}/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );
  return new Response(response.body, {
    headers: response.headers,
    status: response.status,
  });
});

/**
 * POST /api/webhook/sse-cancel
 * Explicit client disconnect — remove SSE client from DO
 */
app.post("/api/webhook/sse-cancel", async (c) => {
  const stub = getSSEManagerStub(c.env);
  const body = await c.req.text();
  const response = await stub.fetch(
    new Request(`${DO_BASE_URL}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );
  return new Response(response.body, {
    headers: response.headers,
    status: response.status,
  });
});

/**
 * GET /api/webhook/history
 * Query historical webhook events for one channel
 * Query params: token, since, until, limit, offset
 */
app.get("/api/webhook/history", async (c) => {
  const kv = c.env.WEBHOOK_PROXY_KV;

  const token = c.req.query("token");
  const since = c.req.query("since");
  const until = c.req.query("until");
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? "50"), 1),
    200,
  );
  const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);

  if (!token) {
    return c.json({ error: "token is required" }, 400);
  }

  const channel = await getChannelByToken(kv, token);
  if (!channel) {
    return c.json({ error: "Channel not found" }, 404);
  }

  const result = await queryEvents(kv, channel.id, {
    since: since ? Number(since) : undefined,
    until: until ? Number(until) : undefined,
    limit,
    offset,
  });

  return c.json({
    events: result.events,
    total: result.total,
    limit,
    offset,
  });
});

/**
 * GET /api/webhook/stats
 * Get webhook proxy statistics
 * Accepts optional `ids` query param (comma-separated channel IDs) to scope channel info
 * Without ids, returns total count only (no channel list for isolation)
 */
app.get("/api/webhook/stats", async (c) => {
  const kv = c.env.WEBHOOK_PROXY_KV;
  const idsParam = c.req.query("ids");

  const storeStats = await getStats(kv);
  const allChannels = await listChannels(kv);

  // Get SSE stats from Durable Object
  const stub = getSSEManagerStub(c.env);
  const sseResponse = await stub.fetch(new Request(`${DO_BASE_URL}/stats`));
  const sseStats = await sseResponse.json();

  // Filter channels if ids provided, otherwise don't leak list
  const channelList = idsParam
    ? allChannels
        .filter((ch) => idsParam.split(",").filter(Boolean).includes(ch.id))
        .map((ch) => ({
          id: ch.id,
          token: "***",
          label: ch.label,
          createdAt: ch.createdAt,
          lastEventAt: ch.lastEventAt,
          eventCount: ch.eventCount,
        }))
    : [];

  return c.json({
    store: storeStats,
    sse: sseStats,
    channels: {
      total: allChannels.length,
      list: channelList,
    },
  });
});

// --- Export Worker + Durable Object ---
export default app;
export { SSEManager };
