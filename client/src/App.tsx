// biome-ignore lint/correctness/noUnusedImports: React is used for JSX
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Stats, WebhookChannel, WebhookEvent } from "./types";

const LOCAL_STORAGE_KEY = "webhook-proxy-channels";

function loadLocalChannels(): WebhookChannel[] {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalChannels(channels: WebhookChannel[]) {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(channels));
}

export default function App() {
  const [localChannels, setLocalChannels] =
    useState<WebhookChannel[]>(loadLocalChannels);
  const [channels, setChannels] = useState<WebhookChannel[]>([]);
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [connected, setConnected] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<WebhookEvent | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<WebhookChannel | null>(
    null,
  );
  const [newChannelLabel, setNewChannelLabel] = useState("");
  const [addChannelId, setAddChannelId] = useState("");
  const [addChannelError, setAddChannelError] = useState("");
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [showAddChannel, setShowAddChannel] = useState(false);
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const sseClientIdRef = useRef<string | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const localChannelsRef = useRef<WebhookChannel[]>(localChannels);
  localChannelsRef.current = localChannels;

  // Sync local channels → fetch fresh data from server by IDs
  useEffect(() => {
    if (localChannels.length === 0) {
      setChannels([]);
      setSelectedChannel(null);
      return;
    }
    const ids = localChannels.map((ch) => ch.id).join(",");
    fetch(`/api/webhook/channels?ids=${ids}`)
      .then((r) => r.json())
      .then((data) => {
        const fresh: WebhookChannel[] = data.channels ?? [];
        setChannels(fresh);
        // Auto-select first if none selected
        if (fresh.length > 0 && !selectedChannel) {
          setSelectedChannel(fresh[0]);
        }
        // Update local storage with fresh data (server may have updated eventCount etc.)
        saveLocalChannels(fresh);
      })
      .catch(() => {
        // Fallback: use local data if server unreachable
        setChannels(localChannels);
        if (localChannels.length > 0 && !selectedChannel) {
          setSelectedChannel(localChannels[0]);
        }
      });
  }, [localChannels, selectedChannel]);

  // Load history events
  useEffect(() => {
    if (!selectedChannel) {
      setEvents([]);
      return;
    }
    fetch(`/api/webhook/history?channelId=${selectedChannel.id}&limit=100`)
      .then((r) => r.json())
      .then((data) => setEvents(data.events ?? []))
      .catch(() => setEvents([]));
  }, [selectedChannel]);

  // Load stats scoped to user's channels
  useEffect(() => {
    if (localChannels.length === 0) {
      fetch("/api/webhook/stats")
        .then((r) => r.json())
        .then((data) => setStats(data))
        .catch(() => {});
      return;
    }
    const ids = localChannels.map((ch) => ch.id).join(",");
    fetch(`/api/webhook/stats?ids=${ids}`)
      .then((r) => r.json())
      .then((data) => setStats(data))
      .catch(() => {});
  }, [localChannels]);

  // SSE real-time connection
  useEffect(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const params = selectedChannel ? `?channelId=${selectedChannel.id}` : "";
    const es = new EventSource(`/api/webhook/stream${params}`);
    esRef.current = es;

    es.addEventListener("connected", (e) => {
      setConnected(true);
      try {
        const data = JSON.parse(e.data);
        if (data.clientId) {
          sseClientIdRef.current = data.clientId;
        }
      } catch {
        // ignore
      }
    });

    es.addEventListener("webhook", (e) => {
      const event: WebhookEvent = JSON.parse(e.data);
      if (!selectedChannel || event.channelId === selectedChannel.id) {
        setEvents((prev) => [event, ...prev]);
      }
      // Refresh stats
      const ids = localChannelsRef.current.map((ch) => ch.id).join(",");
      fetch(`/api/webhook/stats?ids=${ids}`)
        .then((r) => r.json())
        .then((data) => setStats(data))
        .catch(() => {});
      // Refresh channel data if event belongs to one of our channels
      if (localChannelsRef.current.some((ch) => ch.id === event.channelId)) {
        fetch(`/api/webhook/channels?ids=${ids}`)
          .then((r) => r.json())
          .then((data) => {
            const fresh = data.channels ?? [];
            setChannels(fresh);
            saveLocalChannels(fresh);
            // Keep selectedChannel synced
            if (selectedChannel) {
              const updated = fresh.find(
                (ch: WebhookChannel) => ch.id === selectedChannel.id,
              );
              if (updated) setSelectedChannel(updated);
            }
          })
          .catch(() => {});
      }
    });

    es.addEventListener("heartbeat", () => {});
    es.addEventListener("disconnect", () => setConnected(false));
    es.onerror = () => setConnected(false);

    // Periodic ping to prove client is alive (DO uses this for stale detection)
    if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    pingIntervalRef.current = setInterval(() => {
      const clientId = sseClientIdRef.current;
      if (clientId) {
        fetch("/api/webhook/sse-ping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId }),
        }).catch(() => {});
      }
    }, 20_000); // ping every 20s

    // Clean up on unmount or channel switch
    return () => {
      // Send explicit cancel to DO
      const clientId = sseClientIdRef.current;
      if (clientId) {
        fetch("/api/webhook/sse-cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId }),
        }).catch(() => {});
        sseClientIdRef.current = null;
      }
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [selectedChannel]);

  // Clean up SSE on page unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  const registerChannel = async () => {
    const res = await fetch("/api/webhook/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: newChannelLabel || undefined }),
    });
    const data = await res.json();
    setNewChannelLabel("");

    // Save new channel to localStorage
    const newCh: WebhookChannel = data.channel;
    const updated = [...localChannels, newCh];
    setLocalChannels(updated);
    saveLocalChannels(updated);
    setSelectedChannel(newCh);
  };

  const addExistingChannel = async () => {
    setAddChannelError("");
    const id = addChannelId.trim();
    if (!id) {
      setAddChannelError("请输入频道 ID");
      return;
    }
    // Check if already added
    if (localChannels.some((ch: WebhookChannel) => ch.id === id)) {
      setAddChannelError("该频道已在你的列表中");
      return;
    }

    const res = await fetch(`/api/webhook/channel/${id}`);
    if (!res.ok) {
      setAddChannelError("频道不存在或 ID 无效");
      return;
    }
    const data = await res.json();
    const ch: WebhookChannel = data.channel;

    const updated = [...localChannels, ch];
    setLocalChannels(updated);
    saveLocalChannels(updated);
    setAddChannelId("");
    setShowAddChannel(false);
    setSelectedChannel(ch);
  };

  const removeLocalChannel = (channelId: string) => {
    const updated = localChannels.filter(
      (ch: WebhookChannel) => ch.id !== channelId,
    );
    setLocalChannels(updated);
    saveLocalChannels(updated);
    if (selectedChannel?.id === channelId) {
      setSelectedChannel(updated.length > 0 ? updated[0] : null);
    }
  };

  const copyToClipboard = (text: string, token: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    });
  };

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  const formatBody = useCallback((body: unknown) => {
    if (body === null || body === undefined) return "—";
    try {
      return JSON.stringify(body, null, 2);
    } catch {
      return String(body);
    }
  }, []);

  const channelColorMap: Record<string, string> = {};
  const getChannelColor = (label: string) => {
    if (!channelColorMap[label]) {
      const colors = [
        "bg-purple-500/20 text-purple-300 border-purple-500/30",
        "bg-blue-500/20 text-blue-300 border-blue-500/30",
        "bg-green-500/20 text-green-300 border-green-500/30",
        "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
        "bg-orange-500/20 text-orange-300 border-orange-500/30",
        "bg-pink-500/20 text-pink-300 border-pink-500/30",
        "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
        "bg-red-500/20 text-red-300 border-red-500/30",
      ];
      channelColorMap[label] =
        colors[Object.keys(channelColorMap).length % colors.length];
    }
    return channelColorMap[label];
  };

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight">🪝 Webhook Proxy</h1>
          <span className="text-sm text-zinc-400">
            Agent-ready webhook relay
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${connected ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}
          >
            <span
              className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-green-400 animate-pulse" : "bg-red-400"}`}
            />
            {connected ? "SSE Connected" : "Disconnected"}
          </div>
          {stats && (
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span>{stats.store.totalEvents} events</span>
              <span>•</span>
              <span>{channels.length} my channels</span>
              <span>•</span>
              <span>{stats.sse.connectedClients} SSE clients</span>
            </div>
          )}
          <a
            href="https://github.com/KinoriN/webhook-proxy"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
          >
            <svg
              viewBox="0 0 16 16"
              className="w-3.5 h-3.5 fill-current"
              aria-hidden="true"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            GitHub
          </a>
        </div>
      </header>

      {/* API Endpoints Info */}
      <section className="px-6 py-3 border-b border-zinc-800 bg-zinc-900/50">
        <div className="flex flex-wrap gap-3">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/80 text-xs">
            <span className="text-yellow-400 font-mono">POST</span>
            <span className="font-mono text-zinc-300">
              /api/webhook/register
            </span>
            <span className="text-zinc-500">— 注册新 channel</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/80 text-xs">
            <span className="text-green-400 font-mono">POST</span>
            <span className="font-mono text-zinc-300">
              /api/webhook/in/{`{token}`}
            </span>
            <span className="text-zinc-500">— 接收 webhook</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/80 text-xs">
            <span className="text-blue-400 font-mono">GET</span>
            <span className="font-mono text-zinc-300">/api/webhook/stream</span>
            <span className="text-zinc-500">— SSE 实时推送</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/80 text-xs">
            <span className="text-blue-400 font-mono">GET</span>
            <span className="font-mono text-zinc-300">
              /api/webhook/channel/{`{id}`}
            </span>
            <span className="text-zinc-500">— 查询频道</span>
          </div>
        </div>
      </section>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar: Channel Management */}
        <aside className="w-[280px] border-r border-zinc-800 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-300 mb-3">
              📡 My Channels
            </h2>
            <div className="flex gap-2">
              <input
                type="text"
                value={newChannelLabel}
                onChange={(e) => setNewChannelLabel(e.target.value)}
                placeholder="Channel label (e.g. github)"
                className="flex-1 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
              />
              <button
                type="button"
                onClick={registerChannel}
                className="px-3 py-2 rounded-lg bg-green-500/20 text-green-400 text-sm font-medium hover:bg-green-500/30 transition-colors"
              >
                + New
              </button>
            </div>
          </div>

          {/* Channel list */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {channels.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-2 py-8">
                <span className="text-2xl">📡</span>
                <p className="text-xs text-center">
                  No channels yet.
                  <br />
                  Register one or add an existing channel!
                </p>
              </div>
            ) : (
              channels.map((ch) => (
                <button
                  type="button"
                  key={ch.id}
                  onClick={() => setSelectedChannel(ch)}
                  className={`w-full flex flex-col gap-1 px-3 py-2.5 rounded-lg border text-left transition-colors ${selectedChannel?.id === ch.id ? "bg-zinc-800 border-zinc-600" : "bg-zinc-900/50 border-zinc-800 hover:bg-zinc-800/80"}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-xs font-medium border ${getChannelColor(ch.label)}`}
                      >
                        {ch.label}
                      </span>
                      <span className="text-xs text-zinc-600 font-mono">
                        {ch.id.slice(0, 12)}…
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeLocalChannel(ch.id);
                      }}
                      className="text-xs px-1 py-0.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <span>{ch.eventCount} events</span>
                    {ch.lastEventAt && (
                      <span>• Last: {formatTime(ch.lastEventAt)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    <code className="text-xs font-mono text-zinc-400 truncate flex-1">
                      /api/webhook/in/{ch.token}
                    </code>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        copyToClipboard(
                          `${window.location.origin}/api/webhook/in/${ch.token}`,
                          ch.token,
                        );
                      }}
                      className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
                    >
                      {copiedToken === ch.token ? "✓" : "📋"}
                    </button>
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Add existing channel */}
          <div className="p-3 border-t border-zinc-800">
            {showAddChannel ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={addChannelId}
                  onChange={(e) => {
                    setAddChannelId(e.target.value);
                    setAddChannelError("");
                  }}
                  placeholder="输入频道 ID (如 ch_1234_abc)"
                  className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
                />
                {addChannelError && (
                  <p className="text-xs text-red-400">{addChannelError}</p>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={addExistingChannel}
                    className="flex-1 px-3 py-2 rounded-lg bg-blue-500/20 text-blue-400 text-sm font-medium hover:bg-blue-500/30 transition-colors"
                  >
                    添加
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddChannel(false);
                      setAddChannelId("");
                      setAddChannelError("");
                    }}
                    className="px-3 py-2 rounded-lg bg-zinc-800 text-zinc-400 text-sm hover:bg-zinc-700 transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowAddChannel(true)}
                className="w-full px-3 py-2 rounded-lg bg-zinc-800 text-xs text-zinc-400 hover:text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                🔗 Add existing channel
              </button>
            )}
          </div>
        </aside>

        {/* Events List */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedChannel && (
            <div className="px-6 py-2 border-b border-zinc-800 bg-zinc-900/30 flex items-center gap-3">
              <span
                className={`px-2 py-0.5 rounded-md text-xs font-medium border ${getChannelColor(selectedChannel.label)}`}
              >
                {selectedChannel.label}
              </span>
              <span className="text-xs text-zinc-500 font-mono">
                id: {selectedChannel.id}
              </span>
              <span className="text-xs text-zinc-500">Webhook URL:</span>
              <code className="text-xs font-mono text-green-400/80 bg-zinc-800 px-2 py-0.5 rounded">
                {window.location.origin}/api/webhook/in/{selectedChannel.token}
              </code>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {events.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-3">
                <span className="text-4xl">🔮</span>
                <p className="text-lg">Waiting for webhook events...</p>
                <p className="text-sm">
                  {channels.length === 0
                    ? "Register a channel first, then send webhooks to the generated URL"
                    : `Send a webhook to POST /api/webhook/in/${selectedChannel?.token ?? "{token}"}`}
                </p>
                {selectedChannel && (
                  <button
                    type="button"
                    onClick={async () => {
                      await fetch(`/api/webhook/in/${selectedChannel.token}`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          hello: "world",
                          timestamp: Date.now(),
                          channel: selectedChannel.label,
                        }),
                      });
                    }}
                    className="px-4 py-2 rounded-lg bg-green-500/20 text-green-400 text-sm font-medium hover:bg-green-500/30 transition-colors"
                  >
                    🧪 Send Test Webhook
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {events.map((event) => (
                  <button
                    type="button"
                    key={event.id}
                    onClick={() => setSelectedEvent(event)}
                    className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors text-left ${selectedEvent?.id === event.id ? "bg-zinc-800 border-zinc-600" : "bg-zinc-900/50 border-zinc-800 hover:bg-zinc-800/80 hover:border-zinc-700"}`}
                  >
                    <span
                      className={`px-2 py-0.5 rounded-md text-xs font-medium border ${getChannelColor(event.channelLabel)}`}
                    >
                      {event.channelLabel}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-xs font-mono ${event.method === "POST" ? "text-green-400" : event.method === "PUT" ? "text-yellow-400" : event.method === "DELETE" ? "text-red-400" : "text-blue-400"}`}
                    >
                      {event.method}
                    </span>
                    <span className="text-xs text-zinc-500 font-mono">
                      {formatTime(event.timestamp)}
                    </span>
                    <span className="text-sm text-zinc-400 truncate flex-1 max-w-md">
                      {formatBody(event.body).slice(0, 80)}
                    </span>
                    <span className="text-xs text-zinc-600 font-mono">
                      {event.id}
                    </span>
                  </button>
                ))}
                <div ref={eventsEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* Detail Panel */}
        {selectedEvent && (
          <div className="w-[480px] border-l border-zinc-800 overflow-y-auto p-6 bg-zinc-900/30">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-zinc-300">
                Event Detail
              </h2>
              <button
                type="button"
                onClick={() => setSelectedEvent(null)}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                ✕ Close
              </button>
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2 py-0.5 rounded-md text-xs font-medium border ${getChannelColor(selectedEvent.channelLabel)}`}
                  >
                    {selectedEvent.channelLabel}
                  </span>
                  <span className="text-xs font-mono text-zinc-400">
                    {selectedEvent.method}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {new Date(selectedEvent.timestamp).toLocaleString("zh-CN")}
                  </span>
                </div>
                <div className="text-xs text-zinc-600 font-mono">
                  ID: {selectedEvent.id}
                </div>
                <div className="text-xs text-zinc-600 font-mono">
                  Path: {selectedEvent.path}
                </div>
                <div className="text-xs text-zinc-600 font-mono">
                  Channel token: {selectedEvent.channelToken}
                </div>
              </div>
              <div>
                <h3 className="text-xs font-medium text-zinc-400 mb-1">
                  Headers
                </h3>
                <pre className="p-3 rounded-lg bg-zinc-800/80 text-xs font-mono text-zinc-300 overflow-x-auto max-h-48 overflow-y-auto">
                  {JSON.stringify(selectedEvent.headers, null, 2)}
                </pre>
              </div>
              {Object.keys(selectedEvent.query).length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-zinc-400 mb-1">
                    Query Params
                  </h3>
                  <pre className="p-3 rounded-lg bg-zinc-800/80 text-xs font-mono text-zinc-300 overflow-x-auto">
                    {JSON.stringify(selectedEvent.query, null, 2)}
                  </pre>
                </div>
              )}
              <div>
                <h3 className="text-xs font-medium text-zinc-400 mb-1">Body</h3>
                <pre className="p-3 rounded-lg bg-zinc-800/80 text-xs font-mono text-green-300/80 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all">
                  {formatBody(selectedEvent.body)}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="flex items-center justify-center gap-3 px-6 py-3 border-t border-zinc-800 text-xs text-zinc-500">
        <span>webhook-proxy</span>
        <span>•</span>
        <span>
          by{" "}
          <a
            href="https://github.com/KinoriN"
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            KinoriN
          </a>
        </span>
        <span>•</span>
        <a
          href="https://github.com/KinoriN/webhook-proxy"
          target="_blank"
          rel="noopener noreferrer"
          className="text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Source on GitHub
        </a>
        <span>•</span>
        <span>MIT License</span>
      </footer>
    </div>
  );
}
