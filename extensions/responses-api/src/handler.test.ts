import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleResponsesApiRequest } from "./handler.js";
import { setResponsesApiRuntime } from "./runtime.js";

// Mock createReplyPrefixOptions to avoid deep dependency chain
vi.mock("openclaw/plugin-sdk", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createReplyPrefixOptions: vi.fn(() => ({
      onModelSelected: undefined,
      responsePrefix: undefined,
      responsePrefixContext: undefined,
    })),
    saveMediaSource: vi.fn(async (filePath: string) => ({
      id: `resolved-${filePath.split("/").pop()}`,
      path: `/mock/media/resolved-${filePath.split("/").pop()}`,
      size: 1024,
      contentType: "image/png",
    })),
  };
});

// -- Test helpers -----------------------------------------------------------

function createMockRequest(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost:3000", ...headers };
  (req as { destroy: () => void }).destroy = vi.fn();

  if (body !== undefined) {
    setTimeout(() => {
      req.emit("data", Buffer.from(JSON.stringify(body)));
      req.emit("end");
    }, 5);
  } else {
    setTimeout(() => {
      req.emit("end");
    }, 5);
  }

  return req;
}

function createMockResponse(): ServerResponse & {
  _body: string;
  _headers: Record<string, string>;
} {
  const res = {
    statusCode: 200,
    _body: "",
    _headers: {} as Record<string, string>,
    setHeader: vi.fn((name: string, value: string) => {
      res._headers[name.toLowerCase()] = value;
    }),
    end: vi.fn((data?: string) => {
      if (data) res._body += data;
    }),
    write: vi.fn((data: string) => {
      res._body += data;
      return true;
    }),
    flushHeaders: vi.fn(),
  } as unknown as ServerResponse & {
    _body: string;
    _headers: Record<string, string>;
  };
  return res;
}

const AUTH_TOKEN = "test-secret-token";

function createMockRuntime(overrides?: {
  dispatchResult?: string;
  dispatchError?: Error;
  simulateStreaming?: boolean;
  mediaUrls?: string[];
  partialMediaUrls?: string[];
  tokens?: Record<string, { agentId: string; label?: string }>;
}): PluginRuntime {
  return {
    config: {
      loadConfig: vi.fn(async () => ({
        channels: {
          "responses-api": {
            tokens: overrides?.tokens ?? {
              [AUTH_TOKEN]: { agentId: "main", label: "Test Token" },
            },
          },
        },
      })),
    },
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          sessionKey: "responses-api:default:api-client:main",
          accountId: "default",
        })),
        buildAgentSessionKey: vi.fn(({ agentId, channel, accountId, peer }) =>
          `${channel}:${accountId}:${peer?.id ?? "unknown"}:${agentId}`.toLowerCase(),
        ),
      },
      reply: {
        finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(
          async (params: {
            dispatcherOptions: {
              deliver: (payload: {
                text?: string;
                mediaUrl?: string;
                mediaUrls?: string[];
              }) => Promise<void>;
              onError?: (err: unknown) => void;
            };
            replyOptions?: {
              onPartialReply?: (payload: {
                text?: string;
                mediaUrls?: string[];
              }) => void | Promise<void>;
            };
          }) => {
            if (overrides?.dispatchError) {
              throw overrides.dispatchError;
            }
            const text = overrides?.dispatchResult ?? "Hello from OpenClaw!";

            if (overrides?.simulateStreaming && params.replyOptions?.onPartialReply) {
              let accumulated = "";
              for (const word of text.split(" ")) {
                accumulated += (accumulated ? " " : "") + word;
                params.replyOptions.onPartialReply({ text: accumulated });
              }
              if (overrides?.partialMediaUrls?.length) {
                await params.replyOptions.onPartialReply({
                  text: accumulated,
                  mediaUrls: overrides.partialMediaUrls,
                });
              }
            }

            await params.dispatcherOptions.deliver({
              text,
              mediaUrls: overrides?.mediaUrls,
            });
            return {};
          },
        ),
      },
    },
    logging: {
      getChildLogger: vi.fn(() => ({
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      })),
    },
  } as unknown as PluginRuntime;
}

