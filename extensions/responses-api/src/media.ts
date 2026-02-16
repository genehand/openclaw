import type { IncomingMessage } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { saveMediaSource, type ReplyPayload } from "openclaw/plugin-sdk";
import { getAgentScopedMediaLocalRoots } from "../../../src/media/local-roots.js";

// -- URL helpers ------------------------------------------------------------

export function isRemoteUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

export function deriveGatewayBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host || "localhost";
  const proto =
    (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() ||
    ((req.socket as unknown as { encrypted?: boolean })?.encrypted ? "https" : "http");
  return `${proto}://${host}`;
}

// -- Single / batch URL resolution ------------------------------------------

async function tryResolveRelativePath(
  filePath: string,
  cfg: OpenClawConfig,
  agentId?: string,
): Promise<string | null> {
  // If it's already an absolute path, return as-is
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Try to resolve against media local roots
  const localRoots = agentId ? getAgentScopedMediaLocalRoots(cfg, agentId) : [];

  for (const root of localRoots) {
    const fullPath = path.join(root, filePath);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        return fullPath;
      }
    } catch {
      // File doesn't exist in this root, try next
    }
  }

  return null;
}

export async function resolveMediaUrl(
  source: string,
  gatewayBaseUrl: string,
  cfg?: OpenClawConfig,
  agentId?: string,
): Promise<string> {
  if (isRemoteUrl(source)) return source;
  let filePath = source.startsWith("file://") ? source.slice(7) : source;

  // Expand ~ to home directory
  if (filePath.startsWith("~")) {
    filePath = path.join(process.env.HOME || "/tmp", filePath.slice(1));
  }

  // If it's a relative path, try to resolve it against media local roots
  if (!path.isAbsolute(filePath)) {
    const resolved = await tryResolveRelativePath(filePath, cfg || ({} as OpenClawConfig), agentId);
    if (resolved) {
      filePath = resolved;
    }
  }

  try {
    const saved = await saveMediaSource(filePath, undefined, "outbound");
    return `${gatewayBaseUrl}/media/outbound/${saved.id}`;
  } catch (err) {
    // Log resolution failures to help diagnose path issues
    console.error(`[responses-api] Failed to resolve media source: ${filePath}`, err);
    return source;
  }
}

export async function resolveMediaUrls(
  urls: string[],
  gatewayBaseUrl: string,
  cfg?: OpenClawConfig,
  agentId?: string,
): Promise<string[]> {
  return Promise.all(urls.map((u) => resolveMediaUrl(u, gatewayBaseUrl, cfg, agentId)));
}

// -- Leftover MEDIA: token extraction ---------------------------------------

/**
 * Extract MEDIA: tokens that the core security filter rejected (absolute/~ paths)
 * but that we can safely resolve for this channel. The core `splitMediaFromOutput`
 * only allows `./relative` paths and http(s):// URLs; everything else stays in the
 * text verbatim. We re-scan the text for those leftover tokens, resolve each via
 * `saveMediaSource`, strip the token lines from the text, and return resolved URLs.
 */
const MEDIA_LEFTOVER_RE = /^[ \t]*MEDIA:\s*`?([^\n]+?)`?\s*$/gim;

/** Strip inline MEDIA: tokens from text to prevent raw tokens leaking into responses. */
const MEDIA_TOKEN_INLINE_RE = /\s*MEDIA:\s*\S+/gi;

export function stripMediaTokens(text: string): string {
  return text.replace(MEDIA_TOKEN_INLINE_RE, "");
}

