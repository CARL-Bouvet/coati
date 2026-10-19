// One-click "Sign in with OpenRouter" (docs/PROTOCOL.md "OAuth sign-in"): PKCE flow
// with a single pending attempt, completed by `GET /oauth/callback`. The code and
// the key never appear in the returned page or in any log line.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isValidKeyFormat } from "./key-format.ts";
import { t, type Lang, type MessageCode } from "./messages.ts";

export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
export const OAUTH_CALLBACK_PATH = "/oauth/callback";
export const OAUTH_TTL_MS = 10 * 60 * 1000;
export const OAUTH_EXCHANGE_TIMEOUT_MS = 15_000;
const MAX_EXCHANGE_BODY_CHARS = 4096;

const b64url = (buf: Buffer): string => buf.toString("base64url");

/** Exchange endpoint base; overridable by the environment so an end-to-end run can use a local stand-in. */
function exchangeBase(): string {
  return process.env.COATI_OPENROUTER_API_BASE || OPENROUTER_API_BASE_URL;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(ok: boolean, lang: Lang): Response {
  const code: MessageCode = ok ? "oauth.connected" : "oauth.failed";
  const text = escapeHtml(t(code, lang));
  const html = `<!doctype html><html lang="${lang === "zh_CN" ? "zh-CN" : lang}"><head><meta charset="utf-8"><title>Coati</title></head><body><p>${text}</p></body></html>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

interface Pending {
  state: string;
  verifier: string;
  expiresAt: number;
  lang: Lang;
}

export function createOAuthFlow() {
  let pending: Pending | null = null;

  return {
    /** Starts an attempt (replacing any previous one) and returns the URL to open. */
    start(port: number, lang: Lang): string {
      const verifier = b64url(randomBytes(32));
      const state = b64url(randomBytes(32));
      pending = { state, verifier, expiresAt: Date.now() + OAUTH_TTL_MS, lang };
      const challenge = b64url(createHash("sha256").update(verifier).digest());
      const query = new URLSearchParams({
        callback_url: `http://localhost:${port}${OAUTH_CALLBACK_PATH}`,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      });
      return `https://openrouter.ai/auth?${query}`;
    },

    /** Consumes the pending attempt (single use) when `state` matches, exchanges the code
     * and hands the key to `onKey`. Any other outcome is the generic failure page. */
    async complete(params: URLSearchParams, onKey: (key: string) => void | Promise<void>): Promise<Response> {
      const attempt = pending;
      const state = params.get("state") ?? "";
      const stateBuf = Buffer.from(state);
      const expectedBuf = attempt ? Buffer.from(attempt.state) : null;
      if (
        !attempt ||
        !expectedBuf ||
        stateBuf.length !== expectedBuf.length ||
        !timingSafeEqual(stateBuf, expectedBuf) ||
        Date.now() > attempt.expiresAt
      ) {
        if (attempt && Date.now() > attempt.expiresAt) pending = null;
        return page(false, attempt?.lang ?? "en");
      }
      pending = null;
      const code = params.get("code");
      if (!code) return page(false, attempt.lang);
      try {
        const res = await fetch(`${exchangeBase()}/auth/keys`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, code_verifier: attempt.verifier, code_challenge_method: "S256" }),
          redirect: "error",
          signal: AbortSignal.timeout(OAUTH_EXCHANGE_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`exchange status ${res.status}`);
        const body = JSON.parse((await res.text()).slice(0, MAX_EXCHANGE_BODY_CHARS)) as { key?: unknown };
        const key = typeof body.key === "string" ? body.key.trim() : "";
        if (!isValidKeyFormat("openai-compat", OPENROUTER_API_BASE_URL, key)) throw new Error("exchange returned no usable key");
        await onKey(key);
      } catch (err) {
        console.error(`coati-broker: oauth exchange failed: ${err instanceof Error ? err.name : "error"}`);
        return page(false, attempt.lang);
      }
      return page(true, attempt.lang);
    },
  };
}

export type OAuthFlow = ReturnType<typeof createOAuthFlow>;
