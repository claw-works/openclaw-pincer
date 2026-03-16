/**
 * openclaw-pincer — Pincer channel plugin for OpenClaw
 *
 * Connects an OpenClaw agent to Pincer rooms and DMs.
 * Replaces the daemon.py polling approach with a proper channel plugin.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/pincer";
import { pincerPlugin } from "./src/channel.js";
import { setPincerRuntime } from "./src/runtime.js";

const plugin = {
  id: "pincer",
  name: "Pincer",
  description: "Pincer channel plugin — rooms and DMs for OpenClaw agents",
  register(api: OpenClawPluginApi) {
    setPincerRuntime(api.runtime);
    api.registerChannel({ plugin: pincerPlugin });
  },
};

export default plugin;
