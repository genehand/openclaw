import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import {
  DEFAULT_ACCOUNT_ID,
  createReplyPrefixOptions,
  saveMediaSource,
  type OpenClawConfig,
  type PluginRuntime,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { registerOutboundCollector, type CapturedOutbound } from "./outbound.js";
import { getResponsesApiRuntime } from "./runtime.js";

// -- HTTP helpers -----------------------------------------------------------

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

function getBearerToken(req: IncomingMessage): string | undefined {
  const raw = getHeader(req, "authorization")?.trim() ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) return undefined;
  const token = raw.slice(7).trim();
  return token || undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendMethodNotAllowed(res: ServerResponse, allow = "POST") {
  res.setHeader("Allow", allow);
  res.statusCode = 405;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Method Not Allowed");
}

function sendUnauthorized(res: ServerResponse) {
  sendJson(res, 401, { error: { message: "Unauthorized", type: "unauthorized" } });
}

function setSseHeaders(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

function writeSseEvent(res: ServerResponse, event: { type: string; [key: string]: unknown }) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeDone(res: ServerResponse) {
  res.write("data: [DONE]\n\n");
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        resolve({ ok: false, error: "Request body too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const parsed: unknown = JSON.parse(raw);
        resolve({ ok: true, value: parsed });
      } catch {
        resolve({ ok: false, error: "Invalid JSON body" });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: String(err) });
    });
  });
}

// -- Auth -------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function resolveAuthToken(cfg: {
  gateway?: { auth?: { token?: string; password?: string; mode?: string } };
}): {
  mode: "token" | "password";
  secret: string | undefined;
} {
  const authCfg = cfg.gateway?.auth;
  const token =
    authCfg?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.CLAWDBOT_GATEWAY_TOKEN;
  const password =
    authCfg?.password ??
    process.env.OPENCLAW_GATEWAY_PASSWORD ??
    process.env.CLAWDBOT_GATEWAY_PASSWORD;
  const mode = (authCfg?.mode ?? (password ? "password" : "token")) as "token" | "password";
  return { mode, secret: mode === "password" ? password : token };
}

function authorize(bearerToken: string | undefined, cfg: Record<string, unknown>): boolean {
  const { secret } = resolveAuthToken(cfg as Parameters<typeof resolveAuthToken>[0]);
  if (!secret || !bearerToken) return false;
  return safeEqual(bearerToken, secret);
}

// -- Agent ID resolution ----------------------------------------------------

function resolveAgentIdFromHeader(req: IncomingMessage): string | undefined {
  const raw =
    getHeader(req, "x-openclaw-agent-id")?.trim() ||
    getHeader(req, "x-openclaw-agent")?.trim() ||
    "";
  return raw || undefined;
}

