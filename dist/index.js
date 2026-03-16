import { pincerChannel } from "./src/channel.js";
const plugin = {
    id: "pincer",
    name: "Pincer",
    description: "Pincer channel plugin — rooms and DMs for OpenClaw agents",
    register(api) {
        api.registerChannel(pincerChannel);
    },
};
export default plugin;
