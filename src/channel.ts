/**
 * channel.ts — Pincer channel plugin core
 *
 * Inbound:  polls GET /rooms/{roomId}/messages?after={lastId}
 *           polls GET /agents/{myId}/messages?peer_id={peerId} (DM)
 *           → api.injectMessage()
 *
 * Outbound: api.registerSend()
 *           → POST /rooms/{roomId}/messages
 *           → POST /agents/{fromId}/messages (DM)
 *
 * Config (channels.pincer in openclaw.json):
 *   baseUrl   — Pincer server URL (e.g. https://pincer.apig.run)
 *   apiKey    — Pincer API key
 *   agentId   — This agent's Pincer agent ID
 *   rooms     — Array of room IDs to monitor
 *   pollMs    — Poll interval in ms (default: 2000)
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

function buildRoomSessionKey(roomId: string): string {
  return `pincer:channel:${roomId}`;
}

function buildDmSessionKey(peerId: string): string {
  return `pincer:dm:${peerId}`;
}

/**
 * Start polling a room for new messages.
 * Calls api.injectMessage() for each new message from other agents.
 */
function startRoomPoller(params: {
  config: PincerConfig;
  roomId: string;
  api: any;
  signal: AbortSignal;
}) {
  const { config, roomId, api, signal } = params;
  const pollMs = config.pollMs ?? 2000;
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
        if (msgs.length > 0) {
          lastId = msgs[msgs.length - 1].id;
        }
        return;
      }

      for (const msg of msgs) {
        // Skip own messages
        if (msg.sender_agent_id === config.agentId) {
          lastId = msg.id;
          continue;
        }
        await api.injectMessage({
          sessionKey: buildRoomSessionKey(roomId),
          channel: "pincer",
          from: msg.sender_agent_id ?? "unknown",
          text: msg.content ?? "",
          meta: { roomId, messageId: msg.id, createdAt: msg.created_at },
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
  // Initial poll
  poll();
}

/**
 * Start polling DMs for a given peer agent.
 * In practice, we poll /agents/{myId}/messages and fan out by peer.
 */
function startDmPoller(params: {
  config: PincerConfig;
  api: any;
  signal: AbortSignal;
}) {
  const { config, api, signal } = params;
  const pollMs = (config.pollMs ?? 2000) * 2; // DM poll at half rate
  let lastId: string | null = null;
  let initialized = false;

  const poll = async () => {
    if (signal.aborted) return;
    try {
      const query = lastId
        ? `?after=${lastId}&limit=50`
        : "?limit=1";
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

      for (const msg of msgs) {
        if (msg.from_agent_id === config.agentId) {
          lastId = msg.id;
          continue;
        }
        const peerId = msg.from_agent_id ?? "unknown";
        await api.injectMessage({
          sessionKey: buildDmSessionKey(peerId),
          channel: "pincer",
          from: peerId,
          text: msg.payload?.text ?? "",
          meta: { dm: true, peerId, messageId: msg.id, createdAt: msg.created_at },
        });
        lastId = msg.id;
      }
    } catch (err: any) {
      if (!signal.aborted) {
        console.error("[pincer] DM poll error:", err?.message);
      }
    }
  };

  const interval = setInterval(poll, pollMs);
  signal.addEventListener("abort", () => clearInterval(interval));
  poll();
}

/**
 * Send a message back to Pincer (outbound from OpenClaw → Pincer).
 * Called by OpenClaw when the agent produces a reply.
 */
async function sendPincerMessage(params: {
  config: PincerConfig;
  sessionKey: string;
  text: string;
}): Promise<void> {
  const { config, sessionKey, text } = params;

  if (sessionKey.startsWith("pincer:channel:")) {
    const roomId = sessionKey.slice("pincer:channel:".length);
    await pincerFetch(config.baseUrl, config.apiKey, `/rooms/${roomId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        sender_agent_id: config.agentId,
        content: text,
      }),
    });
    return;
  }

  if (sessionKey.startsWith("pincer:dm:")) {
    const peerId = sessionKey.slice("pincer:dm:".length);
    await pincerFetch(
      config.baseUrl,
      config.apiKey,
      `/agents/${config.agentId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          to_agent_id: peerId,
          payload: { text },
        }),
      }
    );
    return;
  }

  console.warn(`[pincer] unknown session key format: ${sessionKey}`);
}

/**
 * The plugin object registered with OpenClaw.
 */
export const pincerPlugin = {
  id: "pincer",

  async start(api: any) {
    const config: PincerConfig = api.getConfig?.() ?? {};

    if (!config.baseUrl || !config.apiKey || !config.agentId) {
      console.warn(
        "[pincer] Missing required config (baseUrl, apiKey, agentId). Channel not started."
      );
      return;
    }

    const abort = new AbortController();

    // Start room pollers
    for (const roomId of config.rooms ?? []) {
      startRoomPoller({ config, roomId, api, signal: abort.signal });
    }

    // Start DM poller
    startDmPoller({ config, api, signal: abort.signal });

    // Register outbound send handler
    api.registerSend(async (params: { sessionKey: string; text: string }) => {
      await sendPincerMessage({ config, sessionKey: params.sessionKey, text: params.text });
    });

    console.log(
      `[pincer] Started. Monitoring ${(config.rooms ?? []).length} room(s) + DMs as agent ${config.agentId}`
    );

    return () => abort.abort();
  },
};