export async function extractLeftoverMediaTokens(
  text: string,
  gatewayBaseUrl: string,
  cfg?: OpenClawConfig,
  agentId?: string,
): Promise<{ text: string; mediaUrls: string[] }> {
  const filePaths: string[] = [];
  const cleaned = text.replace(MEDIA_LEFTOVER_RE, (match, raw: string) => {
    const candidate = raw
      .replace(/^[\`"'[{(]+/, "")
      .replace(/[\`"'\}\)\],]+$/, "")
      .trim();
    if (!candidate || isRemoteUrl(candidate)) {
      return match;
    }
    const filePath = candidate.startsWith("file://") ? candidate.slice(7) : candidate;
    // Accept absolute paths, home paths, and relative paths (to be resolved later)
    if (filePath.startsWith("/") || filePath.startsWith("~") || !filePath.includes(":")) {
      filePaths.push(filePath);
      return "";
    }
    return match;
  });

  if (filePaths.length === 0) {
    return { text, mediaUrls: [] };
  }

  const resolved = await resolveMediaUrls(filePaths, gatewayBaseUrl, cfg, agentId);

  return {
    text: cleaned.replace(/\n{3,}/g, "\n\n").trim(),
    // Filter out unresolved paths (resolveMediaUrl returns the original on failure)
    mediaUrls: resolved.filter((u) => isRemoteUrl(u)),
  };
}

// -- Markdown image resolution ----------------------------------------------

/**
 * Resolve markdown image references that point to local absolute paths.
 * The LLM sometimes writes `![alt](/absolute/path/to/image.png)` when it
 * generates or receives images via tools. We replace the local path with
 * a gateway-served HTTP URL so the API client can fetch the image.
 */
const MD_IMAGE_LOCAL_RE = /!\[([^\]]*)\]\((\/[^)]+)\)/g;

export async function resolveLocalMarkdownImages(
  text: string,
  gatewayBaseUrl: string,
  cfg?: OpenClawConfig,
  agentId?: string,
): Promise<string> {
  const replacements: Array<{ match: string; url: Promise<string>; alt: string }> = [];
  for (const m of text.matchAll(MD_IMAGE_LOCAL_RE)) {
    const fullMatch = m[0];
    const alt = m[1] ?? "";
    const localPath = m[2];
    if (!localPath || isRemoteUrl(localPath)) continue;
    replacements.push({
      match: fullMatch,
      alt,
      url: resolveMediaUrl(localPath, gatewayBaseUrl, cfg, agentId),
    });
  }

  if (replacements.length === 0) return text;

  let result = text;
  for (const r of replacements) {
    const resolved = await r.url;
    if (isRemoteUrl(resolved)) {
      result = result.replace(r.match, `![${r.alt}](${resolved})\n`);
    }
  }
  return result;
}

// -- Payload media helpers --------------------------------------------------

export function collectMediaUrls(payload: ReplyPayload): string[] {
  const urls: string[] = [];
  if (payload.mediaUrls?.length) {
    urls.push(...payload.mediaUrls.filter(Boolean));
  } else if (payload.mediaUrl) {
    urls.push(payload.mediaUrl);
  }
  return urls;
}

export function formatMediaAsMarkdown(urls: string[]): string {
  if (urls.length === 0) return "";
  return urls.map((url) => `![image](${url})\n`).join("");
}

/**
 * Convert a ReplyPayload into a single content string with any media
 * resolved to gateway URLs. Handles leftover MEDIA: tokens, local
 * markdown image paths, and inline MEDIA: token stripping.
 */
export async function payloadToContent(
  payload: ReplyPayload,
  gatewayBaseUrl: string,
  cfg?: OpenClawConfig,
  agentId?: string,
): Promise<string> {
  let text = payload.text ?? "";
  const rawUrls = collectMediaUrls(payload);
  const resolved =
    rawUrls.length > 0 ? await resolveMediaUrls(rawUrls, gatewayBaseUrl, cfg, agentId) : [];

  // Extract MEDIA: tokens that the core security filter rejected (absolute paths)
  const leftover = await extractLeftoverMediaTokens(text, gatewayBaseUrl, cfg, agentId);
  text = leftover.text;
  resolved.push(...leftover.mediaUrls);

  // Resolve markdown image refs with local absolute paths (e.g. ![alt](/mnt/...))
  text = await resolveLocalMarkdownImages(text, gatewayBaseUrl, cfg, agentId);

  // Strip any remaining inline MEDIA: tokens that weren't caught by line-anchored extraction
  text = stripMediaTokens(text);

  const media = formatMediaAsMarkdown(resolved);
  if (!text && !media) return "";
  if (!media) return text;
  if (!text) return media;
  return `${text}\n\n${media}`;
}
