/**
 * channel.ts — Pincer channel plugin (WebSocket inbound, HTTP outbound)
 */
export interface PincerConfig {
    baseUrl: string;
    token: string;
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
