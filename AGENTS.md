# webhook-proxy — Cloudflare Worker + Vite SPA

This project runs on **Cloudflare Workers** (Hono framework) with a **Vite + React** dashboard SPA. It is NOT a Next.js project.

## Architecture

- **Worker backend**: Hono HTTP framework on Cloudflare Workers
- **Storage**: Cloudflare KV (channels & events) + Durable Objects (SSE connections)
- **Dashboard**: Vite + React SWC + Tailwind CSS v4, built as static SPA
- **Deployment**: `wrangler deploy` to Cloudflare, static assets from `dist/client/`

## Self-Deployment

See [README.md](./README.md) for full deployment instructions. Quick steps:

1. `cp wrangler.toml.example wrangler.toml` — fill in your KV namespace ID and domain
2. `pnpm install && pnpm build:client`
3. `wrangler deploy`

**Note**: `wrangler.toml` is gitignored because it contains account-specific KV namespace IDs.

## Key Files

| Path | Purpose |
|------|---------|
| `src/index.ts` | Hono app — all API routes + Worker entry |
| `src/kv-store.ts` | KV-backed channel & event store |
| `src/sse-do.ts` | SSEManager Durable Object (alarm + cleanup) |
| `src/shared/types.ts` | Shared type definitions (WebhookChannel, WebhookEvent, Env) |
| `client/src/App.tsx` | Dashboard SPA main component |
| `client/src/types.ts` | Client-side type definitions |
| `client/src/main.tsx` | React entry point |
| `client/src/globals.css` | Tailwind v4 base styles |
| `vite.config.ts` | Vite config: React SWC + Tailwind v4, output `dist/client/` |
| `wrangler.toml.example` | Worker config template (copy to wrangler.toml) |
| `tsconfig.worker.json` | Worker TypeScript config (ES2022 + Cloudflare types) |
| `tsconfig.client.json` | Client TypeScript config (DOM + ESNext) |

## Commands

```bash
pnpm dev              # Start wrangler dev (Worker on port 8787)
pnpm dev:client       # Start Vite dev server (SPA on port 3001)
pnpm dev:full         # Both Worker + Vite dev concurrently
pnpm build:client     # Build SPA to dist/client/
pnpm build:worker     # Type-check Worker code (no emit)
pnpm type-check       # Type-check both Worker + Client
pnpm lint             # Biome check
pnpm format           # Biome format --write
pnpm build            # Build SPA + deploy Worker
```

## API Routes

All routes under `/api/webhook/`:

- `POST /register` — Register channel, returns webhook URL with random token
- `GET /channels?ids=id1,id2` — List channels by IDs (empty without ids)
- `GET /channel/:id` — Get single channel by ID (for manual add)
- `ALL /in/:token` — Receive webhook (any HTTP method), 404 for invalid token
- `GET /stream` — SSE endpoint, optional `?channelId=` filter
- `POST /sse-ping` — Client heartbeat ping (proves SSE client is alive)
- `POST /sse-cancel` — Explicit client disconnect
- `GET /history` — Query events, params: channelId, since, until, limit, offset
- `GET /stats` — Aggregate stats (store + SSE + channels)

## KV Key Patterns

| Key Pattern | Value | Purpose |
|-------------|-------|---------|
| `channel:{token}` | JSON WebhookChannel | Store channel by token |
| `channel_id:{channelId}` | string (token) | Lookup token by channel ID |
| `channel_list` | JSON string[] | List of all channel IDs |
| `events:{channelId}` | JSON WebhookEvent[] | Events for a channel (max 500) |
| `event_counter:{channelId}` | counter string | Event counter per channel |

## Constraints

- Max 100 channels, max 500 events per channel
- Sensitive headers (authorization, cookie, x-api-key, x-token, x-talesofai-api-key) → `[REDACTED]`
- SSE alarm-based cleanup every 30s, 90s stale timeout
- Channel isolation: users only see channels they created or manually added (localStorage)
- Free plan requires `new_sqlite_classes` for Durable Objects

## Domain

- Custom domain: configured in `wrangler.toml` `routes`
- Workers.dev fallback: `your-worker-name.your-subdomain.workers.dev`