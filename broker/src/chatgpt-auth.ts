// "Sign in with ChatGPT" credentials (docs/PROTOCOL.md "ChatGPT sign-in"): authorize URL, code
// exchange, ID token verification (WebCrypto only), storage in `chatgpt-auth.json`, single-flight
// refresh and revocation. No token, code or URL carrying one is ever logged or returned to a client.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync, hardenDir } from "./fs-atomic.ts";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_CALLBACK_PATH = "/auth/callback";
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize?`;
const RESOURCE = "https://api.openai.com/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 256 * 1024;
const TERMINAL_REFRESH_ERRORS = new Set(["invalid_grant", "invalid_refresh_token", "refresh_token_expired", "refresh_token_reused"]);

/** Failure with a fixed, secret-free reason: safe to log. */
export class ChatGptAuthError extends Error {
  override name = "ChatGptAuthError";
}

/** Auth server base for token, JWKS and discovery calls; overridable so an end-to-end run can use a local stand-in. */
function authBase(): string {
  return (process.env.COATI_CHATGPT_AUTH_BASE || CHATGPT_ISSUER).replace(/\/+$/, "");
}

/** API base for models and responses (used by the provider); overridable like the auth base. */
export function chatGptApiBase(): string {
  return process.env.COATI_CHATGPT_API_BASE || RESOURCE;
}

/** The redirect address for a broker listening on `port`; the authorize request and the code exchange send the same one. */
export function chatGptRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CHATGPT_CALLBACK_PATH}`;
}

interface Stored {
  hostId: string;
  clientId?: string;
  issuer: string;
  subject?: string;
  email?: string;
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  earliestRefreshAt?: number;
  scopes?: string[];
  welcomed: boolean;
}

let filePath: string | undefined;
let state: Stored | undefined;
let refreshing: Promise<void> | undefined;
const jwks = new Map<string, CryptoKey>();

/** Points the module at the config directory (credentials stay in memory only when omitted) and drops cached state. */
export function initChatGptAuth(configDir?: string): void {
  filePath = configDir ? join(configDir, "chatgpt-auth.json") : undefined;
  state = undefined;
  refreshing = undefined;
  jwks.clear();
  if (!filePath) return;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<Stored>;
    if (typeof raw.hostId === "string") state = { ...raw, hostId: raw.hostId, issuer: CHATGPT_ISSUER, welcomed: raw.welcomed === true };
  } catch {
    // Missing or unreadable: starts signed out.
  }
}

function save(): void {
  if (!filePath || !state) return;
  hardenDir(dirname(filePath));
  atomicWriteFileSync(filePath, JSON.stringify(state, null, 2) + "\n", 0o600);
}

function current(): Stored {
  if (!state) {
    state = { hostId: `urn:uuid:${randomUUID()}`, issuer: CHATGPT_ISSUER, welcomed: false };
    save();
  }
  return state;
}

/** Replaces the token set together (access, refresh, expiry, scopes); `undefined` fields are dropped. */
function setTokens(t: Pick<Stored, "idToken" | "accessToken" | "refreshToken" | "expiresAt" | "earliestRefreshAt" | "scopes">): void {
  state = { ...current(), ...t };
  save();
}

const NO_TOKENS = { idToken: undefined, accessToken: undefined, refreshToken: undefined, expiresAt: undefined, earliestRefreshAt: undefined, scopes: undefined };

async function readBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ChatGptAuthError("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function request(url: string, form?: URLSearchParams): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: form ? "POST" : "GET",
    headers: form ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await readBody(res);
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON body (an empty 200 on revocation, an HTML error page): status only.
  }
  return { status: res.status, json };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Accepts unix seconds, unix milliseconds or an ISO date. */
