/**
 * KV-backed channel and event store for webhook-proxy
 * Replaces in-memory Map stores with Cloudflare KV persistence
 */

import type {
  EventQueryFilters,
  WebhookChannel,
  WebhookEvent,
} from "./shared/types";

// --- Constants ---
const TOKEN_LENGTH = 12;
const MAX_CHANNELS = 100;
const MAX_EVENTS_PER_CHANNEL = 500;

// --- KV Key patterns ---
// channel:{token} → JSON WebhookChannel
// channel_id:{channelId} → token string
// channel_list → JSON array of channel IDs
// events:{channelId} → JSON array of WebhookEvent (max 500)
// event_counter:{channelId} → number string

// --- Token generation ---
function generateToken(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function generateChannelId(): string {
  return `ch_${Date.now()}_${generateToken(4)}`;
}

function generateEventId(counter: number): string {
  return `evt_${counter}_${Date.now()}`;
}

// --- Channel functions ---

/** Register a new channel, store in KV */
export async function registerChannel(
  kv: KVNamespace,
  label?: string,
): Promise<WebhookChannel> {
  // Load channel list to check max and assign label
  const channelListRaw = await kv.get("channel_list");
  const channelList: string[] = channelListRaw
    ? JSON.parse(channelListRaw)
    : [];

  // If at max capacity, remove the oldest channel
  if (channelList.length >= MAX_CHANNELS) {
    // Find oldest by loading all channels and sorting by createdAt
    const allChannels = await listChannels(kv);
    const oldest = allChannels.sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) {
      // Delete oldest channel data
      await kv.delete(`channel:${oldest.token}`);
      await kv.delete(`channel_id:${oldest.id}`);
      await kv.delete(`events:${oldest.id}`);
      await kv.delete(`event_counter:${oldest.id}`);
      // Remove from list
      channelList.splice(channelList.indexOf(oldest.id), 1);
    }
  }

  // Generate unique token
  let token = generateToken(TOKEN_LENGTH);
  while (await kv.get(`channel:${token}`)) {
    token = generateToken(TOKEN_LENGTH);
  }

  const channelId = generateChannelId();
  const channel: WebhookChannel = {
    id: channelId,
    token,
    label: label ?? `channel-${channelList.length + 1}`,
    createdAt: Date.now(),
    lastEventAt: null,
    eventCount: 0,
  };

  // Store channel data
  await kv.put(`channel:${token}`, JSON.stringify(channel));
  await kv.put(`channel_id:${channelId}`, token);

  // Update channel list
  channelList.push(channelId);
  await kv.put("channel_list", JSON.stringify(channelList));

  return channel;
}

/** Get channel by its token */
export async function getChannelByToken(
  kv: KVNamespace,
  token: string,
): Promise<WebhookChannel | null> {
  const raw = await kv.get(`channel:${token}`);
  return raw ? JSON.parse(raw) : null;
}

/** Get channel by its ID */
export async function getChannelById(
  kv: KVNamespace,
  channelId: string,
): Promise<WebhookChannel | null> {
  const token = await kv.get(`channel_id:${channelId}`);
  if (!token) return null;
  return getChannelByToken(kv, token);
}

/** List all channels, sorted by createdAt descending */
export async function listChannels(kv: KVNamespace): Promise<WebhookChannel[]> {
  const channelListRaw = await kv.get("channel_list");
  if (!channelListRaw) return [];

  const channelIds: string[] = JSON.parse(channelListRaw);
  const channels: WebhookChannel[] = [];

  for (const id of channelIds) {
    const channel = await getChannelById(kv, id);
    if (channel) {
      channels.push(channel);
    }
  }

  // Sort newest first
  return channels.sort((a, b) => b.createdAt - a.createdAt);
}

/** Update channel metadata after receiving an event */
export async function recordChannelEvent(
  kv: KVNamespace,
  channelId: string,
): Promise<void> {
  const channel = await getChannelById(kv, channelId);
  if (!channel) return;

  channel.eventCount++;
  channel.lastEventAt = Date.now();

  // Update both channel entries
  await kv.put(`channel:${channel.token}`, JSON.stringify(channel));
}

// --- Event functions ---

