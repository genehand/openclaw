import { timingSafeEqual } from "node:crypto";
import { getBearerToken, getHeader } from "openclaw/plugin-sdk";

export { getBearerToken, getHeader };

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Token configuration entry for Responses API.
 * Each token maps to a specific agent for routing.
 */
export type ResponsesApiTokenEntry = {
  agentId: string;
  label?: string;
};

/**
 * Responses API channel configuration.
 */
export type ResponsesApiConfig = {
  tokens?: Record<string, ResponsesApiTokenEntry>;
};

/**
 * Extract responses-api config from the main config.
 */
function extractResponsesApiConfig(cfg: Record<string, unknown>): ResponsesApiConfig {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return (channels?.["responses-api"] as ResponsesApiConfig) ?? {};
}

/**
 * Look up a token in the responses-api token registry.
 * Returns the associated agentId if the token is valid.
 */
function lookupToken(
  bearerToken: string,
  cfg: Record<string, unknown>,
): { valid: true; agentId: string; label?: string } | { valid: false } {
  const responsesCfg = extractResponsesApiConfig(cfg);
  const tokens = responsesCfg.tokens ?? {};

  for (const [token, entry] of Object.entries(tokens)) {
    if (safeEqual(bearerToken, token)) {
      return { valid: true, agentId: entry.agentId, label: entry.label };
    }
  }

  return { valid: false };
}

/**
 * Result of authorizing a request.
 */
export type AuthResult =
  | { authorized: true; agentId: string; label?: string }
  | { authorized: false; agentId?: undefined; label?: undefined };

/**
 * Authorize a bearer token and return the associated agent for routing.
 * Tokens are stored in channels.responses-api.tokens, where each token maps to an agentId.
 */
export function authorize(
  bearerToken: string | undefined,
  cfg: Record<string, unknown>,
): AuthResult {
  if (!bearerToken) {
    return { authorized: false };
  }

  const result = lookupToken(bearerToken, cfg);
  if (result.valid) {
    return { authorized: true, agentId: result.agentId, label: result.label };
  }

  return { authorized: false };
}
