import { pincerChannel } from "./src/channel.js";
const plugin = {
    id: "openclaw-pincer",
    name: "Pincer",
    description: "Pincer channel plugin — WebSocket connection for OpenClaw agents",
    register(api) {
        api.registerChannel(pincerChannel);
    },
};
export default plugin;