function resolveAgentIdFromModel(model: string | undefined): string | undefined {
  const raw = model?.trim();
  if (!raw) return undefined;
  const m =
    raw.match(/^openclaw[:/](?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i) ??
    raw.match(/^agent:(?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i);
  return m?.groups?.agentId ?? undefined;
}

function resolveAgentId(req: IncomingMessage, model: string | undefined): string {
  return resolveAgentIdFromHeader(req) ?? resolveAgentIdFromModel(model) ?? "main";
}

// -- Input types (Responses API) --------------------------------------------

type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "text"; text: string }
  | { type: "input_image"; source: unknown }
  | { type: "input_file"; source: unknown };

type MessageItem = {
  type?: "message";
  role: string;
  content: string | ContentPart[];
};

type FunctionCallOutputItem = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

type ItemParam = MessageItem | FunctionCallOutputItem | { type: string; [key: string]: unknown };

type CreateResponseBody = {
  model?: unknown;
  input?: unknown;
  instructions?: unknown;
  stream?: unknown;
  user?: unknown;
  previous_response_id?: unknown;
};

function coerceRequest(val: unknown): CreateResponseBody {
  if (!val || typeof val !== "object") return {};
  return val as CreateResponseBody;
}

// -- Input → prompt conversion (mirrors openresponses-http.ts) --------------

function extractTextContent(content: string | ContentPart[] | unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentPart[])
    .map((part) => {
      if (typeof part === "string") return part;
      if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
        return (part as { text: string }).text ?? "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Convert Responses API `input` (string or ItemParam[]) into a flat prompt.
 * System/developer messages go into `extraSystemPrompt`; the last user
 * message becomes the prompt. Unlike Chat Completions, history is managed
 * server-side via session keys, so we only need the latest user turn.
 */
function buildPromptFromInput(input: unknown): {
  message: string;
  lastUserMessage: string;
  extraSystemPrompt?: string;
} {
  if (typeof input === "string") {
    return { message: input, lastUserMessage: input };
  }

  if (!Array.isArray(input)) {
    return { message: "", lastUserMessage: "" };
  }

  const items = input as ItemParam[];
  const systemParts: string[] = [];
  let lastUserMessage = "";

  for (const item of items) {
    // Items with a `role` field are messages — `type: "message"` is optional
    // per the OpenAI Responses API spec.
    const isMessage = item.type === "message" || (!item.type && "role" in item);
    if (isMessage) {
      const msg = item as MessageItem;
      const content = extractTextContent(msg.content).trim();
      if (!content) continue;

      if (msg.role === "system" || msg.role === "developer") {
        systemParts.push(content);
        continue;
      }

      if (msg.role === "user") {
        lastUserMessage = content;
      }
    } else if (item.type === "function_call_output") {
      const fco = item as FunctionCallOutputItem;
      lastUserMessage = fco.output;
    }
  }

  return {
    message: lastUserMessage,
    lastUserMessage,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

// -- Media URL resolution ---------------------------------------------------

function isRemoteUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

function deriveGatewayBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host || "localhost";
  return `http://${host}`;
}

async function resolveMediaUrl(source: string, gatewayBaseUrl: string): Promise<string> {
  console.log(`[responses-api] resolveMediaUrl source=${source}, isRemote=${isRemoteUrl(source)}`);
  if (isRemoteUrl(source)) return source;
  const filePath = source.startsWith("file://") ? source.slice(7) : source;
  try {
    const saved = await saveMediaSource(filePath, undefined, "outbound");
    return `${gatewayBaseUrl}/media/outbound/${saved.id}`;
  } catch {
    return source;
  }
}

async function resolveMediaUrls(urls: string[], gatewayBaseUrl: string): Promise<string[]> {
  return Promise.all(urls.map((u) => resolveMediaUrl(u, gatewayBaseUrl)));
}

// -- Responses API response formatting --------------------------------------

type Usage = { input_tokens: number; output_tokens: number; total_tokens: number };

function createEmptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

type OutputItem = {
  type: "message";
  id: string;
  role: "assistant";
  content: Array<{ type: "output_text"; text: string }>;
  status?: "in_progress" | "completed";
};

type ResponseResource = {
  id: string;
  object: "response";
  created_at: number;
  status: "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";
  model: string;
  output: OutputItem[];
  usage: Usage;
  error?: { code: string; message: string };
};

function createResponseResource(params: {
  id: string;
  model: string;
  status: ResponseResource["status"];
  output: OutputItem[];
  usage?: Usage;
  error?: { code: string; message: string };
}): ResponseResource {
  return {
    id: params.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: params.status,
    model: params.model,
    output: params.output,
    usage: params.usage ?? createEmptyUsage(),
    error: params.error,
  };
}

function createAssistantOutputItem(params: {
  id: string;
  text: string;
  status?: "in_progress" | "completed";
}): OutputItem {
  return {
    type: "message",
    id: params.id,
    role: "assistant",
    content: [{ type: "output_text", text: params.text }],
    status: params.status,
  };
}

// -- Media formatting -------------------------------------------------------

function collectMediaUrls(payload: ReplyPayload): string[] {
  const urls: string[] = [];
  if (payload.mediaUrls?.length) {
    urls.push(...payload.mediaUrls.filter(Boolean));
  } else if (payload.mediaUrl) {
    urls.push(payload.mediaUrl);
  }
  return urls;
}

/** Extract media URLs from outbound payloads captured by the collector. */
function capturedOutboundToMediaUrls(captured: CapturedOutbound[]): string[] {
  return captured.flatMap((c) => (c.mediaUrl ? [c.mediaUrl] : []));
}

function formatMediaAsMarkdown(urls: string[]): string {
  if (urls.length === 0) return "";
  return urls.map((url) => `![image](${url})`).join("\n");
}

async function payloadToContent(payload: ReplyPayload, gatewayBaseUrl: string): Promise<string> {
  const text = payload.text ?? "";
  const rawUrls = collectMediaUrls(payload);
  const resolved = rawUrls.length > 0 ? await resolveMediaUrls(rawUrls, gatewayBaseUrl) : [];
  const media = formatMediaAsMarkdown(resolved);
  if (!text && !media) return "";
  if (!media) return text;
  if (!text) return media;
  return `${text}\n\n${media}`;
}

// -- Main handler -----------------------------------------------------------

const ENDPOINT_PATH = "/v1/channel/responses";
const CHANNEL_ID = "responses-api";
const MAX_BODY_BYTES = 20 * 1024 * 1024;

/**
 * HTTP handler registered via `api.registerHttpHandler()`. Handles
 * OpenAI Responses API requests at `/v1/channel/responses`,
 * routing through the standard channel dispatch pipeline.
 *
 * Because the Responses API is session-aware (via `previous_response_id`
 * or session keys), clients only send the latest user message rather than
 * the full conversation history on every request.
 */
export async function handleResponsesApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== ENDPOINT_PATH) return false;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  // -- Auth -----------------------------------------------------------------
  const runtime = getResponsesApiRuntime();
  const cfg = await runtime.config.loadConfig();
  const bearerToken = getBearerToken(req);
  if (!authorize(bearerToken, cfg as Record<string, unknown>)) {
    sendUnauthorized(res);
    return true;
  }

  // -- Parse request --------------------------------------------------------
  const bodyResult = await readJsonBody(req, MAX_BODY_BYTES);
  if (!bodyResult.ok) {
    sendJson(res, 400, { error: { message: bodyResult.error, type: "invalid_request_error" } });
    return true;
  }

  const payload = coerceRequest(bodyResult.value);
  const stream = Boolean(payload.stream);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;
  const instructions = typeof payload.instructions === "string" ? payload.instructions : undefined;

  const agentId = resolveAgentId(req, model);
  const prompt = buildPromptFromInput(payload.input);

  if (!prompt.message) {
    sendJson(res, 400, {
      error: { message: "Missing user message in `input`.", type: "invalid_request_error" },
    });
    return true;
  }

  // Combine instructions with any system prompt from input
  const extraSystemPrompt = [instructions, prompt.extraSystemPrompt].filter(Boolean).join("\n\n");

  const responseId = `resp_${randomUUID()}`;
  const outputItemId = `msg_${randomUUID()}`;
  const peerId = user ?? "api-client";

  // -- Resolve agent route --------------------------------------------------
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: DEFAULT_ACCOUNT_ID,
    peer: { kind: "direct", id: peerId },
  });

  // -- Build MsgContext -----------------------------------------------------
  const ctx = runtime.channel.reply.finalizeInboundContext({
    Body: prompt.message,
    RawBody: prompt.message,
    CommandBody: prompt.lastUserMessage,
    BodyForAgent: prompt.message,
    BodyForCommands: prompt.lastUserMessage,
    From: `${CHANNEL_ID}:${peerId}`,
    To: `${CHANNEL_ID}:api`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    SenderId: peerId,
    SenderName: user ?? "API",
    CommandAuthorized: true,
    MessageSid: responseId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:api`,
    GroupSystemPrompt: extraSystemPrompt || undefined,
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: route.accountId,
  });

  if (!stream) {
    return handleNonStreaming({
      req,
      res,
      ctx,
      cfg,
      core: runtime,
      responseId,
      outputItemId,
      model,
      prefixOptions,
      onModelSelected,
      collectorTo: `${CHANNEL_ID}:api`,
    });
  }
  return handleStreaming({
    req,
    res,
    ctx,
    cfg,
    core: runtime,
    responseId,
    outputItemId,
    model,
    prefixOptions,
    onModelSelected,
    collectorTo: `${CHANNEL_ID}:api`,
  });
}

// -- Non-streaming path -----------------------------------------------------

async function handleNonStreaming(params: {
  req: IncomingMessage;
  res: ServerResponse;
  ctx: ReturnType<PluginRuntime["channel"]["reply"]["finalizeInboundContext"]>;
  cfg: OpenClawConfig;
  core: PluginRuntime;
  responseId: string;
  outputItemId: string;
  model: string;
  prefixOptions: Record<string, unknown>;
  onModelSelected:
    | ((ctx: { provider: string; model: string; thinkLevel: string | undefined }) => void)
    | undefined;
  collectorTo: string;
}): Promise<true> {
  const {
    req,
    res,
    ctx,
    cfg,
    core,
    responseId,
    outputItemId,
    model,
    prefixOptions,
    onModelSelected,
    collectorTo,
  } = params;
  const payloads: ReplyPayload[] = [];
  const gatewayBaseUrl = deriveGatewayBaseUrl(req);

  // Register a collector so the outbound adapter can capture any media
  // the agent sends via the `message send` tool during this request.
  const collector = registerOutboundCollector(collectorTo);

  try {
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload: ReplyPayload) => {
          const urls = collectMediaUrls(payload);
          console.log(
            `[responses-api] deliver payload: text=${(payload.text ?? "").slice(0, 80)}, mediaUrls=${JSON.stringify(urls)}`,
          );
          payloads.push(payload);
        },
        onError: (err: unknown) => {
          core.logging
            .getChildLogger({ channel: CHANNEL_ID })
            .error(`Non-streaming reply failed: ${String(err)}`);
        },
      },
      replyOptions: { onModelSelected },
    });

    // Merge any media captured from the `message send` tool path.
    const captured = collector.drain();
    console.log(
      `[responses-api] collector drained: ${captured.length} items`,
      captured.map((c) => ({ text: c.text?.slice(0, 40), mediaUrl: c.mediaUrl })),
    );
    const capturedMedia = capturedOutboundToMediaUrls(captured);

    const contentParts =
      payloads.length > 0
        ? (await Promise.all(payloads.map((p) => payloadToContent(p, gatewayBaseUrl)))).filter(
            Boolean,
          )
        : [];

    // Append captured media as markdown images.
    if (capturedMedia.length > 0) {
      const resolved = await resolveMediaUrls(capturedMedia, gatewayBaseUrl);
      const media = formatMediaAsMarkdown(resolved);
      if (media) {
        contentParts.push(media);
      }
    }

    const content =
      contentParts.length > 0 ? contentParts.join("\n\n") : "No response from OpenClaw.";

    const response = createResponseResource({
      id: responseId,
      model,
      status: "completed",
      output: [createAssistantOutputItem({ id: outputItemId, text: content, status: "completed" })],
    });

    sendJson(res, 200, response);
  } catch (err) {
    const response = createResponseResource({
      id: responseId,
      model,
      status: "failed",
      output: [],
      error: { code: "api_error", message: String(err) },
    });
    sendJson(res, 500, response);
  } finally {
    collector.dispose();
  }

  return true;
}

// -- Streaming path ---------------------------------------------------------

async function handleStreaming(params: {
  req: IncomingMessage;
  res: ServerResponse;
  ctx: ReturnType<PluginRuntime["channel"]["reply"]["finalizeInboundContext"]>;
  cfg: OpenClawConfig;
  core: PluginRuntime;
  responseId: string;
  outputItemId: string;
  model: string;
  prefixOptions: Record<string, unknown>;
  onModelSelected:
    | ((ctx: { provider: string; model: string; thinkLevel: string | undefined }) => void)
    | undefined;
  collectorTo: string;
}): Promise<true> {
  const {
    req,
    res,
    ctx,
    cfg,
    core,
    responseId,
    outputItemId,
    model,
    prefixOptions,
    onModelSelected,
    collectorTo,
  } = params;

  setSseHeaders(res);

  let closed = false;
  let accumulatedText = "";
  let emittedLength = 0;
  const gatewayBaseUrl = deriveGatewayBaseUrl(req);

  req.on("close", () => {
    closed = true;
  });

  // -- Emit initial events --------------------------------------------------
  const initialResponse = createResponseResource({
    id: responseId,
    model,
    status: "in_progress",
    output: [],
  });

  writeSseEvent(res, { type: "response.created", response: initialResponse });
  writeSseEvent(res, { type: "response.in_progress", response: initialResponse });

  const outputItem = createAssistantOutputItem({
    id: outputItemId,
    text: "",
    status: "in_progress",
  });

  writeSseEvent(res, {
    type: "response.output_item.added",
    output_index: 0,
    item: outputItem,
  });

  writeSseEvent(res, {
    type: "response.content_part.added",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });

  // -- Helper to emit text deltas -------------------------------------------
  function emitDelta(delta: string) {
    if (closed || !delta) return;
    accumulatedText += delta;
    writeSseEvent(res, {
      type: "response.output_text.delta",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      delta,
    });
  }

  function finish(status: ResponseResource["status"]) {
    if (closed) return;

    const finalText = accumulatedText || "No response from OpenClaw.";

    writeSseEvent(res, {
      type: "response.output_text.done",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      text: finalText,
    });

    writeSseEvent(res, {
      type: "response.content_part.done",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: finalText },
    });

    const completedItem = createAssistantOutputItem({
      id: outputItemId,
      text: finalText,
      status: "completed",
    });

    writeSseEvent(res, {
      type: "response.output_item.done",
      output_index: 0,
      item: completedItem,
    });

    const finalResponse = createResponseResource({
      id: responseId,
      model,
      status,
      output: [completedItem],
    });

    writeSseEvent(res, { type: "response.completed", response: finalResponse });
    writeDone(res);
    res.end();
    closed = true;
  }

  // Register a collector so the outbound adapter can capture any media
  // the agent sends via the `message send` tool during this request.
  const collector = registerOutboundCollector(collectorTo);

  try {
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload: ReplyPayload) => {
          const text = payload.text ?? "";
          if (text && text.length > emittedLength) {
            emitDelta(text.slice(emittedLength));
            emittedLength = text.length;
          }
          const rawUrls = collectMediaUrls(payload);
          console.log(
            `[responses-api] streaming deliver: text=${text.slice(0, 80)}, mediaUrls=${JSON.stringify(rawUrls)}`,
          );
          if (rawUrls.length > 0) {
            const resolved = await resolveMediaUrls(rawUrls, gatewayBaseUrl);
            const media = formatMediaAsMarkdown(resolved);
            if (media) {
              emitDelta(`\n\n${media}`);
            }
          }
        },
        onError: (err: unknown) => {
          core.logging
            .getChildLogger({ channel: CHANNEL_ID })
            .error(`Streaming reply failed: ${String(err)}`);
        },
      },
      replyOptions: {
        onModelSelected,
        onPartialReply: async (payload) => {
          const text = payload.text ?? "";
          if (text.length > emittedLength) {
            emitDelta(text.slice(emittedLength));
            emittedLength = text.length;
          }
          const rawUrls = collectMediaUrls(payload);
          if (rawUrls.length > 0) {
            const resolved = await resolveMediaUrls(rawUrls, gatewayBaseUrl);
            const media = formatMediaAsMarkdown(resolved);
            if (media) {
              emitDelta(`\n\n${media}`);
            }
          }
        },
      },
    });

    // Emit any media captured from the `message send` tool path.
    const captured = collector.drain();
    console.log(
      `[responses-api] streaming collector drained: ${captured.length} items`,
      captured.map((c) => ({ text: c.text?.slice(0, 40), mediaUrl: c.mediaUrl })),
    );
    const capturedMedia = capturedOutboundToMediaUrls(captured);
    if (capturedMedia.length > 0) {
      const resolved = await resolveMediaUrls(capturedMedia, gatewayBaseUrl);
      const media = formatMediaAsMarkdown(resolved);
      if (media) {
        emitDelta(`\n\n${media}`);
      }
    }

    finish("completed");
  } catch (err) {
    if (!closed) {
      emitDelta(`Error: ${String(err)}`);
      finish("failed");
    }
  } finally {
    collector.dispose();
  }

  return true;
}
