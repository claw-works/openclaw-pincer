/**
 * channel.ts — Pincer channel plugin (WebSocket inbound, HTTP outbound)
 * Adapted for Pincer protocol: REGISTER → AUTH → receive envelopes
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";

export interface PincerConfig {
  baseUrl: string;
  token: string;       // api_key
  agentId: string;     // registered agent UUID on Pincer
  agentName: string;   // display name
}

function resolveConfig(cfg: any): PincerConfig {
  return (cfg?.channels?.["openclaw-pincer"] ?? {}) as PincerConfig;
}

function wsUrl(config: PincerConfig): string {
  const base = config.baseUrl.replace(/\/$/, "").replace(/^http/, "ws");
  return `${base}/ws?agent_id=${config.agentId}`;
}

function makeEnvelope(type: string, from: string, to: string, payload: any): string {
  return JSON.stringify({
    id: randomUUID(),
    type,
    from,
    to,
    ts: new Date().toISOString(),
    payload,
  });
}

async function httpPost(config: PincerConfig, path: string, body: any): Promise<void> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/api/v1${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-API-Key": config.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Pincer POST ${path} ${res.status}`);
}

// Fetch project room_ids from /api/v1/projects
async function fetchProjectRooms(config: PincerConfig): Promise<string[]> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/api/v1/projects`;
  try {
    const res = await fetch(url, {
      headers: { "X-API-Key": config.token, "User-Agent": "openclaw-pincer/0.3" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const projects = Array.isArray(data) ? data : [];
    return projects.map((p: any) => p.room_id).filter(Boolean);
  } catch {
    return [];
  }
}

// Subscribe to a single room WebSocket and dispatch messages
function connectRoomWs(params: {
  config: PincerConfig;
  ctx: any;
  roomId: string;
  signal: AbortSignal;
}): void {
  const { config, ctx, roomId, signal } = params;
  let retryMs = 2000;

  function connect() {
    if (signal.aborted) return;
    const wsBase = config.baseUrl.replace(/\/$/, "").replace(/^http/, "ws");
    const ws = new WebSocket(`${wsBase}/api/v1/rooms/${roomId}/ws?api_key=${config.token}`);

    ws.on("open", () => {
      retryMs = 2000;
      console.log(`[openclaw-pincer] Room WS connected: ${roomId}`);
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== "room.message") return;
        const payload = msg.data ?? msg.payload ?? {};
        const sender = payload.sender_agent_id ?? "unknown";
        const content = payload.content ?? "";
        if (sender === config.agentId || !content) return;
        // Mention-only: respond only when @agentName or @all
        const agentName = config.agentName ?? "";
        const isMentioned = agentName && content.includes(`@${agentName}`);
        const isBroadcast = content.includes("@all") || content.includes("@所有人");
        if (!isMentioned && !isBroadcast) return;
        const runtime = ctx.channelRuntime;
        if (!runtime) return;
        dispatchToAgent(config, ctx, runtime, sender, content, roomId);
      } catch { /* ignore */ }
    });

    ws.on("close", () => {
      if (signal.aborted) return;
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 1.5, 30000);
    });

    ws.on("error", () => ws.close());
    signal.addEventListener("abort", () => ws.close(), { once: true });
  }

  connect();
}

// Subscribe to all project rooms, refresh every PROJECT_REFRESH_INTERVAL ms
function startProjectRoomSubscriptions(params: {
  config: PincerConfig;
  ctx: any;
  signal: AbortSignal;
}): void {
  const { config, ctx, signal } = params;
  const PROJECT_REFRESH_MS = 60_000;
  const subscribedRooms = new Set<string>();

  async function refresh() {
    if (signal.aborted) return;
    const rooms = await fetchProjectRooms(config);
    for (const roomId of rooms) {
      if (!subscribedRooms.has(roomId)) {
        subscribedRooms.add(roomId);
        connectRoomWs({ config, ctx, roomId, signal });
        console.log(`[openclaw-pincer] Subscribed to project room: ${roomId}`);
      }
    }
  }

  refresh();
  const timer = setInterval(refresh, PROJECT_REFRESH_MS);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}

