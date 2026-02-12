import { timingSafeEqual } from "node:crypto";
import { getBearerToken, getHeader } from "openclaw/plugin-sdk";

export { getBearerToken, getHeader };

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function resolveAuthToken(cfg: {
  gateway?: { auth?: { token?: string; password?: string; mode?: string } };
}): {
  mode: "token" | "password";
  secret: string | undefined;
} {
  const authCfg = cfg.gateway?.auth;
  const token =
    authCfg?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.CLAWDBOT_GATEWAY_TOKEN;
  const password =
    authCfg?.password ??
    process.env.OPENCLAW_GATEWAY_PASSWORD ??
    process.env.CLAWDBOT_GATEWAY_PASSWORD;
  const mode = (authCfg?.mode ?? (password ? "password" : "token")) as "token" | "password";
  return { mode, secret: mode === "password" ? password : token };
}

export function authorize(bearerToken: string | undefined, cfg: Record<string, unknown>): boolean {
  const { secret } = resolveAuthToken(cfg as Parameters<typeof resolveAuthToken>[0]);
  if (!secret || !bearerToken) return false;
  return safeEqual(bearerToken, secret);
}
