import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_ACCOUNT_ID,
  createReplyPrefixOptions,
  isSilentReplyText,
  readJsonBody,
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
import { coerceRequest, buildPromptFromInput, extractAttachmentsFromInput } from "./input.js";
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
import { lookupSessionKey, storeSessionMapping } from "./session-store.js";

// -- Constants --------------------------------------------------------------

const ENDPOINT_PATH = "/v1/channel/responses";
const CHANNEL_ID = "responses-api";
const MAX_BODY_BYTES = 20 * 1024 * 1024;

// -- Media helpers (outbound collector) -------------------------------------

/** Extract media URLs from outbound payloads captured by the collector. */
function capturedOutboundToMediaUrls(captured: CapturedOutbound[]): string[] {
  return captured.flatMap((c) => (c.mediaUrl ? [c.mediaUrl] : []));
}

// -- Session tracking for Responses API -------------------------------------

/**
 * Resolve session key for the request, using previous_response_id if provided
 * to maintain conversation continuity.
 *
 * In the Responses API:
 * - First message: no previous_response_id → creates new session
 * - Follow-up: includes previous_response_id → continues that session
 * - Each response gets a new unique ID that can be used for the next turn
 *
 * Session mappings are persisted to disk to survive gateway restarts.
 */
async function resolveSessionKey(params: {
  routeSessionKey: string;
  previousResponseId: string | undefined;
  responseId: string;
  agentId: string;
}): Promise<string> {
  // If client provided previous_response_id, look up the session key
  // from the persisted store to continue the conversation.
  if (params.previousResponseId) {
    const sessionKey = lookupSessionKey(params.previousResponseId, params.agentId);
    if (sessionKey) {
      return sessionKey;
    }
    // If not found (expired, invalid, or after restart), fall through to create new session
  }

  // No previous_response_id or not found: create a NEW unique session
  // Each response gets its own session key - they only share history
  // when explicitly linked via previous_response_id
  // Use agent-prefixed format so getReplyFromConfig can extract the correct agentId
  return `agent:${params.agentId}:responses-api:${params.responseId}`;
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
  try {
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
    const authResult = authorize(bearerToken, cfg as Record<string, unknown>);
    if (!authResult.authorized) {
      sendUnauthorized(res);
      return true;
    }
    // agentId is determined by the token used for authentication
    const tokenAgentId = authResult.agentId;

    // -- Parse request --------------------------------------------------------

    // Check Content-Length header before reading body to give proper error response
    const contentLength = req.headers["content-length"];
    const declaredLength =
      typeof contentLength === "string" ? Number.parseInt(contentLength, 10) : null;
    if (declaredLength !== null && declaredLength > MAX_BODY_BYTES) {
      console.log(
        `[responses] Payload too large: ${declaredLength} bytes (max: ${MAX_BODY_BYTES})`,
      );
      // Drain the request body to prevent client "broken pipe" errors
      req.on("data", () => {});
      await new Promise<void>((resolve) => {
        req.on("end", resolve);
        req.on("close", resolve);
      });
      sendJson(res, 413, {
        error: {
          message: `Payload too large: ${declaredLength} bytes (max: ${MAX_BODY_BYTES})`,
          type: "invalid_request_error",
          code: "payload_too_large",
        },
      });
      return true;
    }

    let bodyResult;
    try {
      bodyResult = await readJsonBody(req, MAX_BODY_BYTES);
    } catch (err) {
      sendJson(res, 500, { error: { message: "Error reading request body", type: "api_error" } });
      return true;
    }
    if (!bodyResult.ok) {
      // Check if it's a payload too large error
      if (
        bodyResult.error?.toLowerCase().includes("payload too large") ||
        bodyResult.error?.toLowerCase().includes("payloadtoolarge")
      ) {
        sendJson(res, 413, {
          error: {
            message: bodyResult.error,
            type: "invalid_request_error",
            code: "payload_too_large",
          },
        });
      } else {
        sendJson(res, 400, { error: { message: bodyResult.error, type: "invalid_request_error" } });
      }
      return true;
    }

    const payload = coerceRequest(bodyResult.value);
    // console.log(
    //   `[responses] Parsed request: stream=${payload.stream}, model=${payload.model}, has input=${!!payload.input}`,
    // );
    const stream = Boolean(payload.stream);
    const model = typeof payload.model === "string" ? payload.model : "openclaw";
    const user = typeof payload.user === "string" ? payload.user : undefined;
    const instructions =
      typeof payload.instructions === "string" ? payload.instructions : undefined;
    const previousResponseId =
      typeof payload.previous_response_id === "string" ? payload.previous_response_id : undefined;

    // agentId is determined by the auth token, not from the request model
    const agentId = tokenAgentId;
    const prompt = buildPromptFromInput(payload.input);

    // Extract images and files from input attachments
    const { images, fileContexts } = await extractAttachmentsFromInput(payload.input);
    // console.log(
    //   `[responses] Extraction complete: ${images.length} images, ${fileContexts.length} files`,
    // );

    if (!prompt.message) {
      sendJson(res, 400, {
        error: { message: "Missing user message in `input`.", type: "invalid_request_error" },
      });
      return true;
    }

    // Combine instructions with any system prompt from input, plus file contexts
    const extraSystemPrompt = [instructions, prompt.extraSystemPrompt, fileContexts.join("\n\n")]
      .filter(Boolean)
      .join("\n\n");

    const responseId = `resp_${randomUUID()}`;
    const outputItemId = `msg_${randomUUID()}`;
    const peerId = user ?? "api-client";

    // -- Build session key with token's agentId (bypass routing bindings) -----
    // The session key must contain the correct agentId so getReplyFromConfig
    // can resolve the right agent from the session key.
    const baseSessionKey = runtime.channel.routing.buildAgentSessionKey({
      agentId,
      channel: CHANNEL_ID,
      accountId: DEFAULT_ACCOUNT_ID,
      peer: { kind: "direct", id: peerId },
    });

    // -- Resolve session key (with previous_response_id support) --------------
    const sessionKey = await resolveSessionKey({
      routeSessionKey: baseSessionKey,
      previousResponseId,
      responseId,
      agentId,
    });

    // Store mapping so future requests with this response ID can continue the session
    // This is fire-and-forget - we don't wait for it to complete
    void storeSessionMapping(responseId, sessionKey, agentId);

    // -- Build MsgContext -----------------------------------------------------
    const ctx = runtime.channel.reply.finalizeInboundContext({
      Body: prompt.message,
      RawBody: prompt.message,
      CommandBody: prompt.lastUserMessage,
      BodyForAgent: prompt.message,
      BodyForCommands: prompt.lastUserMessage,
      From: `${CHANNEL_ID}:${peerId}`,
      To: `${CHANNEL_ID}:api`,
      SessionKey: sessionKey,
      AccountId: DEFAULT_ACCOUNT_ID,
      ChatType: "direct",
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      SenderName: user ?? "API",
      CommandAuthorized: true,
      MessageSid: responseId,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: `${CHANNEL_ID}:api`,
      GroupSystemPrompt: extraSystemPrompt || undefined,
    });

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId,
      channel: CHANNEL_ID,
      accountId: DEFAULT_ACCOUNT_ID,
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
        images,
        agentId,
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
      images,
      agentId,
    });
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: "Internal server error", type: "api_error" } });
    }
    return true;
  }
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
  images?: { type: "image"; data: string; mimeType: string }[];
  agentId?: string;
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
    images,
    agentId,
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
      replyOptions: { onModelSelected, images },
    });

    // Filter out silent replies (e.g., NO_REPLY)
    const filteredPayloads = payloads.filter((p) => !isSilentReplyText(p.text, SILENT_REPLY_TOKEN));

    // Merge any media captured from the `message send` tool path.
    const captured = collector.drain();
    const capturedMedia = capturedOutboundToMediaUrls(captured);

    const contentParts =
      filteredPayloads.length > 0
        ? (
            await Promise.all(
              filteredPayloads.map((p) => payloadToContent(p, gatewayBaseUrl, cfg, agentId)),
            )
          ).filter(Boolean)
        : [];

    // Append captured media as markdown images.
    if (capturedMedia.length > 0) {
      const resolved = await resolveMediaUrls(capturedMedia, gatewayBaseUrl, cfg, agentId);
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
  images?: { type: "image"; data: string; mimeType: string }[];
  agentId?: string;
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
    images,
    agentId,
  } = params;

  setSseHeaders(res);

  let closed = false;
  let accumulatedText = "";
  let accumulatedStrippedLength = 0;
  let silentReplyDetected = false;
  let pendingBuffer = ""; // Buffer text that could become a silent reply
  const gatewayBaseUrl = deriveGatewayBaseUrl(req);

  // Helper: check if text could potentially become a silent reply (prefix match)
  function couldBecomeSilentReply(text: string): boolean {
    const token = SILENT_REPLY_TOKEN; // "NO_REPLY"
    // Check if text is a prefix of the token, or token is a prefix of text
    // This handles cases like: "", "N", "NO", "NO_", etc.
    const textTrimmed = text.trim().toUpperCase();
    const tokenUpper = token.toUpperCase();

    // If text is empty or whitespace, it could become anything
    if (!textTrimmed) return true;

    // If text is a prefix of token, or token is a prefix of text
    if (tokenUpper.startsWith(textTrimmed) || textTrimmed.startsWith(tokenUpper)) {
      return true;
    }

    return false;
  }

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
    if (closed || !delta || silentReplyDetected) return;
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

          // Check if this is definitely a silent reply - if so, discard buffer and suppress
          if (isSilentReplyText(rawText, SILENT_REPLY_TOKEN)) {
            silentReplyDetected = true;
            pendingBuffer = ""; // Discard any buffered text
            return;
          }

          // Store the latest raw cumulative text (payloads are cumulative, don't append)
          accumulatedText = rawText;

          // Check if text could still become a silent reply - if so, buffer but don't emit yet
          if (couldBecomeSilentReply(rawText)) {
            // Buffer the text instead of emitting
            pendingBuffer = stripMediaTokens(rawText);
            accumulatedStrippedLength = pendingBuffer.length;
            return;
          }

          // Text is confirmed NOT to be a silent reply - flush buffer and emit
          const rawUrls = collectMediaUrls(payload);
          // Extract and resolve MEDIA: tokens inline to emit as markdown
          if (rawUrls.length > 0) {
            const resolved = await resolveMediaUrls(rawUrls, gatewayBaseUrl, cfg, agentId);
            const media = formatMediaAsMarkdown(resolved);
            if (media) {
              emitDelta(`\n\n${media}`);
            }
          }
          // Emit non-media text (with MEDIA: tokens stripped) incrementally
          const text = stripMediaTokens(rawText);
          if (text) {
            // If we have pending buffer, emit from the start of buffer
            // Otherwise just emit the delta
            const startIndex = pendingBuffer ? 0 : accumulatedStrippedLength;
            if (text.length > startIndex) {
              emitDelta(text.slice(startIndex));
            }
            accumulatedStrippedLength = text.length;
            pendingBuffer = ""; // Clear buffer after emitting
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
        images,
        onPartialReply: async (payload) => {
          const rawText = payload.text ?? "";

          // Check if this is definitely a silent reply - if so, discard buffer and suppress
          if (isSilentReplyText(rawText, SILENT_REPLY_TOKEN)) {
            silentReplyDetected = true;
            pendingBuffer = ""; // Discard any buffered text
            return;
          }

          // Store the latest raw cumulative text (payloads are cumulative, don't append)
          accumulatedText = rawText;

          // Check if text could still become a silent reply - if so, buffer but don't emit yet
          if (couldBecomeSilentReply(rawText)) {
            // Buffer the text instead of emitting
            pendingBuffer = stripMediaTokens(rawText);
            accumulatedStrippedLength = pendingBuffer.length;
            return;
          }

          // Text is confirmed NOT to be a silent reply - flush buffer and emit
          const rawUrls = collectMediaUrls(payload);
          // Extract and resolve MEDIA: tokens inline to emit as markdown
          if (rawUrls.length > 0) {
            const resolved = await resolveMediaUrls(rawUrls, gatewayBaseUrl, cfg, agentId);
            const media = formatMediaAsMarkdown(resolved);
            if (media) {
              emitDelta(`\n\n${media}`);
            }
          }
          // Emit non-media text (with MEDIA: tokens stripped) incrementally
          const text = stripMediaTokens(rawText);
          if (text) {
            // If we have pending buffer, emit from the start of buffer
            // Otherwise just emit the delta
            const startIndex = pendingBuffer ? 0 : accumulatedStrippedLength;
            if (text.length > startIndex) {
              emitDelta(text.slice(startIndex));
            }
            accumulatedStrippedLength = text.length;
            pendingBuffer = ""; // Clear buffer after emitting
          }
        },
      },
    });

    // Emit any media captured from the `message send` tool path.
    const captured = collector.drain();
    const capturedMedia = capturedOutboundToMediaUrls(captured);

    // Extract leftover MEDIA: tokens (absolute paths the core filter rejected)
    // from the accumulated streamed text.
    const leftover = await extractLeftoverMediaTokens(
      accumulatedText,
      gatewayBaseUrl,
      cfg,
      agentId,
    );

    // Resolve raw captured media URLs (from message send tool) via saveMediaSource
    const resolvedCaptured =
      capturedMedia.length > 0
        ? await resolveMediaUrls(capturedMedia, gatewayBaseUrl, cfg, agentId)
        : [];
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
    const resolvedFinalText = await resolveLocalMarkdownImages(
      leftover.text,
      gatewayBaseUrl,
      cfg,
      agentId,
    );

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
