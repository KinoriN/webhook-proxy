export interface WebhookChannel {
  id: string;
  token: string;
  label: string;
  createdAt: number;
  lastEventAt: number | null;
  eventCount: number;
}

export interface WebhookEvent {
  id: string;
  channelId: string;
  channelToken: string;
  channelLabel: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  query: Record<string, string>;
  timestamp: number;
  path: string;
}

export interface Stats {
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
