/**
 * channel.ts — Pincer channel plugin (WebSocket inbound, HTTP outbound)
 */

import WebSocket from "ws";

export interface PincerConfig {
  baseUrl: string;
  token: string;
}

function resolveConfig(cfg: any): PincerConfig {
  return (cfg?.channels?.["openclaw-pincer"] ?? {}) as PincerConfig;
}

function wsUrl(config: PincerConfig): string {
  const base = config.baseUrl.replace(/\/$/, "").replace(/^http/, "ws");
  return `${base}/api/v1/ws?token=${config.token}`;
}

async function httpPost(config: PincerConfig, path: string, body: any): Promise<void> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/api/v1${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Pincer POST ${path} ${res.status}`);
}

function connectWs(params: {
  config: PincerConfig;
  ctx: any;
  signal: AbortSignal;
}) {
  const { config, ctx, signal } = params;
  let retryMs = 1000;

  function connect() {
    if (signal.aborted) return;

    const ws = new WebSocket(wsUrl(config));

    ws.on("open", () => {
      retryMs = 1000;
      console.log("[openclaw-pincer] WebSocket connected");
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(config, ctx, msg);
      } catch {}
    });

    ws.on("close", () => {
      if (signal.aborted) return;
      console.log(`[openclaw-pincer] WS closed, reconnecting in ${retryMs}ms`);
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    });

    ws.on("error", (err: Error) => {
      if (!signal.aborted) console.error("[openclaw-pincer] WS error:", err.message);
      ws.close();
    });

    signal.addEventListener("abort", () => ws.close(), { once: true });
  }

  connect();
}

function handleMessage(config: PincerConfig, ctx: any, msg: any) {
  const runtime = ctx.channelRuntime;
  if (!runtime) return;

  const sessionKey = msg.room_id
    ? `openclaw-pincer:channel:${msg.room_id}`
    : `openclaw-pincer:dm:${msg.from_agent_id ?? msg.sender_agent_id ?? "unknown"}`;

  const senderId = msg.from_agent_id ?? msg.sender_agent_id ?? "unknown";
  const text = msg.content ?? msg.payload?.text ?? "";
  if (!text) return;

  const peer = msg.room_id
    ? { kind: "group" as const, id: msg.room_id }
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
        if (msg.room_id) {
          await httpPost(config, `/rooms/${msg.room_id}/messages`, { content: payload.text });
        } else {
          await httpPost(config, "/messages/send", {
            to_agent_id: senderId,
            payload: { text: payload.text },
          });
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
      return c.baseUrl && c.token ? ["default"] : [];
    },
    resolveAccount: (_cfg: any, accountId: string) => ({ accountId }),
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const config = resolveConfig(ctx.cfg);
      if (!config.baseUrl || !config.token) {
        console.warn("[openclaw-pincer] Missing baseUrl or token. Channel not started.");
        return;
      }

      const signal: AbortSignal = ctx.abortSignal;
      connectWs({ config, ctx, signal });

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
        await httpPost(config, `/rooms/${to.slice(5)}/messages`, { content: ctx.text });
      } else {
        await httpPost(config, "/messages/send", {
          to_agent_id: to,
          payload: { text: ctx.text },
        });
      }
      return { ok: true };
    },
  },
};
