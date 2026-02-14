// -- Input types (Responses API) --------------------------------------------

export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "text"; text: string }
  | { type: "input_image"; source: unknown }
  | { type: "input_file"; source: unknown };

/** Image content for multimodal messages (matches core ImageContent). */
export type ExtractedImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

/** File extraction result with optional text content and rendered images. */
export type ExtractedFileContent = {
  filename: string;
  text?: string;
  images?: ExtractedImageContent[];
};

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

// -- Attachment extraction --------------------------------------------------

const DEFAULT_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const DEFAULT_FILE_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/json",
  "application/pdf",
]);
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB
const DEFAULT_MAX_FILE_CHARS = 2_000_000; // 2M chars

function normalizeMimeType(mediaType: string | undefined): string | undefined {
  if (!mediaType) return undefined;
  const normalized = mediaType.toLowerCase().trim();
  // Handle common aliases
  if (normalized === "image/jpg") return "image/jpeg";
  if (normalized === "text/x-markdown") return "text/markdown";
  return normalized;
}

async function fetchWithTimeout(
  url: string,
  opts: { maxBytes: number; timeoutMs: number },
): Promise<{ buffer: Buffer; mimeType: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const mimeType = contentType.split(";")[0].trim();

    // Stream and limit the response size
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalLength += value.length;
      if (totalLength > opts.maxBytes) {
        throw new Error(`Content exceeds max size of ${opts.maxBytes} bytes`);
      }
      chunks.push(value);
    }

    // Concatenate chunks
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { buffer, mimeType };
  } finally {
    clearTimeout(timeout);
  }
}