function toMillis(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

// --- Authorization request ---------------------------------------------------

/** The issued client id of a previous sign-in, if any (a re-sign-in must come back with the same one). */
export function issuedClientId(): string | undefined {
  return state?.clientId;
}

/** Builds the authorize URL for one attempt; the first sign-in registers dynamically, later ones reuse the issued client id. */
export function authorizeUrl(a: { redirectUri: string; state: string; challenge: string; nonce: string; consent: boolean }): string {
  const s = current();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: s.clientId ?? DYNAMIC_CLIENT_ID,
    redirect_uri: a.redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state: a.state,
    nonce: a.nonce,
    code_challenge: a.challenge,
    code_challenge_method: "S256",
    ext_agent_host_id: s.hostId,
  });
  if (!s.clientId) query.set("agent_name_hint", "Coati");
  else if (s.email) query.set("login_hint", s.email);
  if (a.consent) query.set("prompt", "consent");
  return AUTHORIZE_URL + query;
}

// --- ID token ----------------------------------------------------------------

const b64urlJson = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

async function loadJwks(): Promise<void> {
  const { status, json } = await request(`${authBase()}/.well-known/jwks.json`);
  if (status !== 200 || !Array.isArray(json.keys)) throw new ChatGptAuthError("jwks unavailable");
  jwks.clear();
  for (const jwk of json.keys as Array<Record<string, unknown>>) {
    const kid = str(jwk?.kid);
    if (!kid || jwk.kty !== "RSA") continue;
    try {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n as string, e: jwk.e as string, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      jwks.set(kid, key);
    } catch {
      // A malformed key is skipped; the token then fails on its own kid.
    }
  }
}

/** Verifies an ID token (RS256 over the JWKS, iss, aud, exp, nonce) and returns the identity claims. */
async function verifyIdToken(token: string, clientId: string, nonce: string): Promise<{ subject: string; email?: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ChatGptAuthError("id token malformed");
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = b64urlJson(parts[0]!);
    claims = b64urlJson(parts[1]!);
  } catch {
    throw new ChatGptAuthError("id token malformed");
  }
  const kid = str(header.kid);
  if (header.alg !== "RS256" || !kid) throw new ChatGptAuthError("id token alg");
  if (!jwks.has(kid)) await loadJwks();
  const key = jwks.get(kid);
  if (!key) throw new ChatGptAuthError("id token unknown kid");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(parts[2]!, "base64url"), Buffer.from(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new ChatGptAuthError("id token signature");
  if (claims.iss !== CHATGPT_ISSUER) throw new ChatGptAuthError("id token iss");
  const aud = claims.aud;
  if (!(aud === clientId || (Array.isArray(aud) && aud.includes(clientId)))) throw new ChatGptAuthError("id token aud");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new ChatGptAuthError("id token exp");
  if (claims.nonce !== nonce) throw new ChatGptAuthError("id token nonce");
  const subject = str(claims.sub);
  if (!subject) throw new ChatGptAuthError("id token sub");
  return { subject, email: str(claims.email) };
}

// --- Code exchange -----------------------------------------------------------

/** Exchanges the callback code, verifies the ID token and stores identity and tokens; `planUsage` is false when the plan scope was not granted. */
export async function exchangeCode(a: { clientId: string; code: string; verifier: string; nonce: string; redirectUri: string; scope?: string }): Promise<{ planUsage: boolean }> {
  const { status, json } = await request(
    `${authBase()}/api/accounts/oauth/token`,
    new URLSearchParams({ grant_type: "authorization_code", client_id: a.clientId, code: a.code, code_verifier: a.verifier, redirect_uri: a.redirectUri, resource: RESOURCE }),
  );
  const accessToken = str(json.access_token);
  const idToken = str(json.id_token);
  if (status !== 200 || !accessToken || !idToken) throw new ChatGptAuthError(`code exchange rejected (${status})`);
  const identity = await verifyIdToken(idToken, a.clientId, a.nonce);
  const scopes = (str(json.scope) ?? a.scope ?? "").split(/\s+/).filter(Boolean);
  const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  state = { ...current(), clientId: a.clientId, subject: identity.subject, email: identity.email };
  setTokens({ idToken, accessToken, refreshToken: str(json.refresh_token), expiresAt: Date.now() + expiresIn * 1000, earliestRefreshAt: toMillis(json.earliest_refresh_at), scopes });
  return { planUsage: scopes.includes(PLAN_SCOPE) };
}

// --- Refresh -----------------------------------------------------------------

