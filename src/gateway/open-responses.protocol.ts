/**
 * OpenResponses Protocol Helpers
 *
 * Shared builders, SSE emission helpers, and utility functions for the
 * OpenResponses `/v1/responses` protocol.  Both the core handler
 * (`openresponses-http.ts`) and the channel extension (`responses-api`)
 * import from this module so the protocol surface stays in sync.
 *
 * Types are re-exported from `open-responses.schema.ts` — this module
 * adds only runtime helpers (no Zod dependency).
 */

import type { ServerResponse } from "node:http";
import type { ContentPart, OutputItem, ResponseResource, Usage } from "./open-responses.schema.js";
import { writeSseEvent } from "./http-common.js";

// Re-export the types so consumers can get everything from one import.
export type { ContentPart, OutputItem, ResponseResource, Usage };

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Create a zero-usage record. */
export function createEmptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

/** Build a full `ResponseResource` envelope. */
export function createResponseResource(params: {
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

/** Build a `message`-type output item with `output_text` content. */
export function createAssistantOutputItem(params: {
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

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

/** Extract text from a string-or-ContentPart[] field. */
export function extractTextContent(content: string | ContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === "input_text") {
        return part.text;
      }
      if (part.type === "output_text") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// SSE streaming helpers
//
// Thin wrappers that pair writeSseEvent with the correct event shapes
// defined in the Responses API spec.  Using these instead of inline
// writeSseEvent calls prevents the two handlers from drifting.
// ---------------------------------------------------------------------------

/** Emit `response.created` + `response.in_progress`. */
export function emitResponseStart(res: ServerResponse, response: ResponseResource): void {
  writeSseEvent(res, { type: "response.created", response });
  writeSseEvent(res, { type: "response.in_progress", response });
}

/** Emit `response.output_item.added` for a new output item. */
export function emitOutputItemAdded(
  res: ServerResponse,
  params: { outputIndex: number; item: OutputItem },
): void {
  writeSseEvent(res, {
    type: "response.output_item.added",
    output_index: params.outputIndex,
    item: params.item,
  });
}

/** Emit `response.content_part.added` for the first content part. */
export function emitContentPartAdded(
  res: ServerResponse,
  params: { itemId: string; outputIndex: number; contentIndex: number },
): void {
  writeSseEvent(res, {
    type: "response.content_part.added",
    item_id: params.itemId,
    output_index: params.outputIndex,
    content_index: params.contentIndex,
    part: { type: "output_text", text: "" },
  });
}

/** Emit a `response.output_text.delta`. */
export function emitTextDelta(
  res: ServerResponse,
  params: { itemId: string; outputIndex: number; contentIndex: number; delta: string },
): void {
  writeSseEvent(res, {
    type: "response.output_text.delta",
    item_id: params.itemId,
    output_index: params.outputIndex,
    content_index: params.contentIndex,
    delta: params.delta,
  });
}

/** Emit the full completion sequence: text done → content part done → item done → response completed. */
export function emitResponseCompleted(
  res: ServerResponse,
  params: {
    response: ResponseResource;
    itemId: string;
    outputIndex: number;
    contentIndex: number;
    text: string;
    completedItem: OutputItem;
  },
): void {
  writeSseEvent(res, {
    type: "response.output_text.done",
    item_id: params.itemId,
    output_index: params.outputIndex,
    content_index: params.contentIndex,
    text: params.text,
  });

  writeSseEvent(res, {
    type: "response.content_part.done",
    item_id: params.itemId,
    output_index: params.outputIndex,
    content_index: params.contentIndex,
    part: { type: "output_text", text: params.text },
  });

  writeSseEvent(res, {
    type: "response.output_item.done",
    output_index: params.outputIndex,
    item: params.completedItem,
  });

  writeSseEvent(res, { type: "response.completed", response: params.response });
}
