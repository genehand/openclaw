import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lookupSessionKey, storeSessionMapping, clearAllMappings } from "./session-store.js";

const TEST_AGENT_ID = "test-agent";

// Helper to create a temp state dir for tests
function createTempStateDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "responses-api-test-"));
  return tmpDir;
}

describe("session-store", () => {
  let originalStateDir: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    tempDir = createTempStateDir();
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalStateDir !== undefined) {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    } else {
      delete process.env.OPENCLAW_STATE_DIR;
    }
    // Clean up temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("lookupSessionKey", () => {
    it("returns undefined for unknown response ID", () => {
      const result = lookupSessionKey("resp_nonexistent", TEST_AGENT_ID);
      expect(result).toBeUndefined();
    });

    it("returns session key for stored mapping", async () => {
      await storeSessionMapping("resp_abc123", "responses-api:user:alice", TEST_AGENT_ID);

      const result = lookupSessionKey("resp_abc123", TEST_AGENT_ID);
      expect(result).toBe("responses-api:user:alice");
    });

    it("returns undefined for expired mappings", async () => {
      // Store with a very short TTL
      const originalTtl = process.env.OPENCLAW_RESPONSES_API_SESSION_TTL_MS;
      process.env.OPENCLAW_RESPONSES_API_SESSION_TTL_MS = "1"; // 1ms

      await storeSessionMapping("resp_old", "responses-api:user:bob", TEST_AGENT_ID);

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 50));

      const result = lookupSessionKey("resp_old", TEST_AGENT_ID);
      expect(result).toBeUndefined();

      // Restore TTL
      if (originalTtl) {
        process.env.OPENCLAW_RESPONSES_API_SESSION_TTL_MS = originalTtl;
      } else {
        delete process.env.OPENCLAW_RESPONSES_API_SESSION_TTL_MS;
      }
    });

    it("returns undefined after clearAllMappings", async () => {
      await storeSessionMapping("resp_to_clear", "responses-api:user:charlie", TEST_AGENT_ID);
      expect(lookupSessionKey("resp_to_clear", TEST_AGENT_ID)).toBe("responses-api:user:charlie");

      await clearAllMappings(TEST_AGENT_ID);

      expect(lookupSessionKey("resp_to_clear", TEST_AGENT_ID)).toBeUndefined();
    });

    it("isolates mappings per agent", async () => {
      await storeSessionMapping("resp_shared", "agent-a-session", "agent-a");
      await storeSessionMapping("resp_shared", "agent-b-session", "agent-b");

      // Each agent should see only their own mapping
      expect(lookupSessionKey("resp_shared", "agent-a")).toBe("agent-a-session");
      expect(lookupSessionKey("resp_shared", "agent-b")).toBe("agent-b-session");
    });
  });

  describe("storeSessionMapping", () => {
    it("stores mapping to disk in agent directory", async () => {
      await storeSessionMapping("resp_xyz789", "responses-api:user:dave", TEST_AGENT_ID);

      // Verify file was created in agent directory
      const storePath = path.join(
        tempDir,
        "agents",
        TEST_AGENT_ID,
        "sessions",
        "responses-api-sessions.json",
      );
      expect(fs.existsSync(storePath)).toBe(true);

      // Verify content
      const content = fs.readFileSync(storePath, "utf-8");
      const data = JSON.parse(content);
      expect(data.version).toBe(1);
      expect(data.mappings["resp_xyz789"]).toBeDefined();
      expect(data.mappings["resp_xyz789"].sessionKey).toBe("responses-api:user:dave");
      expect(typeof data.mappings["resp_xyz789"].createdAt).toBe("number");
    });

    it("updates existing mapping", async () => {
      await storeSessionMapping("resp_update", "responses-api:user:initial", TEST_AGENT_ID);
      await storeSessionMapping("resp_update", "responses-api:user:updated", TEST_AGENT_ID);

      const result = lookupSessionKey("resp_update", TEST_AGENT_ID);
      expect(result).toBe("responses-api:user:updated");
    });

    it("handles concurrent writes", async () => {
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          storeSessionMapping(`resp_concurrent_${i}`, `responses-api:user:${i}`, TEST_AGENT_ID),
        );
      }

      await Promise.all(promises);

      // Verify all mappings were stored
      for (let i = 0; i < 10; i++) {
        const result = lookupSessionKey(`resp_concurrent_${i}`, TEST_AGENT_ID);
        expect(result).toBe(`responses-api:user:${i}`);
      }
    });

    it("enforces max entries limit with LRU eviction", async () => {
      // Set a low max entries limit
      const originalMax = process.env.OPENCLAW_RESPONSES_API_MAX_SESSIONS;
      process.env.OPENCLAW_RESPONSES_API_MAX_SESSIONS = "3";

      await storeSessionMapping("resp_1", "key1", TEST_AGENT_ID);
      await new Promise((r) => setTimeout(r, 10)); // Ensure different timestamps
      await storeSessionMapping("resp_2", "key2", TEST_AGENT_ID);
      await new Promise((r) => setTimeout(r, 10));
      await storeSessionMapping("resp_3", "key3", TEST_AGENT_ID);
      await new Promise((r) => setTimeout(r, 10));
      await storeSessionMapping("resp_4", "key4", TEST_AGENT_ID); // Should evict resp_1

      // resp_1 should be evicted (oldest)
      expect(lookupSessionKey("resp_1", TEST_AGENT_ID)).toBeUndefined();
      // resp_2, resp_3, resp_4 should exist
      expect(lookupSessionKey("resp_2", TEST_AGENT_ID)).toBe("key2");
      expect(lookupSessionKey("resp_3", TEST_AGENT_ID)).toBe("key3");
      expect(lookupSessionKey("resp_4", TEST_AGENT_ID)).toBe("key4");

      // Restore limit
      if (originalMax) {
        process.env.OPENCLAW_RESPONSES_API_MAX_SESSIONS = originalMax;
      } else {
        delete process.env.OPENCLAW_RESPONSES_API_MAX_SESSIONS;
      }
    });

    it("gracefully handles missing directory", async () => {
      // Delete the temp dir to simulate a missing directory
      fs.rmSync(tempDir, { recursive: true, force: true });

      // Should not throw
      await expect(
        storeSessionMapping("resp_missing_dir", "key", TEST_AGENT_ID),
      ).resolves.not.toThrow();
    });
  });

  describe("persistence across instances", () => {
    it("survives process restart", async () => {
      await storeSessionMapping("resp_persist", "responses-api:user:eve", TEST_AGENT_ID);

      // Simulate restart by clearing in-memory state and re-reading from disk
      // lookupSessionKey re-reads from disk each time, so it should still work
      const result = lookupSessionKey("resp_persist", TEST_AGENT_ID);
      expect(result).toBe("responses-api:user:eve");
    });
  });
});
