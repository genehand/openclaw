import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setResponsesApiRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getResponsesApiRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Responses API channel runtime not initialized");
  }
  return runtime;
}
