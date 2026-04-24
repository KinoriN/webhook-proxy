# 🪝 webhook-proxy

A lightweight webhook debugging proxy that receives webhook requests from external services, stores them, and provides real-time event streaming via SSE. Built on **Cloudflare Workers** with **KV** storage and **Durable Objects** for SSE.

**[Live Demo](https://webhook.kinori.me)** · **[GitHub](https://github.com/KinoriN/webhook-proxy)**

## Features

- 🪝 Register webhook channels with unique tokens
- 📡 Real-time event streaming via Server-Sent Events (SSE)
- 💾 Persistent storage with Cloudflare KV
- 🔒 Channel isolation — each browser only sees its own channels
- 🛡️ Automatic redaction of sensitive headers (Authorization, Cookie, API keys)
- 📊 Dashboard SPA with dark theme for monitoring webhook events
- 🧪 One-click test webhook from the dashboard
- 🔗 Add existing channels by ID across devices
- ⚡ Zero cold-start overhead on Cloudflare's edge network

## Architecture

```
External Services ──POST──▶ Cloudflare Worker (Hono)
                                │
                    ┌───────────┤
                    ▼           ▼
              KV Storage    Durable Object
              (channels,     (SSE Manager,
               events)       alarm cleanup)
                                │
                                ▼
                            ┌─────────────────────┐
                            │  Dashboard Browser  │
                            │  (Vite + React)     │
                            │  SSE event stream   │
                            └─────────────────────┘
```

## Self-Deployment

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ & [pnpm](https://pnpm.io/)
- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed & logged in

### Steps

1. **Clone & install**

   ```bash
   git clone https://github.com/KinoriN/webhook-proxy.git
   cd webhook-proxy
   pnpm install
   ```

2. **Create KV namespace**

   ```bash
   wrangler kv namespace create WEBHOOK_PROXY_KV
   ```

   This outputs a namespace ID. Copy it.

3. **Configure wrangler**

   ```bash
   cp wrangler.toml.example wrangler.toml
   ```

   Edit `wrangler.toml` and fill in:
   - `id` under `[[kv_namespaces]]` — paste the KV namespace ID from step 2
   - `pattern` under `routes` — your custom domain (e.g., `webhook.example.com`), or remove the `routes` section entirely to use `*.workers.dev` only

4. **Build & deploy**

   ```bash
   pnpm build:client    # Build the dashboard SPA
   wrangler deploy      # Deploy Worker + assets to Cloudflare
   ```

5. **Configure DNS** (if using custom domain)

   In your Cloudflare Dashboard → DNS → Records:
   - Add a **CNAME** record: `webhook` → `your-worker-name.your-subdomain.workers.dev`
   - Enable **Proxied** (orange cloud ☁️)

   The custom domain should match the `pattern` in `wrangler.toml`.

6. **Done!** 🎉

   Visit your domain or `https://your-worker-name.your-subdomain.workers.dev` to use the dashboard.

### Local Development

```bash
# Start Worker on port 8787
pnpm dev

# Or start Worker + Vite dev server concurrently
pnpm dev:full
```

- Worker API: `http://localhost:8787/api/webhook/`
- Dashboard SPA: `http://localhost:3001` (proxies `/api` to Worker)

## API Reference

### Register a Channel

```bash
curl -X POST https://your-domain/api/webhook/register \
  -H "Content-Type: application/json" \
  -d '{"label":"github-push"}'
```

### Send a Webhook

```bash
curl -X POST https://your-domain/api/webhook/in/{token} \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer secret" \
  -d '{"action":"pushed","ref":"refs/heads/main"}'
```

> Sensitive headers (`Authorization`, `Cookie`, `X-API-Key`, etc.) are automatically redacted to `[REDACTED]`.

### List Channels (by ID)

```bash
# Returns empty without IDs (channel isolation)
curl https://your-domain/api/webhook/channels

# List specific channels
curl "https://your-domain/api/webhook/channels?ids=ch_xxx,ch_yyy"
```

### Get Single Channel

```bash
curl https://your-domain/api/webhook/channel/ch_xxx
```

### Event History

```bash
curl "https://your-domain/api/webhook/history?channelId=ch_xxx&limit=50"
```

### SSE Stream

```bash
curl -N "https://your-domain/api/webhook/stream?channelId=ch_xxx"
```

### Stats

```bash
curl "https://your-domain/api/webhook/stats?ids=ch_xxx"
```

## API Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/webhook/register` | Register a new channel |
| `GET` | `/api/webhook/channels?ids=` | List channels by IDs |
| `GET` | `/api/webhook/channel/:id` | Get single channel |
| `ALL` | `/api/webhook/in/:token` | Receive webhook |
| `GET` | `/api/webhook/stream` | SSE event stream |
| `POST` | `/api/webhook/sse-ping` | Client heartbeat ping |
| `POST` | `/api/webhook/sse-cancel` | Client disconnect |
| `GET` | `/api/webhook/history` | Query event history |
| `GET` | `/api/webhook/stats` | Aggregate statistics |

## Project Structure

```
webhook-proxy/
├── src/                    # Cloudflare Worker source
│   ├── index.ts            # Hono app — all API routes + Worker entry
│   ├── kv-store.ts         # KV-backed channel & event store
│   ├── sse-do.ts           # SSEManager Durable Object (alarm + cleanup)
│   └── shared/types.ts     # Shared type definitions
├── client/                 # Dashboard SPA (Vite + React)
│   ├── index.html          # SPA HTML entry
│   └── src/
│       ├── App.tsx         # Main dashboard component
│       ├── main.tsx        # React entry point
│       ├── globals.css     # Tailwind v4 base styles
│       └── types.ts        # Client-side type definitions
├── wrangler.toml.example   # Worker config template (copy to wrangler.toml)
├── vite.config.ts          # Vite config for SPA build
├── biome.json              # Linter & formatter config
├── AGENTS.md               # Development guide for AI agents
└── README.md               # This file
```

## Limits

- **Max channels**: 100 (oldest auto-evicted when exceeded)
- **Max events per channel**: 500 (oldest auto-evicted)
- **Sensitive headers**: `authorization`, `cookie`, `x-api-key`, `x-token`, `x-talesofai-api-key`
- **Channel isolation**: `/channels` requires `ids` param; users only see channels they own or added (localStorage)
- **SSE client cleanup**: alarm-based cleanup every 30s, 90s stale timeout

## Development

```bash
pnpm dev              # Start wrangler dev (Worker on port 8787)
pnpm dev:client       # Start Vite dev server (SPA on port 3001)
pnpm dev:full         # Both Worker + Vite dev concurrently
pnpm build:client     # Build SPA to dist/client/
pnpm build:worker     # Type-check Worker code
pnpm type-check       # Type-check both Worker + Client
pnpm lint             # Biome check
pnpm format           # Biome format --write
pnpm build            # Build SPA + deploy Worker
```

## License

[MIT](./LICENSE) © [KinoriN](https://github.com/KinoriN)