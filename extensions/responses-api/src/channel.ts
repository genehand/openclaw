import {
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelDock,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { responsesApiOutbound } from "./outbound.js";

export type ResponsesApiAccount = {
  accountId: string;
  enabled: boolean;
};

export const responsesApiDock: ChannelDock = {
  id: "responses-api",
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    media: true,
    threads: false,
    blockStreaming: false,
  },
  config: {
    resolveAllowFrom: () => ["*"],
    formatAllowFrom: ({ allowFrom }) => allowFrom.map(String),
  },
};

export const responsesApiPlugin: ChannelPlugin<ResponsesApiAccount> = {
  id: "responses-api",
  meta: {
    id: "responses-api",
    label: "Responses API",
    selectionLabel: "OpenAI Responses API (Channel)",
    docsPath: "/channels/responses-api",
    blurb: "OpenAI Responses API endpoint routed through the standard channel pipeline.",
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    media: true,
    threads: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (_cfg, accountId) => ({
      accountId: accountId ?? DEFAULT_ACCOUNT_ID,
      enabled: true,
    }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: () => true,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: true,
    }),
    resolveAllowFrom: () => ["*"],
    formatAllowFrom: ({ allowFrom }) => allowFrom.map(String),
  },
  security: {
    resolveDmPolicy: () => ({
      policy: "open",
      allowFrom: ["*"],
      allowFromPath: "channels.responses-api.",
      approveHint: formatPairingApproveHint("responses-api"),
    }),
  },
  // Outbound adapter captures payloads into a request-scoped collector
  // so the HTTP handler can include `message send` media in the response.
  outbound: responsesApiOutbound,
  // Accept any target string -- this channel has no directory; the target
  // is the in-flight HTTP request's peer identifier.
  messaging: {
    targetResolver: {
      looksLikeId: () => true,
    },
  },
  // No gateway adapter -- the HTTP handler is registered separately.
};
