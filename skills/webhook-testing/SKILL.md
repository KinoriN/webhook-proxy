---
name: webhook-testing
description: Use when testing webhooks with the webhook-proxy service. Registers channels, sends sample webhook requests, listens via SSE, checks history/stats, and forwards events to local services using https://webhook.kinori.me by default.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [webhook, testing, sse, cloudflare-worker, curl]
    related_skills: [webhook-proxy-develop]
---

# Webhook Testing with webhook-proxy

## Overview

Use the hosted webhook-proxy service as a temporary webhook receiver and relay. The default service base URL is:

```bash
BASE_URL="https://webhook.kinori.me"
```

The service creates isolated webhook **channels**. Each channel has a random token and a receive URL:

```text
https://webhook.kinori.me/api/webhook/in/<token>
```

Incoming requests are stored in history and broadcast in real time over Server-Sent Events (SSE). Use this skill to validate webhook payloads, headers, query strings, HTTP methods, and local webhook handlers.

## When to Use

- You need a public URL to receive webhooks from GitHub, Stripe, Linear, custom apps, or test scripts.
- You need to inspect what an external service actually sends.
- You need to replay/forward received webhook events to a local development server.
- You need to verify the webhook-proxy API itself.

Do not use this as a long-term production queue. Channels/events are bounded and intended for testing.

## API Quick Reference

All API routes are under `/api/webhook`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/register` | Create a channel. Body: `{ "label": "optional-name" }` |
| `GET` | `/channels?ids=id1,id2` | List only the provided channel IDs. Without `ids`, returns an empty list. |
| `GET` | `/channel/:id` | Fetch one channel by ID. |
| `ALL` | `/in/:token` | Receive a webhook for the token. Supports GET/POST/PUT/PATCH/DELETE/etc. |
| `GET` | `/stream?channelId=<id>` | SSE stream for real-time events, optionally filtered to a channel. |
| `POST` | `/sse-ping` | Heartbeat for an SSE client: `{ "clientId": "..." }`. |
| `POST` | `/sse-cancel` | Explicitly disconnect an SSE client: `{ "clientId": "..." }`. |
| `GET` | `/history?token=<token>&limit=50&offset=0` | Query stored events. Supports `since`, `until`, `limit`, `offset`. |
| `GET` | `/stats?ids=id1,id2` | Service stats. With `ids`, includes matching channel metadata; without ids, channel list is hidden. |

## Response Shapes

### Register Channel

```bash
curl -sS -X POST "$BASE_URL/api/webhook/register" \
  -H 'content-type: application/json' \
  -d '{"label":"my-webhook-test"}' | jq .
```

Returns HTTP `201`:

```json
{
  "channel": {
    "id": "ch_...",
    "token": "wh_...",
    "label": "my-webhook-test",
    "createdAt": 1770000000000,
    "lastEventAt": null,
    "eventCount": 0
  },
  "webhookUrl": "https://webhook.kinori.me/api/webhook/in/wh_...",
  "streamUrl": "https://webhook.kinori.me/api/webhook/stream?channelId=ch_...",
  "historyUrl": "https://webhook.kinori.me/api/webhook/history?token=wh_..."
}
```

### Received Webhook Response

A valid request to `/in/:token` returns HTTP `200`:

```json
{
  "received": true,
  "id": "evt_...",
  "channel": "my-webhook-test",
  "timestamp": 1770000000000
}
```

An invalid token returns HTTP `404`:

```json
{
  "error": "Invalid webhook token. Please register a channel first via POST /api/webhook/register"
}
```

### Event Shape

History and SSE webhook events contain:

```json
{
  "id": "evt_...",
  "channelId": "ch_...",
  "channelToken": "wh_...",
  "channelLabel": "my-webhook-test",
  "method": "POST",
  "headers": { "content-type": "application/json" },
  "body": { "hello": "world" },
  "query": { "source": "manual" },
  "timestamp": 1770000000000,
  "path": "/api/webhook/in/wh_..."
}
```

Headers are stored as received. Treat channel URLs/tokens as sensitive.

## Basic Test Workflow

### 1. Create a channel

```bash
BASE_URL="https://webhook.kinori.me"
REGISTER_JSON=$(curl -sS -X POST "$BASE_URL/api/webhook/register" \
  -H 'content-type: application/json' \
  -d '{"label":"agent-webhook-test"}')

