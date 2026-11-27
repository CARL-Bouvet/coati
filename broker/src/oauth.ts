// One-click browser sign-in (docs/PROTOCOL.md "OAuth sign-in", "ChatGPT sign-in"): PKCE flow with a
// single pending attempt for either service, completed by `GET /oauth/callback` (OpenRouter) or
// `GET /auth/callback` (ChatGPT). The code and any key or token never appear in the returned page
// or in any log line.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { isValidKeyFormat } from "./key-format.ts";
import { isValidApiKeyFormat } from "./protocol/shared.ts";
import { t, type Lang, type MessageCode } from "./messages.ts";
import { authorizeUrl, ChatGptAuthError, chatGptRedirectUri, DYNAMIC_CLIENT_ID, exchangeCode, issuedClientId, pkceChallenge } from "./chatgpt-auth.ts";

export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
export const OAUTH_CALLBACK_PATH = "/oauth/callback";
export const OAUTH_TTL_MS = 10 * 60 * 1000;
export const OAUTH_EXCHANGE_TIMEOUT_MS = 15_000;
const MAX_EXCHANGE_BODY_CHARS = 4096;

export type OAuthService = "openrouter" | "chatgpt";

const b64url = (buf: Buffer): string => buf.toString("base64url");

/** OpenRouter API base for the code exchange and the key check; overridable by the environment so an
 * end-to-end run can use a local stand-in. */
export function openRouterApiBase(): string {
  return process.env.COATI_OPENROUTER_API_BASE || OPENROUTER_API_BASE_URL;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(ok: boolean, lang: Lang, code: MessageCode = ok ? "oauth.connected" : "oauth.failed"): Response {
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
  service: OAuthService;
  state: string;
  verifier: string;
  nonce?: string;
  expiresAt: number;
  lang: Lang;
  /** ChatGPT re-sign-in: the issued client id the callback must come back with. */
  clientId?: string;
}

export function createOAuthFlow() {
  let pending: Pending | null = null;

  /** Consumes the pending attempt (single use) when `state` matches in constant time and the attempt is live. */
  function take(params: URLSearchParams): Pending | null {
    const attempt = pending;
    if (!attempt) return null;
    const stateBuf = Buffer.from(params.get("state") ?? "");
    const expectedBuf = Buffer.from(attempt.state);
    if (stateBuf.length !== expectedBuf.length || !timingSafeEqual(stateBuf, expectedBuf)) return null;
    pending = null;
    return Date.now() > attempt.expiresAt ? null : attempt;
  }

  return {
    hasPending: (): boolean => pending !== null,

    /** Starts an attempt (replacing any previous one) and returns the URL to open. */
    start(service: OAuthService, port: number, lang: Lang, consent = false): string {
      const verifier = b64url(randomBytes(32));
      const state = b64url(randomBytes(32));
      const challenge = pkceChallenge(verifier);
      pending = { service, state, verifier, expiresAt: Date.now() + OAUTH_TTL_MS, lang };
      if (service === "chatgpt") {
        pending.nonce = b64url(randomBytes(32));
        pending.clientId = issuedClientId();
        return authorizeUrl({ redirectUri: chatGptRedirectUri(port), state, challenge, nonce: pending.nonce, consent });
      }
      const query = new URLSearchParams({
        callback_url: `http://localhost:${port}${OAUTH_CALLBACK_PATH}`,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      });
      return `https://openrouter.ai/auth?${query}`;
    },

    /** OpenRouter return: exchanges the code and hands the key to `onKey`. Any failure is the generic page. */
    async complete(params: URLSearchParams, onKey: (key: string) => void | Promise<void>): Promise<Response> {
      const attempt = take(params);
      if (!attempt || attempt.service !== "openrouter") return page(false, attempt?.lang ?? "en");
      const code = params.get("code");
      if (!code) return page(false, attempt.lang);
      try {
        const res = await fetch(`${openRouterApiBase()}/auth/keys`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, code_verifier: attempt.verifier, code_challenge_method: "S256" }),
          redirect: "error",
          signal: AbortSignal.timeout(OAUTH_EXCHANGE_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`exchange status ${res.status}`);
        const body = JSON.parse((await res.text()).slice(0, MAX_EXCHANGE_BODY_CHARS)) as { key?: unknown };
        const key = typeof body.key === "string" ? body.key.trim() : "";
        if (!isValidApiKeyFormat(key) || !isValidKeyFormat("openai-compat", OPENROUTER_API_BASE_URL, key)) throw new Error("exchange returned no usable key");
        await onKey(key);
      } catch (err) {
        console.error(`coati-broker: oauth exchange failed: ${err instanceof Error ? err.name : "error"}`);
        return page(false, attempt.lang);
      }
      return page(true, attempt.lang);
    },

    /** ChatGPT return: checks the client id, exchanges the code (tokens are stored by chatgpt-auth) and calls `onSignedIn`. */
    async completeChatGpt(params: URLSearchParams, port: number, onSignedIn: () => void): Promise<Response> {
      const attempt = take(params);
      if (!attempt || attempt.service !== "chatgpt" || !attempt.nonce) return page(false, attempt?.lang ?? "en");
      if (params.get("error") === "access_denied") return page(false, attempt.lang, "oauth.chatgpt-denied");
      const code = params.get("code");
      const returned = params.get("client_id") ?? "";
      // Re-sign-in: the issued id must come back unchanged. New registration: the callback must carry the issued id.
      const clientId = attempt.clientId ?? returned;
      if (!code || !clientId || clientId === DYNAMIC_CLIENT_ID || (attempt.clientId && returned && returned !== attempt.clientId)) {
        return page(false, attempt.lang);
      }
      try {
        const { planUsage } = await exchangeCode({
          clientId,
          code,
          verifier: attempt.verifier,
          nonce: attempt.nonce,
          redirectUri: chatGptRedirectUri(port),
          scope: params.get("scope") ?? undefined,
        });
        onSignedIn();
        return planUsage ? page(true, attempt.lang) : page(false, attempt.lang, "oauth.chatgpt-no-plan");
      } catch (err) {
        const reason = err instanceof ChatGptAuthError ? `: ${err.message}` : "";
        console.error(`coati-broker: chatgpt sign-in failed: ${err instanceof Error ? err.name : "error"}${reason}`);
        return page(false, attempt.lang);
      }
    },
  };
}

export type OAuthFlow = ReturnType<typeof createOAuthFlow>;
