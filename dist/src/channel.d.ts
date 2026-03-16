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
export declare const pincerChannel: {
    id: string;
    meta: {
        id: string;
        label: string;
        selectionLabel: string;
        docsPath: string;
        docsLabel: string;
        blurb: string;
        order: number;
    };
    capabilities: {
        chatTypes: string[];
        media: boolean;
        reactions: boolean;
        threads: boolean;
    };
    config: {
        listAccountIds: (cfg: any) => string[];
        resolveAccount: (_cfg: any, accountId: string) => {
            accountId: string;
        };
    };
    gateway: {
        startAccount: (ctx: any) => Promise<void>;
    };
    outbound: {
        deliveryMode: string;
        sendText: (ctx: any) => Promise<{
            ok: boolean;
        }>;
    };
};