async function doRefresh(s: Stored): Promise<void> {
  if (!s.refreshToken || !s.clientId) return;
  if (s.earliestRefreshAt && Date.now() < s.earliestRefreshAt) return;
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(`${authBase()}/api/accounts/oauth/token`, new URLSearchParams({ grant_type: "refresh_token", client_id: s.clientId, refresh_token: s.refreshToken, resource: RESOURCE }));
  } catch (err) {
    console.error(`coati-broker: chatgpt refresh failed: ${err instanceof Error ? err.name : "error"}`);
    return;
  }
  const { status, json } = res;
  const accessToken = str(json.access_token);
  if (status === 200 && accessToken) {
    const scopes = str(json.scope)?.split(/\s+/).filter(Boolean) ?? s.scopes;
    const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
    setTokens({ idToken: s.idToken, accessToken, refreshToken: str(json.refresh_token) ?? s.refreshToken, expiresAt: Date.now() + expiresIn * 1000, earliestRefreshAt: toMillis(json.earliest_refresh_at), scopes });
    return;
  }
  const code = str(json.error) ?? "";
  if ((status === 400 || status === 401) && (TERMINAL_REFRESH_ERRORS.has(code) || /^invalid_|^refresh_token_/.test(code))) {
    console.error("coati-broker: chatgpt refresh refused, signed out");
    setTokens(NO_TOKENS);
  }
}

function refresh(): Promise<void> {
  const s = state;
  if (!s) return Promise.resolve();
  refreshing ??= doRefresh(s).finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

function validToken(): string | undefined {
  return state?.accessToken && state.expiresAt && state.expiresAt > Date.now() ? state.accessToken : undefined;
}

/** The access token, refreshed first when it expires within 5 minutes; undefined when signed out or unusable. */
export async function accessToken(): Promise<string | undefined> {
  if (!state?.accessToken) return undefined;
  if ((state.expiresAt ?? 0) - Date.now() <= REFRESH_MARGIN_MS) await refresh();
  return validToken();
}

/** Refreshes now (after a 401), joining a refresh already in flight; undefined when signed out or the server refused. */
export async function forceRefresh(): Promise<string | undefined> {
  if (!state?.accessToken) return undefined;
  await refresh();
  return validToken();
}

// --- Account, welcome flag, sign-out ------------------------------------------

/** True when tokens are held and the plan scope was granted. */
export function hasPlanUsage(): boolean {
  return Boolean(state?.accessToken && state.scopes?.includes(PLAN_SCOPE));
}

/** What the client may know: sign-in state, email, plan-usage flag, one-time welcome flag (never a token). */
export function account(): { signedIn: boolean; email?: string; planUsage: boolean; welcomed: boolean } {
  return { signedIn: Boolean(state?.accessToken), email: state?.email, planUsage: hasPlanUsage(), welcomed: state?.welcomed === true };
}

/** Marks the "You're using your ChatGPT plan" line as seen. */
export function setWelcomed(): void {
  current().welcomed = true;
  save();
}

/** Revokes the refresh token (when the discovery endpoint is acceptable) then clears the tokens, keeping host id, client id, subject and email. */
export async function signOut(): Promise<{ revokeConfirmed: boolean }> {
  const s = state;
  if (!s?.accessToken && !s?.refreshToken) return { revokeConfirmed: true };
  let confirmed = false;
  if (s.refreshToken && s.clientId) {
    try {
      const endpoint = str((await request(`${authBase()}/.well-known/openid-configuration`)).json.revocation_endpoint);
      if (endpoint && revocationAllowed(endpoint)) {
        const { status, json } = await request(endpoint, new URLSearchParams({ token: s.refreshToken, token_type_hint: "refresh_token", client_id: s.clientId }));
        confirmed = status === 200 && !json.error;
      }
    } catch (err) {
      console.error(`coati-broker: chatgpt revocation failed: ${err instanceof Error ? err.name : "error"}`);
    }
  }
  setTokens(NO_TOKENS);
  return { revokeConfirmed: confirmed };
}

function revocationAllowed(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.origin === CHATGPT_ISSUER || (Boolean(process.env.COATI_CHATGPT_AUTH_BASE) && url.origin === new URL(authBase()).origin);
  } catch {
    return false;
  }
}

/** S256 code challenge of a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