// -- Helpers for parsing Responses API output --------------------------------

function parseResponseBody(body: string) {
  return JSON.parse(body) as {
    id: string;
    object: string;
    status: string;
    model: string;
    output: Array<{
      type: string;
      id: string;
      role: string;
      content: Array<{ type: string; text: string }>;
      status?: string;
    }>;
    usage: { input_tokens: number; output_tokens: number; total_tokens: number };
    error?: { code: string; message: string };
  };
}

function parseSseEvents(body: string) {
  // SSE events are formatted as: "event: <type>\ndata: <json>\n\n"
  // The [DONE] sentinel is: "data: [DONE]\n\n"
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const lines = body.split("\n");
  let currentEvent: string | undefined;

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7);
    } else if (line.startsWith("data: ")) {
      const data = line.slice(6);
      if (data === "[DONE]") {
        events.push({ type: "[DONE]" });
      } else {
        const parsed = JSON.parse(data);
        events.push({ ...parsed, _eventType: currentEvent });
      }
      currentEvent = undefined;
    }
  }
  return events;
}

// -- Tests ------------------------------------------------------------------

describe("handleResponsesApiRequest", () => {
  beforeEach(() => {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.CLAWDBOT_GATEWAY_PASSWORD;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("URL routing", () => {
    it("returns false for non-matching paths", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest("POST", "/v1/responses");
      const res = createMockResponse();
      const handled = await handleResponsesApiRequest(req, res);
      expect(handled).toBe(false);
    });

    it("returns false for the old chat completions path", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest("POST", "/v1/channel/chat/completions");
      const res = createMockResponse();
      const handled = await handleResponsesApiRequest(req, res);
      expect(handled).toBe(false);
    });

    it("matches the channel responses endpoint", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "hi" }],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      const handled = await handleResponsesApiRequest(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    });
  });

  describe("method validation", () => {
    it("rejects non-POST methods with 405", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest("GET", "/v1/channel/responses");
      const res = createMockResponse();
      const handled = await handleResponsesApiRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(405);
    });
  });

  describe("authentication", () => {
    it("rejects requests without authorization header", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest("POST", "/v1/channel/responses", {
        model: "openclaw",
        input: [{ type: "message", role: "user", content: "hi" }],
      });
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res._body);
      expect(body.error.message).toBe("Unauthorized");
    });

    it("rejects requests with wrong token", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        { model: "openclaw", input: "hi" },
        { authorization: "Bearer wrong-token" },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(401);
    });

    it("accepts requests with valid token", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        { model: "openclaw", input: "hello" },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(200);
    });
  });

  describe("request validation", () => {
    it("rejects requests without user message", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "system", content: "system only" }],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res._body);
      expect(body.error.message).toContain("Missing user message");
    });

    it("rejects invalid JSON body", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = new EventEmitter() as IncomingMessage;
      req.method = "POST";
      req.url = "/v1/channel/responses";
      req.headers = {
        host: "localhost:3000",
        authorization: `Bearer ${AUTH_TOKEN}`,
      };
      setTimeout(() => {
        req.emit("data", Buffer.from("not json"));
        req.emit("end");
      }, 5);

      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res._body);
      expect(body.error.message).toMatch(/JSON/i);
    });

    it("accepts string input", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        { model: "openclaw", input: "what is 2+2?" },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(200);
      const body = parseResponseBody(res._body);
      expect(body.object).toBe("response");
      expect(body.status).toBe("completed");
    });
  });

  describe("non-streaming response", () => {
    it("returns response resource format", async () => {
      const runtime = createMockRuntime({ dispatchResult: "Test response" });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "hello" }],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(200);
      const body = parseResponseBody(res._body);
      expect(body.object).toBe("response");
      expect(body.status).toBe("completed");
      expect(body.id).toMatch(/^resp_/);
      expect(body.output).toHaveLength(1);
      expect(body.output[0].type).toBe("message");
      expect(body.output[0].role).toBe("assistant");
      expect(body.output[0].content[0].type).toBe("output_text");
      expect(body.output[0].content[0].text).toBe("Test response");
      expect(body.output[0].status).toBe("completed");
    });

    it("returns failed status on dispatch error", async () => {
      const runtime = createMockRuntime({
        dispatchError: new Error("Agent failed"),
      });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "hello" }],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(500);
      const body = parseResponseBody(res._body);
      expect(body.status).toBe("failed");
      expect(body.error?.code).toBe("api_error");
    });

    it("includes media URLs as markdown images in content", async () => {
      const runtime = createMockRuntime({
        dispatchResult: "Here is the image",
        mediaUrls: ["https://example.com/photo.jpg"],
      });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "show me a cat" }],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(200);
      const body = parseResponseBody(res._body);
      const content = body.output[0].content[0].text;
      expect(content).toContain("Here is the image");
      expect(content).toContain("![image](https://example.com/photo.jpg)");
    });

    it("resolves local file paths to gateway /media/:id URLs", async () => {
      const runtime = createMockRuntime({
        dispatchResult: "Generated image",
        mediaUrls: ["/tmp/openclaw/generated-image.png"],
      });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "draw a cat" }],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(200);
      const body = parseResponseBody(res._body);
      const content = body.output[0].content[0].text;
      expect(content).toContain(
        "![image](http://localhost:3000/media/outbound/resolved-generated-image.png)",
      );
    });

    it("resolves markdown image refs with local absolute paths in response text", async () => {
      const runtime = createMockRuntime({
        dispatchResult:
          "Here is your bee!\n\n![Bee image](/mnt/user-data/uploads/resp_123/media_456.jpg)",
      });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "draw a bee" }],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(200);
      const body = parseResponseBody(res._body);
      const content = body.output[0].content[0].text;
      expect(content).toContain("Here is your bee!");
      expect(content).toContain(
        "![Bee image](http://localhost:3000/media/outbound/resolved-media_456.jpg)",
      );
      expect(content).not.toContain("/mnt/user-data/uploads");
    });

    it("strips inline MEDIA: tokens from non-streaming response", async () => {
      const runtime = createMockRuntime({
        dispatchResult: "Here is the photo MEDIA:photo.jpg nice right?",
      });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "show photo" }],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(200);
      const body = parseResponseBody(res._body);
      const content = body.output[0].content[0].text;
      expect(content).toContain("Here is the photo");
      expect(content).toContain("nice right?");
      expect(content).not.toContain("MEDIA:");
    });
  });

  describe("streaming response", () => {
    it("emits Responses API SSE events", async () => {
      const runtime = createMockRuntime({ dispatchResult: "Streamed text" });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "hello" }],
          stream: true,
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      const events = parseSseEvents(res._body);

      // Should have: response.created, response.in_progress,
      // response.output_item.added, response.content_part.added,
      // response.output_text.delta (content), response.output_text.done,
      // response.content_part.done, response.output_item.done,
      // response.completed, [DONE]
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("response.created");
      expect(eventTypes).toContain("response.in_progress");
      expect(eventTypes).toContain("response.output_item.added");
      expect(eventTypes).toContain("response.content_part.added");
      expect(eventTypes).toContain("response.output_text.delta");
      expect(eventTypes).toContain("response.output_text.done");
      expect(eventTypes).toContain("response.content_part.done");
      expect(eventTypes).toContain("response.output_item.done");
      expect(eventTypes).toContain("response.completed");
      expect(eventTypes).toContain("[DONE]");
    });

    it("sets correct SSE headers", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "hello" }],
          stream: true,
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res._headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      expect(res._headers["cache-control"]).toBe("no-cache");
    });

    it("streams token-by-token deltas via onPartialReply", async () => {
      const runtime = createMockRuntime({
        dispatchResult: "one two three",
        simulateStreaming: true,
      });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "hello" }],
          stream: true,
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      const events = parseSseEvents(res._body);
      const deltaEvents = events.filter((e) => e.type === "response.output_text.delta");

      expect(deltaEvents.length).toBe(3);
      expect(deltaEvents[0].delta).toBe("one");
      expect(deltaEvents[1].delta).toBe(" two");
      expect(deltaEvents[2].delta).toBe(" three");
    });

    it("does not duplicate text when both onPartialReply and deliver provide content", async () => {
      // This tests the fix for duplicate responses when streaming pauses and resumes.
      // The deliver callback is called with the full text after onPartialReply streams it,
      // but should not emit text again since onPartialReply already handled it.
      const runtime = createMockRuntime({
        dispatchResult: "Hello world test",
        simulateStreaming: true,
      });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "hello" }],
          stream: true,
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      const events = parseSseEvents(res._body);
      const deltaEvents = events.filter((e) => e.type === "response.output_text.delta");

      // Should have exactly 3 delta events (one per word), not 6 (which would indicate duplication)
      expect(deltaEvents.length).toBe(3);

      // Verify the deltas combine to the full text
      const fullText = deltaEvents.map((e) => e.delta).join("");
      expect(fullText).toBe("Hello world test");

      // Verify the final output_text.done event has the correct full text
      const doneEvent = events.find((e) => e.type === "response.output_text.done");
      expect(doneEvent).toBeDefined();
      expect((doneEvent as unknown as { text: string }).text).toBe("Hello world test");
    });

    it("emits completed response with full text in response.completed", async () => {
      const runtime = createMockRuntime({ dispatchResult: "Full reply" });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: "hello",
          stream: true,
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      const events = parseSseEvents(res._body);
      const completedEvent = events.find((e) => e.type === "response.completed");
      expect(completedEvent).toBeDefined();

      const response = completedEvent!.response as {
        status: string;
        output: Array<{
          content: Array<{ text: string }>;
        }>;
      };
      expect(response.status).toBe("completed");
      expect(response.output[0].content[0].text).toBe("Full reply");
    });

    it("includes media URLs in streaming deltas", async () => {
      const runtime = createMockRuntime({
        dispatchResult: "Check this out",
        mediaUrls: ["https://example.com/cat.jpg"],
      });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "show cat" }],
          stream: true,
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res._body).toContain("![image](https://example.com/cat.jpg)");
    });

    it("resolves local file paths in streaming", async () => {
      const runtime = createMockRuntime({
        dispatchResult: "Generated",
        mediaUrls: ["/tmp/openclaw/streamed-image.png"],
      });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "draw" }],
          stream: true,
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res._body).toContain(
        "![image](http://localhost:3000/media/outbound/resolved-streamed-image.png)",
      );
    });

    it("resolves markdown image refs with local paths in streaming final text", async () => {
      const runtime = createMockRuntime({
        dispatchResult:
          "The bee abides!\n\n![Bee image](/mnt/user-data/uploads/resp_abc/media_789.jpg)",
      });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "draw a bee" }],
          stream: true,
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      const events = parseSseEvents(res._body);
      const doneEvent = events.find((e) => e.type === "response.output_text.done");
      expect(doneEvent).toBeDefined();

      const finalText = (doneEvent as unknown as { text: string }).text;
      expect(finalText).toContain("The bee abides!");
      expect(finalText).toContain(
        "![Bee image](http://localhost:3000/media/outbound/resolved-media_789.jpg)",
      );
      expect(finalText).not.toContain("/mnt/user-data/uploads");
    });

    it("strips MEDIA: tokens from streaming text", async () => {
      const runtime = createMockRuntime({
        dispatchResult: "Here is your bee!\n\nMEDIA:media_123.jpg",
      });
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "show bee" }],
          stream: true,
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      const events = parseSseEvents(res._body);
      const doneEvent = events.find((e) => e.type === "response.output_text.done");
      expect(doneEvent).toBeDefined();

      const finalText = (doneEvent as unknown as { text: string }).text;
      expect(finalText).toContain("Here is your bee!");
      expect(finalText).not.toContain("MEDIA:");
    });
  });

  describe("context building", () => {
    it("passes instructions as GroupSystemPrompt", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          instructions: "Be concise.",
          input: [{ type: "message", role: "user", content: "hello" }],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      const finalizeCall = vi.mocked(runtime.channel.reply.finalizeInboundContext).mock.calls[0];
      expect(finalizeCall).toBeDefined();
      const ctxArg = finalizeCall?.[0] as Record<string, unknown>;
      expect(ctxArg.GroupSystemPrompt).toBe("Be concise.");
    });

    it("combines instructions with system messages from input", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          instructions: "Be brief.",
          input: [
            { type: "message", role: "system", content: "You are a helper." },
            { type: "message", role: "user", content: "hello" },
          ],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      const finalizeCall = vi.mocked(runtime.channel.reply.finalizeInboundContext).mock.calls[0];
      const ctxArg = finalizeCall?.[0] as Record<string, unknown>;
      expect(ctxArg.GroupSystemPrompt).toBe("Be brief.\n\nYou are a helper.");
    });

    it("sets CommandAuthorized to true", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "hello" }],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      const finalizeCall = vi.mocked(runtime.channel.reply.finalizeInboundContext).mock.calls[0];
      const ctxArg = finalizeCall?.[0] as Record<string, unknown>;
      expect(ctxArg.CommandAuthorized).toBe(true);
    });

    it("uses user field as peer ID when provided", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "hello" }],
          user: "user-123",
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      const sessionKeyCall = vi.mocked(runtime.channel.routing.buildAgentSessionKey).mock.calls[0];
      expect(sessionKeyCall).toBeDefined();
      const sessionKeyArg = sessionKeyCall?.[0] as Record<string, unknown>;
      expect((sessionKeyArg.peer as { id: string }).id).toBe("user-123");
    });

    it("only sends the last user message as the prompt (not full history)", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      // In Responses API, input contains items but the handler should only
      // extract the last user message -- session history is server-managed.
      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "what is the weather?" }],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      const finalizeCall = vi.mocked(runtime.channel.reply.finalizeInboundContext).mock.calls[0];
      const ctxArg = finalizeCall?.[0] as Record<string, unknown>;
      expect(ctxArg.Body).toBe("what is the weather?");
      expect(ctxArg.CommandBody).toBe("what is the weather?");
    });

    it("handles slash commands in user message", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "/new" }],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      const finalizeCall = vi.mocked(runtime.channel.reply.finalizeInboundContext).mock.calls[0];
      const ctxArg = finalizeCall?.[0] as Record<string, unknown>;
      expect(ctxArg.CommandBody).toBe("/new");
      expect(ctxArg.BodyForCommands).toBe("/new");
    });

    it("accepts input items without explicit type: 'message' (implicit messages)", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      // Items with role + content but no type field should be treated as messages
      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ role: "user", content: "Hi" }],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(200);
      const finalizeCall = vi.mocked(runtime.channel.reply.finalizeInboundContext).mock.calls[0];
      const ctxArg = finalizeCall?.[0] as Record<string, unknown>;
      expect(ctxArg.Body).toBe("Hi");
    });

    it("accepts input items with content as array of content parts", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      // Content can be an array of typed content parts instead of a string
      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "kimi-coding/k2p5",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "Hi" }],
            },
          ],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(200);
      const finalizeCall = vi.mocked(runtime.channel.reply.finalizeInboundContext).mock.calls[0];
      const ctxArg = finalizeCall?.[0] as Record<string, unknown>;
      expect(ctxArg.Body).toBe("Hi");
    });

    it("handles implicit system messages with content arrays", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      const req = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: "Be concise." }],
            },
            {
              role: "user",
              content: [{ type: "input_text", text: "Hello" }],
            },
          ],
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res = createMockResponse();
      await handleResponsesApiRequest(req, res);

      expect(res.statusCode).toBe(200);
      const finalizeCall = vi.mocked(runtime.channel.reply.finalizeInboundContext).mock.calls[0];
      const ctxArg = finalizeCall?.[0] as Record<string, unknown>;
      expect(ctxArg.GroupSystemPrompt).toBe("Be concise.");
      expect(ctxArg.Body).toBe("Hello");
    });

    it("uses previous_response_id to continue existing session", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      // First request: creates a new session
      const req1 = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "hello" }],
          user: "user-123",
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res1 = createMockResponse();
      await handleResponsesApiRequest(req1, res1);

      expect(res1.statusCode).toBe(200);
      const body1 = parseResponseBody(res1._body);
      const firstResponseId = body1.id;

      // Wait for the async store operation to complete
      await new Promise((r) => setTimeout(r, 100));

      // Second request: uses previous_response_id to continue the same session
      const req2 = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "follow up" }],
          previous_response_id: firstResponseId,
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res2 = createMockResponse();
      await handleResponsesApiRequest(req2, res2);

      expect(res2.statusCode).toBe(200);
      const finalizeCalls = vi.mocked(runtime.channel.reply.finalizeInboundContext).mock.calls;
      const ctx1 = finalizeCalls[0]?.[0] as Record<string, unknown>;
      const ctx2 = finalizeCalls[1]?.[0] as Record<string, unknown>;

      // Both requests should use the same session key (derived from first response)
      expect(ctx1.SessionKey).toBe(ctx2.SessionKey);
      expect(ctx2.SessionKey).toBe(`agent:main:responses-api:${firstResponseId}`);
    });

    it("chains multiple responses in the same session", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      // Request 1: Start session
      const req1 = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "message 1" }],
          user: "user-456",
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res1 = createMockResponse();
      await handleResponsesApiRequest(req1, res1);
      const body1 = parseResponseBody(res1._body);

      // Wait for the async store operation to complete
      await new Promise((r) => setTimeout(r, 100));

      // Request 2: Continue with previous_response_id
      const req2 = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "message 2" }],
          previous_response_id: body1.id,
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res2 = createMockResponse();
      await handleResponsesApiRequest(req2, res2);
      const body2 = parseResponseBody(res2._body);

      // Wait for the async store operation to complete
      await new Promise((r) => setTimeout(r, 100));

      // Request 3: Continue with the new previous_response_id
      const req3 = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "message 3" }],
          previous_response_id: body2.id,
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res3 = createMockResponse();
      await handleResponsesApiRequest(req3, res3);

      const finalizeCalls = vi.mocked(runtime.channel.reply.finalizeInboundContext).mock.calls;
      const sessionKey1 = (finalizeCalls[0]?.[0] as Record<string, unknown>).SessionKey;
      const sessionKey2 = (finalizeCalls[1]?.[0] as Record<string, unknown>).SessionKey;
      const sessionKey3 = (finalizeCalls[2]?.[0] as Record<string, unknown>).SessionKey;

      // All three requests should use the same session key
      expect(sessionKey1).toBe(sessionKey2);
      expect(sessionKey2).toBe(sessionKey3);
    });

    it("creates unique session for each request without previous_response_id", async () => {
      const runtime = createMockRuntime();
      setResponsesApiRuntime(runtime);

      // First request
      const req1 = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "hello" }],
          user: "user-123",
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res1 = createMockResponse();
      await handleResponsesApiRequest(req1, res1);

      // Second request (same user, no previous_response_id)
      const req2 = createMockRequest(
        "POST",
        "/v1/channel/responses",
        {
          model: "openclaw",
          input: [{ type: "message", role: "user", content: "hello again" }],
          user: "user-123",
        },
        { authorization: `Bearer ${AUTH_TOKEN}` },
      );
      const res2 = createMockResponse();
      await handleResponsesApiRequest(req2, res2);

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);

      const body1 = parseResponseBody(res1._body);
      const body2 = parseResponseBody(res2._body);

      const finalizeCalls = vi.mocked(runtime.channel.reply.finalizeInboundContext).mock.calls;
      const sessionKey1 = (finalizeCalls[0]?.[0] as Record<string, unknown>).SessionKey;
      const sessionKey2 = (finalizeCalls[1]?.[0] as Record<string, unknown>).SessionKey;

      // Each request should have a unique session key based on its response ID
      expect(sessionKey1).toBe(`agent:main:responses-api:${body1.id}`);
      expect(sessionKey2).toBe(`agent:main:responses-api:${body2.id}`);
      expect(sessionKey1).not.toBe(sessionKey2);
    });
  });
});
