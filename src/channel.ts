/**
 * channel.ts — Pincer channel plugin core
 *
 * Implements the OpenClaw ChannelPlugin interface for Pincer rooms and DMs.
 */

export interface PincerConfig {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  rooms?: string[];
  pollMs?: number;
}

interface PincerMessage {
  id: string;
  room_id?: string;
  sender_agent_id?: string;
  from_agent_id?: string;
  to_agent_id?: string;
  content?: string;
  payload?: { text: string };
  created_at: string;
}

function resolveConfig(cfg: any): PincerConfig {
  return (cfg?.channels?.pincer ?? {}) as PincerConfig;
}

async function pincerFetch(
  baseUrl: string,
  apiKey: string,
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Pincer API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function sendToPincerRoom(
  config: PincerConfig,
  roomId: string,
  agentId: string,
  text: string
): Promise<void> {
  await pincerFetch(config.baseUrl, config.apiKey, `/rooms/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({ sender_agent_id: agentId, content: text }),
  });
}

async function sendToPincerDm(
  config: PincerConfig,
  peerId: string,
  text: string
): Promise<void> {
  await pincerFetch(config.baseUrl, config.apiKey, `/agents/${config.agentId}/messages`, {
    method: "POST",
    body: JSON.stringify({ to_agent_id: peerId, payload: { text } }),
  });
}

function startRoomPoller(params: {
  config: PincerConfig;
  roomId: string;
  ctx: any;
  signal: AbortSignal;
  pollMs: number;
}) {
  const { config, roomId, ctx, signal, pollMs } = params;
  let lastId: string | null = null;

  const poll = async () => {
    if (signal.aborted) return;
    try {
      const query = lastId ? `?after=${lastId}&limit=50` : "?limit=1";
      const msgs: PincerMessage[] = await pincerFetch(
        config.baseUrl,
        config.apiKey,
        `/rooms/${roomId}/messages${query}`
      );

      // On first poll, just record the latest ID to avoid replaying history
      if (lastId === null) {
        if (msgs.length > 0) lastId = msgs[msgs.length - 1].id;
        return;
      }

      const channelRuntime = ctx.channelRuntime;
      for (const msg of msgs) {
        if (msg.sender_agent_id === config.agentId) {
          lastId = msg.id;
          continue;
        }

        if (!channelRuntime) {
          console.warn("[pincer] channelRuntime not available, skipping room message dispatch");
          lastId = msg.id;
          continue;
        }

        const messageText = msg.content ?? "";
        const senderId = msg.sender_agent_id ?? "unknown";

        const route = channelRuntime.routing.resolveAgentRoute({
          cfg: ctx.cfg,
          channel: "pincer",
          accountId: ctx.accountId,
          peer: { kind: "group", id: roomId },
        });

        await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: {
            Body: messageText,
            BodyForAgent: messageText,
            From: senderId,
            SessionKey: route.sessionKey,
            Channel: "pincer",
            AccountId: ctx.accountId,
          },
          cfg: ctx.cfg,
          dispatcherOptions: {
            deliver: async (payload: any) => {
              await sendToPincerRoom(config, roomId, config.agentId, payload.text);
            },
          },
        });

        lastId = msg.id;
      }
    } catch (err: any) {
      if (!signal.aborted) {
        console.error(`[pincer] room ${roomId} poll error:`, err?.message);
      }
    }
  };

  const interval = setInterval(poll, pollMs);
  signal.addEventListener("abort", () => clearInterval(interval));
  poll();
}

function startDmPoller(params: {
  config: PincerConfig;
  ctx: any;
  signal: AbortSignal;
  pollMs: number;
}) {
  const { config, ctx, signal, pollMs } = params;
  let lastId: string | null = null;
  let initialized = false;

  const poll = async () => {
    if (signal.aborted) return;
    try {
      const query = lastId ? `?after=${lastId}&limit=50` : "?limit=1";
      const msgs: PincerMessage[] = await pincerFetch(
        config.baseUrl,
        config.apiKey,
        `/agents/${config.agentId}/messages${query}`
      );

      if (!initialized) {
        initialized = true;
        if (msgs.length > 0) lastId = msgs[msgs.length - 1].id;
        return;
      }

      const channelRuntime = ctx.channelRuntime;
      for (const msg of msgs) {
        if (msg.from_agent_id === config.agentId) {
          lastId = msg.id;
          continue;
        }

        if (!channelRuntime) {
          console.warn("[pincer] channelRuntime not available, skipping DM dispatch");
          lastId = msg.id;
          continue;
        }

        const peerId = msg.from_agent_id ?? "unknown";
        const messageText = msg.payload?.text ?? "";

        const route = channelRuntime.routing.resolveAgentRoute({
          cfg: ctx.cfg,
          channel: "pincer",
          accountId: ctx.accountId,
          peer: { kind: "direct", id: peerId },
        });

        await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: {
            Body: messageText,
            BodyForAgent: messageText,
            From: peerId,
            SessionKey: route.sessionKey,
            Channel: "pincer",
            AccountId: ctx.accountId,
          },
          cfg: ctx.cfg,
          dispatcherOptions: {
            deliver: async (payload: any) => {
              await sendToPincerDm(config, peerId, payload.text);
            },
          },
        });

        lastId = msg.id;
      }
    } catch (err: any) {
      if (!signal.aborted) {
        console.error("[pincer] DM poll error:", err?.message);
      }
    }
  };

  const interval = setInterval(poll, pollMs * 2); // DM poll at half rate
  signal.addEventListener("abort", () => clearInterval(interval));
  poll();
}

export const pincerChannel = {
  id: "pincer",
  meta: {
    id: "pincer",
    label: "Pincer",
    selectionLabel: "Pincer (agent hub)",
    docsPath: "/channels/pincer",
    docsLabel: "pincer",
    blurb: "Pincer agent hub — rooms and DMs.",
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
      const config = resolveConfig(cfg);
      if (!config.agentId) return [];
      return [config.agentId];
    },
    resolveAccount: (_cfg: any, accountId: string) => {
      return { accountId };
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const config = resolveConfig(ctx.cfg);
      if (!config.baseUrl || !config.apiKey || !config.agentId) {
        console.warn("[pincer] Missing required config (baseUrl, apiKey, agentId). Channel not started.");
        return;
      }

      const signal: AbortSignal = ctx.abortSignal;
      const pollMs = config.pollMs ?? 2000;

      for (const roomId of config.rooms ?? []) {
        startRoomPoller({ config, roomId, ctx, signal, pollMs });
      }

      startDmPoller({ config, ctx, signal, pollMs });

      console.log(
        `[pincer] Started. Monitoring ${(config.rooms ?? []).length} room(s) + DMs as agent ${config.agentId}`
      );
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx: any) => {
      const config = resolveConfig(ctx.cfg);
      const to: string = ctx.to ?? "";
      if (to.startsWith("room:")) {
        const roomId = to.slice("room:".length);
        await sendToPincerRoom(config, roomId, config.agentId, ctx.text);
      } else {
        await sendToPincerDm(config, to, ctx.text);
      }
      return { ok: true };
    },
  },
};
