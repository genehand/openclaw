import JSON5 from "json5";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// -- State Directory Resolution ---------------------------------------------

function resolveStateDir(): string {
  const env = process.env;
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return override;
  }
  return path.join(os.homedir(), ".openclaw");
}

// -- Constants --------------------------------------------------------------

const STORE_FILENAME = "responses-api-sessions.json";
const DEFAULT_MAX_ENTRIES = 4096;
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 25;

// -- Types ------------------------------------------------------------------

type SessionMapping = {
  sessionKey: string;
  createdAt: number;
};

type SessionStoreData = {
  version: 1;
  mappings: Record<string, SessionMapping>;
};

// -- Store Path Resolution --------------------------------------------------

function getStorePath(agentId: string): string {
  const baseDir = resolveStateDir();
  return path.join(baseDir, "agents", agentId, "sessions", STORE_FILENAME);
}

// -- File Locking -----------------------------------------------------------

async function withFileLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${storePath}.lock`;
  const startedAt = Date.now();

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });

  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
          "utf-8",
        );
      } catch {
        // best-effort
      }
      await handle.close();
      break;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;

      if (code === "ENOENT") {
        await fs.promises
          .mkdir(path.dirname(storePath), { recursive: true })
          .catch(() => undefined);
        await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
        continue;
      }

      if (code !== "EEXIST") {
        throw err;
      }

      const now = Date.now();
      if (now - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`timeout acquiring responses-api session lock: ${lockPath}`, {
          cause: err,
        });
      }

      // Stale lock eviction
      try {
        const st = await fs.promises.stat(lockPath);
        const ageMs = now - st.mtimeMs;
        if (ageMs > LOCK_STALE_MS) {
          await fs.promises.unlink(lockPath);
          continue;
        }
      } catch {
        // ignore
      }

      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }

  try {
    return await fn();
  } finally {
    await fs.promises.unlink(lockPath).catch(() => undefined);
  }
}

// -- Store Operations -------------------------------------------------------

function createEmptyStore(): SessionStoreData {
  return { version: 1, mappings: {} };
}

function loadStoreSync(storePath: string): SessionStoreData {
  try {
    const content = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON5.parse(content);
    if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.mappings) {
      return parsed as SessionStoreData;
    }
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;
    if (code !== "ENOENT") {
      // Log but don't throw - we'll start fresh
      console.warn("Failed to load responses-api session store:", err);
    }
  }
  return createEmptyStore();
}

async function saveStoreUnlocked(
  storePath: string,
  store: SessionStoreData,
  maxEntries: number,
): Promise<void> {
  // Clean up expired entries
  const now = Date.now();
  const ttl = getTtlMs();

  for (const [key, mapping] of Object.entries(store.mappings)) {
    if (now - mapping.createdAt > ttl) {
      delete store.mappings[key];
    }
  }

  // Enforce max entries limit (LRU eviction based on createdAt)
  const entries = Object.entries(store.mappings);
  if (entries.length > maxEntries) {
    // Sort by createdAt ascending and remove oldest
    entries.sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toRemove = entries.length - maxEntries;
    for (let i = 0; i < toRemove; i++) {
      delete store.mappings[entries[i][0]];
    }
  }

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);

  // Windows: direct write (no atomic rename)
  if (process.platform === "win32") {
    try {
      await fs.promises.writeFile(storePath, json, "utf-8");
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") {
        return;
      }
      throw err;
    }
    return;
  }

  // Unix: atomic write via temp file + rename
  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fs.promises.rename(tmp, storePath);
    await fs.promises.chmod(storePath, 0o600);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;

    if (code === "ENOENT") {
      // Try direct write as fallback
      try {
        await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
        await fs.promises.writeFile(storePath, json, { mode: 0o600, encoding: "utf-8" });
        await fs.promises.chmod(storePath, 0o600);
      } catch (err2) {
        const code2 =
          err2 && typeof err2 === "object" && "code" in err2
            ? String((err2 as { code?: unknown }).code)
            : null;
        if (code2 === "ENOENT") {
          return;
        }
        throw err2;
      }
      return;
    }

    throw err;
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

// -- TTL Configuration ------------------------------------------------------

function getTtlMs(): number {
  const envValue = process.env.OPENCLAW_RESPONSES_API_SESSION_TTL_MS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_TTL_MS;
}

function getMaxEntries(): number {
  const envValue = process.env.OPENCLAW_RESPONSES_API_MAX_SESSIONS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_ENTRIES;
}

// -- Public API -------------------------------------------------------------

/**
 * Look up the session key for a given response ID.
 * Returns undefined if not found or expired.
 */
export function lookupSessionKey(responseId: string, agentId: string): string | undefined {
  const storePath = getStorePath(agentId);
  const store = loadStoreSync(storePath);
  const mapping = store.mappings[responseId];

  if (!mapping) {
    return undefined;
  }

  // Check if expired
  const ttl = getTtlMs();
  if (Date.now() - mapping.createdAt > ttl) {
    return undefined;
  }

  return mapping.sessionKey;
}

/**
 * Store a mapping from response ID to session key.
 * This is async because it may involve file I/O and locking.
 *
 * Errors are silently ignored (best-effort persistence) since this is
 * used fire-and-forget style in the request handler.
 */
export async function storeSessionMapping(
  responseId: string,
  sessionKey: string,
  agentId: string,
): Promise<void> {
  const storePath = getStorePath(agentId);
  const maxEntries = getMaxEntries();

  try {
    await withFileLock(storePath, async () => {
      const store = loadStoreSync(storePath);

      store.mappings[responseId] = {
        sessionKey,
        createdAt: Date.now(),
      };

      await saveStoreUnlocked(storePath, store, maxEntries);
    });
  } catch {
    // Silently ignore errors - this is best-effort persistence.
    // The mapping will be lost if the gateway restarts, but the
    // current request will still work correctly.
  }
}

/**
 * Clear all mappings (useful for testing).
 */
export async function clearAllMappings(agentId: string): Promise<void> {
  const storePath = getStorePath(agentId);
  await withFileLock(storePath, async () => {
    await saveStoreUnlocked(storePath, createEmptyStore(), getMaxEntries());
  });
}
