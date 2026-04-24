/**
 * Shared type definitions for webhook-proxy
 */

/** WebhookChannel — each registered channel represents an independent webhook entry */
export interface WebhookChannel {
  id: string; // channel ID, e.g. "ch_1714123456789_a7x9"
  token: string; // random path token, 12 alphanumeric chars
  label: string; // user-defined label, e.g. "github-push"
  createdAt: number; // creation timestamp (ms)
  lastEventAt: number | null; // last event timestamp (ms), null if no events
  eventCount: number; // total event count
}

/** WebhookEvent — a single webhook request received */
export interface WebhookEvent {
  id: string; // event ID, e.g. "evt_42_1714123456789"
  channelId: string; // owning channel ID
  channelToken: string; // owning channel token
  channelLabel: string; // channel label for display
  method: string; // HTTP method (POST, PUT, DELETE, PATCH, GET)
  headers: Record<string, string>; // request headers (sensitive fields redacted)
  body: unknown; // request body
  query: Record<string, string>; // URL query parameters
  timestamp: number; // received timestamp (ms)
  path: string; // original request path
}

/** Query filters for event history */
export interface EventQueryFilters {
  channelId?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

/** Stats response */
export interface WebhookStats {
  store: {
    totalEvents: number;
    totalChannels: number;
    channels: Record<string, number>;
    lastEventTime: number | null;
  };
  sse: {
    connectedClients: number;
    clients: Array<{
      id: string;
      filters?: { channelId?: string };
      connectedAt: number;
    }>;
  };
  channels: {
    total: number;
    list: WebhookChannel[];
  };
}

/** SSE message types */
export interface SSEMessage {
  type: "connected" | "webhook" | "heartbeat" | "disconnect";
  data: unknown;
}

/** Hono environment bindings type */
export type Env = {
  WEBHOOK_PROXY_KV: KVNamespace;
  SSE_MANAGER: DurableObjectNamespace;
};
