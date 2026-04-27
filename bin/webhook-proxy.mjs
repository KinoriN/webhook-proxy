#!/usr/bin/env node

/**
 * webhook-proxy CLI
 *
 * Listen to a channel's SSE stream and forward received webhook events to a local URL.
 * No external dependencies; requires Node.js 18+ for global fetch.
 */

const VERSION = "0.1.0";

const DEFAULT_BASE_URL = "https://webhook.kinori.me";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cdn-loop",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]);

function printHelp() {
  console.log(`webhook-proxy CLI v${VERSION}

Listen to webhook-proxy SSE events and forward them to a local service.

Usage:
  webhook-proxy listen --channel <channelId> --target <localUrl> [options]

Options:
  -c, --channel <id>       Channel ID to listen to (required)
  -t, --target <url>       Local target URL to forward requests to (required)
  -b, --base <url>         webhook-proxy base URL (default: ${DEFAULT_BASE_URL})
  --no-query               Do not append original query params to the target URL
  --no-headers             Do not forward original request headers
  --verbose                Print detailed logs
  -h, --help               Show help
  -v, --version            Show version

Examples:
  webhook-proxy listen --channel ch_123 --target http://localhost:3000/webhook
  webhook-proxy listen -c ch_123 -t http://127.0.0.1:8787/hooks/github --base https://webhook.example.com
`);
}

function parseArgs(argv) {
  const args = {
    command: "listen",
    base: DEFAULT_BASE_URL,
    channel: "",
    target: "",
    query: true,
    headers: true,
    verbose: false,
  };

  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) {
    args.command = rest.shift();
  }

  while (rest.length > 0) {
    const arg = rest.shift();
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      case "-c":
      case "--channel":
        args.channel = rest.shift() ?? "";
        break;
      case "-t":
      case "--target":
        args.target = rest.shift() ?? "";
        break;
      case "-b":
      case "--base":
        args.base = rest.shift() ?? DEFAULT_BASE_URL;
        break;
      case "--no-query":
        args.query = false;
        break;
      case "--no-headers":
        args.headers = false;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function assertUrl(value, label) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL: ${value}`);
  }
}

function buildTargetUrl(targetUrl, query, includeQuery) {
  const url = new URL(targetUrl.toString());
  if (includeQuery && query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function buildForwardHeaders(event, includeHeaders) {
  const headers = new Headers();

  if (includeHeaders && event.headers && typeof event.headers === "object") {
    for (const [key, value] of Object.entries(event.headers)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower)) continue;
      headers.set(key, String(value));
    }
  }

  headers.set("x-webhook-proxy-event-id", event.id ?? "");
  headers.set("x-webhook-proxy-channel-id", event.channelId ?? "");
  headers.set("x-webhook-proxy-channel-label", event.channelLabel ?? "");
  headers.set("x-webhook-proxy-replayed", "true");

  return headers;
}

function buildBody(event, headers) {
  const method = String(event.method ?? "POST").toUpperCase();
  if (["GET", "HEAD"].includes(method)) return undefined;

  const body = event.body;
  if (body === null || body === undefined) return undefined;

  if (typeof body === "string") {
    return body;
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return JSON.stringify(body);
}

async function forwardEvent(event, targetUrl, options) {
  const url = buildTargetUrl(targetUrl, event.query, options.query);
  const headers = buildForwardHeaders(event, options.headers);
  const method = String(event.method ?? "POST").toUpperCase();
  const body = buildBody(event, headers);

  const startedAt = Date.now();
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: "manual",
  });
  const elapsed = Date.now() - startedAt;

  return {
    status: response.status,
    statusText: response.statusText,
    elapsed,
    url: url.toString(),
  };
}

function parseSseChunk(buffer, onEvent) {
  const blocks = buffer.split("\n\n");
  const remaining = blocks.pop() ?? "";

  for (const block of blocks) {
    let event = "message";
    const dataLines = [];

    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const idx = line.indexOf(":");
      const field = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");

      if (field === "event") event = value;
      if (field === "data") dataLines.push(value);
    }

    if (dataLines.length > 0) {
      onEvent({ event, data: dataLines.join("\n") });
    }
  }

  return remaining;
}

async function postLifecycle(baseUrl, path, clientId) {
  if (!clientId) return;
  try {
    await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId }),
    });
  } catch {
    // best-effort lifecycle call
  }
}

async function listen(args) {
  if (!args.channel) throw new Error("--channel is required");
  if (!args.target) throw new Error("--target is required");

  const baseUrl = assertUrl(args.base, "--base");
  const targetUrl = assertUrl(args.target, "--target");
  const streamUrl = new URL("/api/webhook/stream", baseUrl);
  streamUrl.searchParams.set("channelId", args.channel);

  const abortController = new AbortController();
  let clientId = null;
  let pingTimer = null;
  let stopping = false;

  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    abortController.abort();
    if (pingTimer) clearInterval(pingTimer);
    await postLifecycle(baseUrl, "/api/webhook/sse-cancel", clientId);
  };

  process.once("SIGINT", async () => {
    console.log("\n[webhook-proxy] stopping...");
    await cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  console.log(`[webhook-proxy] listening: ${streamUrl.toString()}`);
  console.log(`[webhook-proxy] forwarding to: ${targetUrl.toString()}`);

  const response = await fetch(streamUrl, {
    headers: { accept: "text/event-stream" },
    signal: abortController.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = parseSseChunk(buffer, async ({ event, data }) => {
      if (event === "connected") {
        try {
          const payload = JSON.parse(data);
          clientId = payload.clientId ?? null;
          console.log(`[webhook-proxy] connected (clientId=${clientId ?? "unknown"})`);
          if (clientId && !pingTimer) {
            pingTimer = setInterval(() => {
              postLifecycle(baseUrl, "/api/webhook/sse-ping", clientId);
            }, 20_000);
          }
        } catch {
          console.log("[webhook-proxy] connected");
        }
        return;
      }

      if (event !== "webhook") {
        if (args.verbose) console.log(`[webhook-proxy] ignored SSE event: ${event}`);
        return;
      }

      try {
        const webhookEvent = JSON.parse(data);
        const result = await forwardEvent(webhookEvent, targetUrl, args);
        console.log(
          `[webhook-proxy] ${webhookEvent.method} ${webhookEvent.id} -> ${result.status} ${result.statusText} (${result.elapsed}ms)`,
        );
        if (args.verbose) console.log(`  ${result.url}`);
      } catch (error) {
        console.error(`[webhook-proxy] forward failed: ${error.message}`);
      }
    });
  }
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return printHelp();
    if (args.version) return console.log(VERSION);
    if (args.command !== "listen") {
      throw new Error(`Unknown command: ${args.command}`);
    }
    await listen(args);
  } catch (error) {
    console.error(`[webhook-proxy] ${error.message}`);
    console.error("Run `webhook-proxy --help` for usage.");
    process.exit(1);
  }
}

main();