CHANNEL_ID=$(printf '%s' "$REGISTER_JSON" | jq -r '.channel.id')
CHANNEL_TOKEN=$(printf '%s' "$REGISTER_JSON" | jq -r '.channel.token')
WEBHOOK_URL=$(printf '%s' "$REGISTER_JSON" | jq -r '.webhookUrl')
STREAM_URL=$(printf '%s' "$REGISTER_JSON" | jq -r '.streamUrl')
HISTORY_URL=$(printf '%s' "$REGISTER_JSON" | jq -r '.historyUrl')

printf 'CHANNEL_ID=%s\nCHANNEL_TOKEN=%s\nWEBHOOK_URL=%s\nSTREAM_URL=%s\nHISTORY_URL=%s\n' \
  "$CHANNEL_ID" "$CHANNEL_TOKEN" "$WEBHOOK_URL" "$STREAM_URL" "$HISTORY_URL"
```

### 2. Send a sample webhook

```bash
curl -sS -X POST "$WEBHOOK_URL?source=manual&case=json" \
  -H 'content-type: application/json' \
  -H 'x-test-header: hello' \
  -d '{"event":"test.created","ok":true,"nested":{"n":1}}' | jq .
```

### 3. Verify history

```bash
curl -sS "$BASE_URL/api/webhook/history?token=$CHANNEL_TOKEN&limit=10" | jq .
```

Check that the newest event has the expected `method`, `headers`, `body`, and `query`.

### 4. Verify channel metadata

```bash
curl -sS "$BASE_URL/api/webhook/channel/$CHANNEL_ID" | jq .
curl -sS "$BASE_URL/api/webhook/channels?ids=$CHANNEL_ID" | jq .
curl -sS "$BASE_URL/api/webhook/stats?ids=$CHANNEL_ID" | jq .
```

## SSE Real-Time Testing

### Simple SSE inspection

In one terminal:

```bash
curl -N "$BASE_URL/api/webhook/stream?channelId=$CHANNEL_ID"
```

In another terminal, send a webhook:

```bash
curl -sS -X POST "$WEBHOOK_URL" \
  -H 'content-type: application/json' \
  -d '{"event":"sse.test"}' | jq .
```

Expected SSE blocks include a `connected` event first, then `webhook` events:

```text
event: connected
data: {"clientId":"sse_...", ...}

event: webhook
data: {"id":"evt_...", ...}
```

### Proper SSE lifecycle

If writing a custom SSE client:

1. Connect to `/api/webhook/stream?channelId=<id>`.
2. Read `clientId` from the `connected` event.
3. Every ~20 seconds, send `POST /api/webhook/sse-ping` with `{ "clientId": "..." }`.
4. On shutdown, send `POST /api/webhook/sse-cancel` with `{ "clientId": "..." }`.

The service removes stale clients after ~90 seconds even if cancel is missed.

## Testing Different Payload Types

### JSON

```bash
curl -sS -X POST "$WEBHOOK_URL" \
  -H 'content-type: application/json' \
  -d '{"type":"json","value":123}' | jq .
```

### Plain text

```bash
curl -sS -X POST "$WEBHOOK_URL" \
  -H 'content-type: text/plain' \
  --data-binary 'hello from text webhook' | jq .
```

### XML

```bash
curl -sS -X POST "$WEBHOOK_URL" \
  -H 'content-type: application/xml' \
  --data-binary '<event><type>xml</type></event>' | jq .