/** Add a webhook event, enforce max 500 per channel */
export async function addEvent(
  kv: KVNamespace,
  event: Omit<WebhookEvent, "id" | "timestamp">,
): Promise<WebhookEvent> {
  // Get and increment event counter
  const counterRaw = await kv.get(`event_counter:${event.channelId}`);
  const counter = counterRaw ? Number(counterRaw) + 1 : 1;
  await kv.put(`event_counter:${event.channelId}`, String(counter));

  const fullEvent: WebhookEvent = {
    ...event,
    id: generateEventId(counter),
    timestamp: Date.now(),
  };

  // Get existing events for this channel
  const eventsRaw = await kv.get(`events:${event.channelId}`);
  const events: WebhookEvent[] = eventsRaw ? JSON.parse(eventsRaw) : [];

  // Append new event
  events.push(fullEvent);

  // Enforce max 500 — trim oldest
  const trimmed =
    events.length > MAX_EVENTS_PER_CHANNEL
      ? events.slice(-MAX_EVENTS_PER_CHANNEL)
      : events;

  await kv.put(`events:${event.channelId}`, JSON.stringify(trimmed));

  // Update channel metadata
  await recordChannelEvent(kv, event.channelId);

  return fullEvent;
}

/** Query events for a specific channel with filters */
export async function queryEvents(
  kv: KVNamespace,
  channelId: string,
  filters?: EventQueryFilters,
): Promise<{ events: WebhookEvent[]; total: number }> {
  const eventsRaw = await kv.get(`events:${channelId}`);
  if (!eventsRaw) return { events: [], total: 0 };

  let all: WebhookEvent[] = JSON.parse(eventsRaw);

  // Apply time filters
  const since = filters?.since;
  const until = filters?.until;
  if (since) {
    all = all.filter((e) => e.timestamp >= since);
  }
  if (until) {
    all = all.filter((e) => e.timestamp <= until);
  }

  // Sort newest first
  all = all.sort((a, b) => b.timestamp - a.timestamp);

  const total = all.length;
  const offset = filters?.offset ?? 0;
  const limit = filters?.limit ?? 50;
  const events = all.slice(offset, offset + limit);

  return { events, total };
}

/** Query events across all channels with filters */
export async function queryAllEvents(
  kv: KVNamespace,
  filters?: EventQueryFilters,
): Promise<{ events: WebhookEvent[]; total: number }> {
  // Get channel list
  const channelListRaw = await kv.get("channel_list");
  if (!channelListRaw) return { events: [], total: 0 };

  const channelIds: string[] = JSON.parse(channelListRaw);
  let allEvents: WebhookEvent[] = [];

  // Gather events from all channels
  for (const channelId of channelIds) {
    const result = await queryEvents(kv, channelId, {
      since: filters?.since,
      until: filters?.until,
    });
    allEvents = allEvents.concat(result.events);
  }

  // Apply channel filter
  if (filters?.channelId) {
    allEvents = allEvents.filter((e) => e.channelId === filters.channelId);
  }

  // Sort newest first (already sorted per channel, but need global sort)
  allEvents = allEvents.sort((a, b) => b.timestamp - a.timestamp);

  const total = allEvents.length;
  const offset = filters?.offset ?? 0;
  const limit = filters?.limit ?? 100;
  const events = allEvents.slice(offset, offset + limit);

  return { events, total };
}

/** Get aggregate stats */
export async function getStats(kv: KVNamespace): Promise<{
  totalEvents: number;
  totalChannels: number;
  channels: Record<string, number>;
  lastEventTime: number | null;
}> {
  const channelListRaw = await kv.get("channel_list");
  if (!channelListRaw) {
    return {
      totalEvents: 0,
      totalChannels: 0,
      channels: {},
      lastEventTime: null,
    };
  }

  const channelIds: string[] = JSON.parse(channelListRaw);
  const channels: Record<string, number> = {};
  let totalEvents = 0;
  let lastTimestamp: number | null = null;

  for (const channelId of channelIds) {
    const eventsRaw = await kv.get(`events:${channelId}`);
    const events: WebhookEvent[] = eventsRaw ? JSON.parse(eventsRaw) : [];
    channels[channelId] = events.length;
    totalEvents += events.length;

    if (events.length > 0) {
      const latest = events[events.length - 1].timestamp;
      if (latest > (lastTimestamp ?? 0)) {
        lastTimestamp = latest;
      }
    }
  }

  return {
    totalEvents,
    totalChannels: channelIds.length,
    channels,
    lastEventTime: lastTimestamp,
  };
}
