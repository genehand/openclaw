import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";

/**
 * Captured outbound payload from the `message send` tool path.
 * The HTTP handler reads these after the agent run completes.
 */
export type CapturedOutbound = {
  text: string;
  mediaUrl?: string;
};

// Request-scoped collectors keyed by `to` address.
// Each in-flight HTTP request registers a collector before dispatch
// and removes it after the agent run completes.
const collectors = new Map<string, CapturedOutbound[]>();

/**
 * Register a collector for the given target address.
 * Returns a handle to retrieve captured payloads and clean up.
 */
export function registerOutboundCollector(to: string): {
  drain: () => CapturedOutbound[];
  dispose: () => void;
} {
  const queue: CapturedOutbound[] = [];
  collectors.set(to, queue);
  return {
    drain: () => [...queue],
    dispose: () => {
      collectors.delete(to);
    },
  };
}

const CHANNEL_ID = "responses-api";

/**
 * Lightweight outbound adapter that captures payloads into a request-scoped
 * collector instead of sending to an external service.
 *
 * The HTTP handler registers a collector before dispatching the reply,
 * and drains it after the agent run to include any `message send` media
 * in the HTTP response.
 */
export const responsesApiOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",

  sendText: async ({ to, text }) => {
    console.log(
      `[responses-api outbound] sendText to=${to}, text=${text?.slice(0, 60)}, hasCollector=${collectors.has(to)}`,
    );
    const queue = collectors.get(to);
    if (queue) {
      queue.push({ text });
    }
    return { channel: CHANNEL_ID, messageId: `out_${Date.now()}` };
  },

  sendMedia: async ({ to, text, mediaUrl }) => {
    console.log(
      `[responses-api outbound] sendMedia to=${to}, mediaUrl=${mediaUrl}, text=${text?.slice(0, 60)}, hasCollector=${collectors.has(to)}`,
    );
    const queue = collectors.get(to);
    if (queue) {
      queue.push({ text, mediaUrl });
    }
    return { channel: CHANNEL_ID, messageId: `out_${Date.now()}` };
  },
};
