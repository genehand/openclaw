import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_ACCOUNT_ID,
  createReplyPrefixOptions,
  isSilentReplyText,
  readJsonBody,
  resolveAgentIdForRequest,
  sendJson,
  sendMethodNotAllowed,
  sendUnauthorized,
  setSseHeaders,
  SILENT_REPLY_TOKEN,
  writeDone,
  writeSseEvent,
  type OpenClawConfig,
  type PluginRuntime,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { authorize, getBearerToken } from "./auth.js";
import { coerceRequest, buildPromptFromInput } from "./input.js";
import {
  deriveGatewayBaseUrl,
  resolveMediaUrls,
  extractLeftoverMediaTokens,
  stripMediaTokens,
  resolveLocalMarkdownImages,
  collectMediaUrls,
  formatMediaAsMarkdown,
  payloadToContent,
} from "./media.js";
import { registerOutboundCollector, type CapturedOutbound } from "./outbound.js";
import {
  createResponseResource,
  createAssistantOutputItem,
  type ResponseResource,
} from "./response.js";
import { getResponsesApiRuntime } from "./runtime.js";

// -- Constants --------------------------------------------------------------

const ENDPOINT_PATH = "/v1/channel/responses";
const CHANNEL_ID = "responses-api";
const MAX_BODY_BYTES = 20 * 1024 * 1024;

// -- Media helpers (outbound collector) -------------------------------------

/** Extract media URLs from outbound payloads captured by the collector. */
function capturedOutboundToMediaUrls(captured: CapturedOutbound[]): string[] {
  return captured.flatMap((c) => (c.mediaUrl ? [c.mediaUrl] : []));
}

// -- Main handler -----------------------------------------------------------

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

  const agentId = resolveAgentIdForRequest({ req, model });
  const prompt = buildPromptFromInput(payload.input);

  if (!prompt.message) {
    sendJson(res, 400, {
      error: { message: "Missing user message in `input`.", type: "invalid_request_error" },
    });
    return true;
  }

  // Combine instructions with any system prompt from input.
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

    // Filter out silent replies (e.g., NO_REPLY)
    const filteredPayloads = payloads.filter((p) => !isSilentReplyText(p.text, SILENT_REPLY_TOKEN));

    // Merge any media captured from the `message send` tool path.
    const captured = collector.drain();
    const capturedMedia = capturedOutboundToMediaUrls(captured);

    const contentParts =
      filteredPayloads.length > 0
        ? (
            await Promise.all(filteredPayloads.map((p) => payloadToContent(p, gatewayBaseUrl)))
          ).filter(Boolean)
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

  function finish(status: ResponseResource["status"], resolvedText?: string) {
    if (closed) return;

    const finalText = resolvedText || accumulatedText || "No response from OpenClaw.";

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
          const rawText = payload.text ?? "";
          // Skip silent replies (e.g., NO_REPLY)
          if (isSilentReplyText(rawText, SILENT_REPLY_TOKEN)) {
            return;
          }
          const text = stripMediaTokens(rawText);
          const rawUrls = collectMediaUrls(payload);
          if (text && text.length > emittedLength) {
            emitDelta(text.slice(emittedLength));
            emittedLength = text.length;
          }
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
          const rawText = payload.text ?? "";
          // Skip silent replies (e.g., NO_REPLY)
          if (isSilentReplyText(rawText, SILENT_REPLY_TOKEN)) {
            return;
          }
          const text = stripMediaTokens(rawText);
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
    const capturedMedia = capturedOutboundToMediaUrls(captured);

    // Extract leftover MEDIA: tokens (absolute paths the core filter rejected)
    // from the accumulated streamed text.
    const leftover = await extractLeftoverMediaTokens(accumulatedText, gatewayBaseUrl);

    // Resolve raw captured media URLs (from message send tool) via saveMediaSource
    const resolvedCaptured =
      capturedMedia.length > 0 ? await resolveMediaUrls(capturedMedia, gatewayBaseUrl) : [];
    // leftover.mediaUrls are already resolved gateway URLs
    const allMedia = [...resolvedCaptured, ...leftover.mediaUrls];

    if (allMedia.length > 0) {
      const media = formatMediaAsMarkdown(allMedia);
      if (media) {
        emitDelta(`\n\n${media}`);
      }
    }

    // Resolve markdown image refs with local absolute paths (e.g. ![alt](/mnt/...))
    // in the accumulated text. The deltas already went out with local paths,
    // but the final `response.output_text.done` event carries the resolved text
    // so clients that read the final event get working URLs.
    const resolvedFinalText = await resolveLocalMarkdownImages(accumulatedText, gatewayBaseUrl);

    finish("completed", resolvedFinalText);
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