async function extractImageFromSource(
  source: {
    type?: string;
    url?: string;
    data?: string;
    media_type?: string;
  },
  opts?: { maxBytes?: number },
): Promise<ExtractedImageContent> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const sourceType = source.type === "base64" || source.type === "url" ? source.type : undefined;

  if (!sourceType) {
    throw new Error("input_image must have source.type of 'base64' or 'url'");
  }

  if (sourceType === "base64") {
    if (!source.data) {
      throw new Error("input_image base64 source missing 'data' field");
    }
    const mimeType = normalizeMimeType(source.media_type) || "image/png";
    if (!DEFAULT_IMAGE_MIMES.has(mimeType)) {
      throw new Error(`Unsupported image MIME type: ${mimeType}`);
    }
    const buffer = Buffer.from(source.data, "base64");
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Image too large: ${buffer.byteLength} bytes (limit: ${maxBytes})`);
    }
    return { type: "image", data: source.data, mimeType };
  }

  // URL source
  if (!source.url) {
    throw new Error("input_image URL source missing 'url' field");
  }

  const result = await fetchWithTimeout(source.url, { maxBytes, timeoutMs: 30000 });
  const mimeType = normalizeMimeType(result.mimeType) || "image/png";

  if (!DEFAULT_IMAGE_MIMES.has(mimeType)) {
    throw new Error(`Unsupported image MIME type from URL: ${mimeType}`);
  }

  return {
    type: "image",
    data: result.buffer.toString("base64"),
    mimeType,
  };
}

async function extractFileFromSource(
  source: {
    type?: string;
    url?: string;
    data?: string;
    media_type?: string;
    filename?: string;
  },
  opts?: { maxBytes?: number; maxChars?: number },
): Promise<ExtractedFileContent> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_FILE_CHARS;
  const filename = source.filename || "file";

  const sourceType = source.type === "base64" || source.type === "url" ? source.type : undefined;
  if (!sourceType) {
    throw new Error("input_file must have source.type of 'base64' or 'url'");
  }

  let buffer: Buffer;
  let mimeType: string;

  if (sourceType === "base64") {
    if (!source.data) {
      throw new Error("input_file base64 source missing 'data' field");
    }
    mimeType = normalizeMimeType(source.media_type) || "application/octet-stream";
    buffer = Buffer.from(source.data, "base64");
  } else {
    // URL source
    if (!source.url) {
      throw new Error("input_file URL source missing 'url' field");
    }
    const result = await fetchWithTimeout(source.url, { maxBytes, timeoutMs: 30000 });
    buffer = result.buffer;
    mimeType = normalizeMimeType(result.mimeType) || "application/octet-stream";
  }

  if (buffer.byteLength > maxBytes) {
    throw new Error(`File too large: ${buffer.byteLength} bytes (limit: ${maxBytes})`);
  }

  if (!DEFAULT_FILE_MIMES.has(mimeType)) {
    throw new Error(`Unsupported file MIME type: ${mimeType}`);
  }

  // Handle PDFs specially - return placeholder (PDF to image conversion would require pdfjs-dist)
  if (mimeType === "application/pdf") {
    return {
      filename,
      text: "[PDF content - PDF extraction not implemented]",
    };
  }

  // Text files - decode and truncate if needed
  const text = buffer.toString("utf-8");
  const truncated = text.length > maxChars ? text.slice(0, maxChars) + "\n[truncated]" : text;

  return { filename, text: truncated };
}

/**
 * Parse a data URL and extract the mime type and base64 data.
 * Format: data:<mime>;base64,<data>
 */
function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/**
 * Extract image from OpenAI Responses API format.
 * Supports both image_url (data URI or URL) and legacy source format.
 */
async function extractImageFromPart(
  part: { image_url?: string; source?: unknown },
  opts?: { maxBytes?: number },
): Promise<ExtractedImageContent> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  // Handle image_url format (official OpenAI Responses API)
  if (part.image_url) {
    const imageUrl = part.image_url;

    // Check if it's a data URL
    const dataUrlMatch = parseDataUrl(imageUrl);
    if (dataUrlMatch) {
      const { mimeType, data } = dataUrlMatch;
      if (!DEFAULT_IMAGE_MIMES.has(mimeType)) {
        throw new Error(`Unsupported image MIME type: ${mimeType}`);
      }
      const buffer = Buffer.from(data, "base64");
      if (buffer.byteLength > maxBytes) {
        throw new Error(`Image too large: ${buffer.byteLength} bytes (limit: ${maxBytes})`);
      }
      return { type: "image", data, mimeType };
    }

    // It's a regular URL - fetch it
    const result = await fetchWithTimeout(imageUrl, { maxBytes, timeoutMs: 30000 });
    const mimeType = normalizeMimeType(result.mimeType) || "image/png";
    if (!DEFAULT_IMAGE_MIMES.has(mimeType)) {
      throw new Error(`Unsupported image MIME type from URL: ${mimeType}`);
    }
    return {
      type: "image",
      data: result.buffer.toString("base64"),
      mimeType,
    };
  }

  // Handle legacy source format (for backward compatibility)
  if (part.source) {
    return extractImageFromSource(
      part.source as Parameters<typeof extractImageFromSource>[0],
      opts,
    );
  }

  throw new Error("input_image must have 'image_url' or 'source' field");
}

/**
 * Extract file from OpenAI Responses API format.
 * Supports file_url, file_data (base64), or legacy source format.
 */
async function extractFileFromPart(
  part: {
    file_url?: string;
    file_data?: string;
    filename?: string;
    source?: { type?: string; url?: string; data?: string; media_type?: string; filename?: string };
  },
  opts?: { maxBytes?: number; maxChars?: number },
): Promise<ExtractedFileContent> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_FILE_CHARS;
  const filename = part.filename || "file";

  let buffer: Buffer;
  let mimeType: string;

  // Handle file_data (base64) format
  if (part.file_data) {
    mimeType = "application/octet-stream";
    buffer = Buffer.from(part.file_data, "base64");
  }
  // Handle file_url format
  else if (part.file_url) {
    const dataUrlMatch = parseDataUrl(part.file_url);
    if (dataUrlMatch) {
      mimeType = dataUrlMatch.mimeType;
      buffer = Buffer.from(dataUrlMatch.data, "base64");
    } else {
      // Regular URL
      const result = await fetchWithTimeout(part.file_url, { maxBytes, timeoutMs: 30000 });
      buffer = result.buffer;
      mimeType = normalizeMimeType(result.mimeType) || "application/octet-stream";
    }
  }
  // Handle legacy source format
  else if (part.source) {
    const src = part.source;
    return extractFileFromSource(
      {
        type: src.type === "base64" || src.type === "url" ? src.type : "base64",
        url: src.url,
        data: src.data,
        media_type: src.media_type,
        filename: src.filename || filename,
      },
      { maxBytes, maxChars },
    );
  } else {
    throw new Error("input_file must have 'file_url', 'file_data', or 'source' field");
  }

  if (buffer.byteLength > maxBytes) {
    throw new Error(`File too large: ${buffer.byteLength} bytes (limit: ${maxBytes})`);
  }

  if (!DEFAULT_FILE_MIMES.has(mimeType)) {
    throw new Error(`Unsupported file MIME type: ${mimeType}`);
  }

  // Handle PDFs specially
  if (mimeType === "application/pdf") {
    return {
      filename,
      text: "[PDF content - PDF extraction not implemented]",
    };
  }

  // Text files - decode and truncate if needed
  const text = buffer.toString("utf-8");
  const truncated = text.length > maxChars ? text.slice(0, maxChars) + "\n[truncated]" : text;

  return { filename, text: truncated };
}

/**
 * Extract images and files from the OpenResponses input array.
 * Returns extracted images and file contexts for injection into the prompt.
 */
export async function extractAttachmentsFromInput(input: unknown): Promise<{
  images: ExtractedImageContent[];
  fileContexts: string[];
}> {
  const images: ExtractedImageContent[] = [];
  const fileContexts: string[] = [];

  console.log(
    `[responses] extractAttachmentsFromInput called, input is array: ${Array.isArray(input)}`,
  );

  if (!Array.isArray(input)) {
    console.log("[responses] Input is not an array, returning empty");
    return { images, fileContexts };
  }

  console.log(`[responses] Processing ${input.length} input items`);

  for (const item of input) {
    // OpenAI Responses API spec uses role field (user, assistant, system, developer)
    const hasRole = "role" in item;
    console.log(
      `[responses] Processing item role: ${item?.role}, has content: ${!!item?.content}, content type: ${typeof item?.content}`,
    );

    if (!hasRole || typeof item.content === "string") {
      console.log("[responses] Skipping item - no role field or content is string");
      continue;
    }

    const contentParts = item.content as ContentPart[];
    console.log(`[responses] Processing ${contentParts.length} content parts`);

    for (const part of contentParts) {
      console.log(`[responses] Processing part type: ${part.type}`);

      if (part.type === "input_image") {
        console.log("[responses] Found input_image, extracting...");
        try {
          const image = await extractImageFromPart(
            part as { image_url?: string; source?: unknown },
          );
          console.log(
            `[responses] Successfully extracted image: ${image.mimeType}, ${image.data.length} chars of base64`,
          );
          images.push(image);
        } catch (err) {
          // Log and continue - don't fail the entire request for one bad image
          console.warn("[responses] Failed to extract image:", err);
        }
      } else if (part.type === "input_file") {
        console.log("[responses] Found input_file, extracting...");
        try {
          const file = await extractFileFromPart(
            part as {
              file_url?: string;
              file_data?: string;
              filename?: string;
              source?: {
                type?: string;
                url?: string;
                data?: string;
                media_type?: string;
                filename?: string;
              };
            },
          );
          console.log(
            `[responses] Successfully extracted file: ${file.filename}, has text: ${!!file.text}, has images: ${!!file.images?.length}`,
          );
          if (file.text?.trim()) {
            fileContexts.push(`<file name="${file.filename}">\n${file.text}\n</file>`);
          }
          if (file.images && file.images.length > 0) {
            images.push(...file.images);
          }
        } catch (err) {
          // Log and continue - don't fail the entire request for one bad file
          console.warn("[responses] Failed to extract file:", err);
        }
      }
    }
  }

  console.log(
    `[responses] Finished extraction: ${images.length} images, ${fileContexts.length} file contexts`,
  );
  return { images, fileContexts };
}
