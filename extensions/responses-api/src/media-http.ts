import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { detectMime } from "openclaw/plugin-sdk";
import {
  SafeOpenError,
  openFileWithinRoot,
  type SafeOpenResult,
} from "../../../src/infra/fs-safe.js";
import { cleanOldMedia, getMediaDir, MEDIA_MAX_BYTES } from "../../../src/media/store.js";

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const MAX_MEDIA_ID_CHARS = 200;
const MEDIA_ID_PATTERN = /^[\p{L}\p{N}._-]+$/u;
const ALLOWED_SUBDIRS = new Set(["inbound", "outbound"]);
const MEDIA_PATH_RE = /^\/media\/(?:([a-z]+)\/)?([^/]+)$/;

function isValidMediaId(id: string): boolean {
  if (!id || id.length > MAX_MEDIA_ID_CHARS) {
    return false;
  }
  if (id === "." || id === "..") {
    return false;
  }
  return MEDIA_ID_PATTERN.test(id);
}

/**
 * Handle GET /media/:id and /media/:subdir/:id requests for the responses API.
 * Mirrors the logic in the core media server but works with plain Node HTTP.
 *
 * Returns `true` if the request was handled (even with an error response),
 * `false` if the path didn't match `/media/...`.
 */
export async function handleMediaHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  const match = MEDIA_PATH_RE.exec(url.pathname);
  if (!match) {
    return false;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const subdir = match[1];
  const id = decodeURIComponent(match[2]);

  if (subdir && !ALLOWED_SUBDIRS.has(subdir)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("invalid path");
    return true;
  }

  if (!isValidMediaId(id)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("invalid path");
    return true;
  }

  const mediaDir = getMediaDir();
  const relativePath = subdir ? `${subdir}/${id}` : id;

  let opened: SafeOpenResult | undefined;
  try {
    opened = await openFileWithinRoot({
      rootDir: mediaDir,
      relativePath,
    });

    const { handle, realPath, stat } = opened;

    if (stat.size > MEDIA_MAX_BYTES) {
      await handle.close().catch(() => {});
      res.statusCode = 413;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("too large");
      return true;
    }

    if (Date.now() - stat.mtimeMs > DEFAULT_TTL_MS) {
      await handle.close().catch(() => {});
      await fs.rm(realPath).catch(() => {});
      res.statusCode = 410;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("expired");
      return true;
    }

    const data = await handle.readFile();
    await handle.close().catch(() => {});
    opened = undefined;

    const mime = await detectMime({ buffer: data, filePath: realPath });
    if (mime) {
      res.setHeader("Content-Type", mime);
    }

    res.statusCode = 200;

    // best-effort single-use cleanup after response ends
    res.on("finish", () => {
      setTimeout(() => {
        fs.rm(realPath).catch(() => {});
      }, 50);
    });

    res.end(data);
  } catch (err) {
    if (opened) {
      await opened.handle.close().catch(() => {});
    }
    if (err instanceof SafeOpenError) {
      res.statusCode = err.code === "invalid-path" ? 400 : 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(err.code === "invalid-path" ? "invalid path" : "not found");
      return true;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found");
  }

  return true;
}

// Periodic cleanup — started once when the module loads.
let cleanupStarted = false;
export function ensureMediaCleanup() {
  if (cleanupStarted) {
    return;
  }
  cleanupStarted = true;
  setInterval(() => {
    void cleanOldMedia(DEFAULT_TTL_MS);
  }, DEFAULT_TTL_MS).unref();
}
