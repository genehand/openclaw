import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { responsesApiDock, responsesApiPlugin } from "./src/channel.js";
import { handleResponsesApiRequest } from "./src/handler.js";
import { setResponsesApiRuntime } from "./src/runtime.js";

const plugin = {
  id: "responses-api",
  name: "Responses API Channel",
  description:
    "OpenAI Responses API endpoint routed through the standard channel pipeline (slash commands, hooks, plugin commands). Session-aware.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setResponsesApiRuntime(api.runtime);
    api.registerChannel({ plugin: responsesApiPlugin, dock: responsesApiDock });
    api.registerHttpHandler(handleResponsesApiRequest);
  },
};

export default plugin;