```

### Form URL Encoded

```bash
curl -sS -X POST "$WEBHOOK_URL" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data 'type=form&ok=true' | jq .
```

### Different HTTP Methods

```bash
curl -sS -X PUT "$WEBHOOK_URL?method=put" -d 'put-body' | jq .
curl -sS -X PATCH "$WEBHOOK_URL?method=patch" -d 'patch-body' | jq .
curl -sS -X DELETE "$WEBHOOK_URL?method=delete" | jq .
curl -sS "$WEBHOOK_URL?method=get" | jq .
```

## Forward Webhooks to a Local Service

If the project CLI is available, use it to listen to a channel and replay each received event to a local URL. The CLI default base URL is already `https://webhook.kinori.me`.

```bash
webhook-proxy listen --channel "$CHANNEL_ID" --target http://localhost:3000/webhook --verbose
```

Equivalent with explicit base:

```bash
webhook-proxy listen \
  --channel "$CHANNEL_ID" \
  --target http://127.0.0.1:8787/hooks/github \
  --base https://webhook.kinori.me \
  --verbose
```

Useful options:

- `--no-query` — do not append original webhook query params to the target URL.
- `--no-headers` — do not forward original request headers.
- `--verbose` — print detailed logs.

The forwarder preserves the original HTTP method, body, query params, and most original headers. It skips hop-by-hop/proxy headers and adds metadata headers:

- `x-webhook-proxy-event-id`
- `x-webhook-proxy-channel-id`
- `x-webhook-proxy-channel-label`
- `x-webhook-proxy-replayed: true`

## One-Shot End-to-End Script

Use this when you need a fast smoke test without manually copying IDs:

```bash
set -euo pipefail
BASE_URL="https://webhook.kinori.me"
LABEL="smoke-$(date +%s)"

REGISTER_JSON=$(curl -sS -X POST "$BASE_URL/api/webhook/register" \
  -H 'content-type: application/json' \
  -d "{\"label\":\"$LABEL\"}")
CHANNEL_ID=$(printf '%s' "$REGISTER_JSON" | jq -r '.channel.id')
CHANNEL_TOKEN=$(printf '%s' "$REGISTER_JSON" | jq -r '.channel.token')
WEBHOOK_URL=$(printf '%s' "$REGISTER_JSON" | jq -r '.webhookUrl')

curl -sS -X POST "$WEBHOOK_URL?source=smoke" \
  -H 'content-type: application/json' \
  -H 'x-smoke-test: true' \
  -d '{"event":"smoke.test","ok":true}' | jq .

curl -sS "$BASE_URL/api/webhook/history?token=$CHANNEL_TOKEN&limit=1" | jq .
printf 'Created channel: %s\nWebhook URL: %s\n' "$CHANNEL_ID" "$WEBHOOK_URL"
```

## Verification Checklist

- [ ] Registration returns HTTP `201` with `channel.id`, `channel.token`, and `webhookUrl`.
- [ ] Sending to `webhookUrl` returns `{ "received": true, "id": "evt_..." }`.
- [ ] History for the channel contains the event with expected `body`, `headers`, and `query`.
- [ ] SSE stream emits a `webhook` event for new requests.
- [ ] If forwarding locally, the local service receives the original method/body and `x-webhook-proxy-*` headers.
- [ ] Stats/channel lookup only include channel details when called with explicit IDs.

## Common Pitfalls

1. **Forgetting channel isolation.** `/channels` without `ids` intentionally returns an empty list, and `/stats` without `ids` hides the channel list. Keep the `CHANNEL_ID` from registration.
2. **Leaking tokens.** `webhookUrl` contains the channel token. Do not paste it into public logs or shared issues unless it is disposable.
3. **Expecting all channels from stats.** `GET /api/webhook/stats` reports counts but does not list all channels unless `ids` is provided.
4. **Leaving raw curl SSE clients open.** `curl -N` does not send ping/cancel lifecycle calls. Close it after testing; stale cleanup runs automatically after roughly 90 seconds.
5. **Assuming header redaction.** Headers are stored as received so local replay works. Do not send real secrets unless the channel is disposable and the test requires it.
6. **Missing `jq`.** If `jq` is unavailable, save the registration JSON and parse manually or with Python.