function connectWs(params: {
  config: PincerConfig;
  ctx: any;
  signal: AbortSignal;
}) {
  const { config, ctx, signal } = params;
  let retryMs = 1000;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function connect() {
    if (signal.aborted) return;

    const ws = new WebSocket(wsUrl(config));

    ws.on("open", () => {
      retryMs = 1000;
      console.log("[openclaw-pincer] WebSocket connected, sending REGISTER + AUTH");

      // Pincer handshake: REGISTER then AUTH
      ws.send(makeEnvelope("REGISTER", config.agentId, "hub", {
        name: config.agentName,
        capabilities: [],
        runtime_version: "openclaw/openclaw-pincer/0.3",
        messaging_mode: "ws",
      }));
      ws.send(makeEnvelope("AUTH", config.agentId, "hub", {
        api_key: config.token,
      }));

      // Heartbeat every 30s
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(makeEnvelope("HEARTBEAT", config.agentId, "hub", {
            agent_id: config.agentId,
          }));
        }
      }, 30000);
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(config, ctx, msg);
      } catch {}
    });

    ws.on("close", () => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (signal.aborted) return;
      console.log(`[openclaw-pincer] WS closed, reconnecting in ${retryMs}ms`);
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    });

    ws.on("error", (err: Error) => {
      if (!signal.aborted) console.error("[openclaw-pincer] WS error:", err.message);
      ws.close();
    });

    signal.addEventListener("abort", () => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      ws.close();
    }, { once: true });
  }

  connect();
}

function handleMessage(config: PincerConfig, ctx: any, msg: any) {
  const runtime = ctx.channelRuntime;
  if (!runtime) return;

  const msgType = msg.type ?? "";
  const payload = msg.payload ?? {};
  const fromId = msg.from ?? "unknown";

  // ACK — just log
  if (msgType === "ACK") {
    if (payload.status === "ok") {
      console.log("[openclaw-pincer] ✓ Authenticated with Pincer hub");
    } else {
      console.error("[openclaw-pincer] AUTH failed:", payload.error);
    }
    return;
  }

  // HEARTBEAT_ACK — check for inbox
  if (msgType === "HEARTBEAT_ACK" || msgType === "heartbeat.ack") {
    const inbox = payload.inbox ?? [];
    for (const item of inbox) {
      const inner = item.payload ?? {};
      const text = inner.text ?? JSON.stringify(inner);
      const sender = item.from ?? "unknown";
      dispatchToAgent(config, ctx, runtime, sender, text, undefined);
    }
    return;
  }

  // Ignore messages from self to prevent echo loops
  if (fromId === config.agentId) {
    return;
  }

  // PING → PONG
  if (msgType === "PING") {
    // We don't have ws ref here, but heartbeat keeps connection alive
    return;
  }

  // DM message
  if (msgType === "MESSAGE" || msgType === "agent.message") {
    const text = payload.text ?? "";
    if (!text) return;
    console.log(`[openclaw-pincer] 💬 DM from ${fromId.slice(0, 8)}: ${text.slice(0, 60)}`);
    dispatchToAgent(config, ctx, runtime, fromId, text, undefined);
    return;
  }

  // Inbox delivery (reconnect catch-up)
  if (msgType === "inbox.delivery") {
    const items = Array.isArray(payload) ? payload : [payload];
    for (const item of items) {
      const inner = item.payload ?? {};
      const text = inner.text ?? JSON.stringify(inner);
      const sender = item.from ?? "unknown";
      console.log(`[openclaw-pincer] 📬 Inbox from ${sender.slice(0, 8)}`);
      dispatchToAgent(config, ctx, runtime, sender, text, undefined);
    }
    return;
  }

  // Room message
  if (msgType === "room.message") {
    const data = msg.data ?? msg.payload ?? {};
    const sender = data.sender_agent_id ?? "unknown";
    const content = data.content ?? "";
    const roomId = data.room_id ?? msg.room_id ?? "";
    if (sender === config.agentId || !content) return;
    console.log(`[openclaw-pincer] 💬 Room msg from ${sender.slice(0, 8)}: ${content.slice(0, 60)}`);
    dispatchToAgent(config, ctx, runtime, sender, content, roomId);
    return;
  }

  // TASK_ASSIGN
  if (msgType === "TASK_ASSIGN" || msgType === "task.assigned") {
    const taskId = payload.task_id ?? "?";
    const title = payload.title ?? "";
    const description = payload.description ?? "";
    const text = `[Pincer Task]\ntask_id: ${taskId}\ntitle: ${title}\ndescription:\n${description}`;
    console.log(`[openclaw-pincer] 📋 Task assigned: ${taskId.slice(0, 8)} ${title}`);
    dispatchToAgent(config, ctx, runtime, fromId, text, undefined);
    return;
  }

  // BROADCAST
  if (msgType === "BROADCAST" || msgType === "broadcast") {
    const text = payload.text ?? JSON.stringify(payload);
    console.log(`[openclaw-pincer] 📢 Broadcast: ${text.slice(0, 60)}`);
    return;
  }
}

