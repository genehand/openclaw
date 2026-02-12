// -- Input types (Responses API) --------------------------------------------

export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "text"; text: string }
  | { type: "input_image"; source: unknown }
  | { type: "input_file"; source: unknown };

export type MessageItem = {
  type?: "message";
  role: string;
  content: string | ContentPart[];
};

export type FunctionCallOutputItem = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

export type ItemParam =
  | MessageItem
  | FunctionCallOutputItem
  | { type: string; [key: string]: unknown };

export type CreateResponseBody = {
  model?: unknown;
  input?: unknown;
  instructions?: unknown;
  stream?: unknown;
  user?: unknown;
  previous_response_id?: unknown;
};

export function coerceRequest(val: unknown): CreateResponseBody {
  if (!val || typeof val !== "object") return {};
  return val as CreateResponseBody;
}

// -- Input → prompt conversion (mirrors openresponses-http.ts) --------------

export function extractTextContent(content: string | ContentPart[] | unknown): string {
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
export function buildPromptFromInput(input: unknown): {
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
