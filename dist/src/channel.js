/**
 * channel.ts — Pincer channel plugin core
 *
 * Implements the OpenClaw ChannelPlugin interface for Pincer rooms and DMs.
 */
function resolveConfig(cfg) {
    return (cfg?.channels?.pincer ?? {});
}
async function pincerFetch(baseUrl, apiKey, path, options = {}) {
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
async function sendToPincerRoom(config, roomId, agentId, text) {
    await pincerFetch(config.baseUrl, config.apiKey, `/rooms/${roomId}/messages`, {
        method: "POST",
        body: JSON.stringify({ sender_agent_id: agentId, content: text }),
    });
}
async function sendToPincerDm(config, peerId, text) {
    await pincerFetch(config.baseUrl, config.apiKey, `/agents/${config.agentId}/messages`, {
        method: "POST",
        body: JSON.stringify({ to_agent_id: peerId, payload: { text } }),
    });
}
function startRoomPoller(params) {
    const { config, roomId, ctx, signal, pollMs } = params;
    let lastId = null;
    const poll = async () => {
        if (signal.aborted)
            return;
        try {
            const query = lastId ? `?after=${lastId}&limit=50` : "?limit=1";
            const msgs = await pincerFetch(config.baseUrl, config.apiKey, `/rooms/${roomId}/messages${query}`);
            // On first poll, just record the latest ID to avoid replaying history
            if (lastId === null) {
                if (msgs.length > 0)
                    lastId = msgs[msgs.length - 1].id;
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
                        deliver: async (payload) => {
                            await sendToPincerRoom(config, roomId, config.agentId, payload.text);
                        },
                    },
                });
                lastId = msg.id;
            }
        }
        catch (err) {
            if (!signal.aborted) {
                console.error(`[pincer] room ${roomId} poll error:`, err?.message);
            }
        }
    };
    const interval = setInterval(poll, pollMs);
    signal.addEventListener("abort", () => clearInterval(interval));
    poll();
}
function startDmPoller(params) {
    const { config, ctx, signal, pollMs } = params;
    let lastId = null;
    let initialized = false;
    const poll = async () => {
        if (signal.aborted)
            return;
        try {
            const query = lastId ? `?after=${lastId}&limit=50` : "?limit=1";
            const msgs = await pincerFetch(config.baseUrl, config.apiKey, `/agents/${config.agentId}/messages${query}`);
            if (!initialized) {
                initialized = true;
                if (msgs.length > 0)
                    lastId = msgs[msgs.length - 1].id;
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
                        deliver: async (payload) => {
                            await sendToPincerDm(config, peerId, payload.text);
                        },
                    },
                });
                lastId = msg.id;
            }
        }
        catch (err) {
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
        listAccountIds: (cfg) => {
            const config = resolveConfig(cfg);
            if (!config.agentId)
                return [];
            return [config.agentId];
        },
        resolveAccount: (_cfg, accountId) => {
            return { accountId };
        },
    },
    gateway: {
        startAccount: async (ctx) => {
            const config = resolveConfig(ctx.cfg);
            if (!config.baseUrl || !config.apiKey || !config.agentId) {
                console.warn("[pincer] Missing required config (baseUrl, apiKey, agentId). Channel not started.");
                return;
            }
            const signal = ctx.abortSignal;
            const pollMs = config.pollMs ?? 2000;
            for (const roomId of config.rooms ?? []) {
                startRoomPoller({ config, roomId, ctx, signal, pollMs });
            }
            startDmPoller({ config, ctx, signal, pollMs });
            console.log(`[pincer] Started. Monitoring ${(config.rooms ?? []).length} room(s) + DMs as agent ${config.agentId}`);
            // Keep startAccount alive until the signal fires — OpenClaw treats immediate
            // return as a crash and schedules auto-restart.
            await new Promise((resolve) => {
                if (signal.aborted) {
                    resolve();
                    return;
                }
                signal.addEventListener("abort", () => resolve(), { once: true });
            });
        },
    },
    outbound: {
        deliveryMode: "direct",
        sendText: async (ctx) => {
            const config = resolveConfig(ctx.cfg);
            const to = ctx.to ?? "";
            if (to.startsWith("room:")) {
                const roomId = to.slice("room:".length);
                await sendToPincerRoom(config, roomId, config.agentId, ctx.text);
            }
            else {
                await sendToPincerDm(config, to, ctx.text);
            }
            return { ok: true };
        },
    },
};