function dispatchToAgent(
  config: PincerConfig, ctx: any, runtime: any,
  senderId: string, text: string, roomId: string | undefined,
) {
  const sessionKey = roomId
    ? `openclaw-pincer:channel:${roomId}`
    : `openclaw-pincer:dm:${senderId}`;

  const peer = roomId
    ? { kind: "group" as const, id: roomId }
    : { kind: "direct" as const, id: senderId };

  const route = runtime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "openclaw-pincer",
    accountId: ctx.accountId,
    peer,
  });

  runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: {
      Body: text,
      BodyForAgent: text,
      From: senderId,
      SessionKey: route.sessionKey,
      Channel: "openclaw-pincer",
      AccountId: ctx.accountId,
    },
    cfg: ctx.cfg,
    dispatcherOptions: {
      deliver: async (payload: any) => {
        try {
          const text = payload.text ?? payload.content ?? JSON.stringify(payload);
          console.log(`[openclaw-pincer] 📤 Delivering reply to ${senderId.slice(0, 8)}: ${text.slice(0, 60)}`);
          if (roomId) {
            await httpPost(config, `/rooms/${roomId}/messages`, {
              sender_agent_id: config.agentId,
              content: text,
            });
          } else {
            await httpPost(config, "/messages/send", {
              from_agent_id: config.agentId,
              to_agent_id: senderId,
              payload: { text },
            });
          }
          console.log(`[openclaw-pincer] ✅ Reply sent to ${senderId.slice(0, 8)}`);
        } catch (err: any) {
          console.error(`[openclaw-pincer] ❌ Reply failed:`, err.message);
        }
      },
    },
  });
}

export const pincerChannel = {
  id: "openclaw-pincer",
  meta: {
    id: "openclaw-pincer",
    label: "Pincer",
    selectionLabel: "Pincer (agent hub)",
    docsPath: "/channels/pincer",
    docsLabel: "pincer",
    blurb: "Pincer agent hub — WebSocket connection.",
    order: 80,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    reactions: false,
    threads: false,
  },
  config: {
    listAccountIds: (cfg: any) => {
      const c = resolveConfig(cfg);
      return c.baseUrl && c.token && c.agentId ? ["default"] : [];
    },
    resolveAccount: (_cfg: any, accountId: string) => ({ accountId }),
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const config = resolveConfig(ctx.cfg);
      if (!config.baseUrl || !config.token || !config.agentId) {
        console.warn("[openclaw-pincer] Missing baseUrl, token, or agentId. Channel not started.");
        return;
      }
      if (!config.agentName) config.agentName = "openclaw-agent";

      const signal: AbortSignal = ctx.abortSignal;

      // Connect to agent DM hub
      connectWs({ config, ctx, signal });

      // Subscribe to all project rooms (and refresh every 60s for new projects)
      startProjectRoomSubscriptions({ config, ctx, signal });

      console.log("[openclaw-pincer] Started, connecting via WebSocket");

      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx: any) => {
      const config = resolveConfig(ctx.cfg);
      const to: string = ctx.to ?? "";
      if (to.startsWith("room:")) {
        await httpPost(config, `/rooms/${to.slice(5)}/messages`, {
          sender_agent_id: config.agentId,
          content: ctx.text,
        });
      } else {
        await httpPost(config, "/messages/send", {
          from_agent_id: config.agentId,
          to_agent_id: to,
          payload: { text: ctx.text },
        });
      }
      return { ok: true };
    },
  },
};
