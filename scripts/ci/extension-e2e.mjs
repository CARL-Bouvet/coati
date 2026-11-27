#!/usr/bin/env node
// scripts/ci/extension-e2e.mjs, "CI end to end": loads the built,
// unpacked Chrome/Brave extension (dist/stage/chrome — pinned ID via
// extension/manifest.json's "key", see docs/PROTOCOL.md)
// in a real Chromium via Playwright, wires the Native Messaging host
// manifest for a throwaway --user-data-dir, starts the broker on the REAL,
// fixed port 8787 (docs/PROTOCOL.md — the extension's CSP
// hard-codes it, COATI_PORT would make it refuse to connect) with a temp
// HOME and the fake provider module fixture, opens the panel page. Outside
// attach mode it then starts like a new user (a local OpenAI-compatible
// stand-in without its key): saving the key in the settings page must close
// the panel's first-run card. It sends a chat message, asserts the answer
// shows up, and checks the one-click OpenRouter sign-in and "Sign in with ChatGPT"
// (against a local stand-in of ChatGPT's auth and API servers).
//
// CI-only: needs Playwright's own downloaded Chromium
// (`npx playwright install --with-deps chromium`) and a free port 8787 — a
// normal dev machine typically has a real broker already listening there,
// and may lack a display/network. Only CI can tell whether it passes.
//
// Usage: node scripts/ci/extension-e2e.mjs
// Env:
//   COATI_E2E_BINARY      broker to spawn and to point the host manifest at
//                         (defaults to dist/bin/coati-broker-linux-x64).
//   COATI_E2E_ATTACH=1    the broker was installed and started by the real
//                         installer (scripts/ci/journey.sh): spawn nothing,
//                         write no config or manifest, use the real HOME and
//                         data dir, and leave the broker running. The caller
//                         wrote config.json before installing.
//   COATI_E2E_PROFILE_DIR use this --user-data-dir (kept afterwards) instead
//                         of a temporary one. Chromium reads the per-user
//                         manifest under it, so macOS passes the browser's
//                         default profile to see the installer's manifest.
//   COATI_E2E_CHANNEL     Playwright channel (default "chromium").
//   COATI_E2E_BROKER_LOG  broker log file, quoted in a failure report.
//   COATI_E2E_PORT        the port the broker listens on (default 8787); only the
//                         ChatGPT redirect address check and callback use it.

import { chromium } from "playwright";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const EXT_DIR = path.join(ROOT, "dist/stage/chrome");
const BINARY = process.env.COATI_E2E_BINARY || path.join(ROOT, "dist/bin/coati-broker-linux-x64");
const ATTACH = process.env.COATI_E2E_ATTACH === "1";
const CHANNEL = process.env.COATI_E2E_CHANNEL || "chromium";
const PORT = Number(process.env.COATI_E2E_PORT || 8787);
const PINNED_ID = "hehlgipomfminodhahcjbencblepjhah";
const FIXTURE = path.join(ROOT, "broker/test/fixtures/modules/valid-provider.ts");

function pass(msg) {
  console.log(`PASS: ${msg}`);
}

if (!existsSync(EXT_DIR)) {
  console.error(`FAIL: ${EXT_DIR} missing — run scripts/build.sh first`);
  process.exit(1);
}
if (!ATTACH && !existsSync(BINARY)) {
  console.error(`FAIL: ${BINARY} missing — run scripts/build-binaries.sh first`);
  process.exit(1);
}

const home = ATTACH ? homedir() : mkdtempSync(path.join(tmpdir(), "coati-ext-e2e-home-"));
const ownProfile = !process.env.COATI_E2E_PROFILE_DIR;
const userDataDir = process.env.COATI_E2E_PROFILE_DIR || mkdtempSync(path.join(tmpdir(), "coati-ext-e2e-profile-"));
const dataDir = ATTACH
  ? process.env.COATI_DATA_DIR || path.join(home, ".local", "share", "coati")
  : path.join(home, ".local", "share", "coati");
// What the browser (and so the native host) inherits: the test HOME and data
// dir, or the real ones when the installer set everything up.
const childEnv = ATTACH ? process.env : { ...process.env, HOME: home, COATI_DATA_DIR: dataDir };

let broker;
let fakeOpenRouter;
let fakeChatGPT;
const FAKE_MODEL_KEY = "sk-e2e-good";
const SIGNED_IN_KEY = `sk-or-v1-${"e2e0".repeat(16)}`;
const configPath = path.join(home, ".config", "coati", "config.json");
let exchangeBody = "";
let brokerLog = "";
const brokerLogTail = () =>
  process.env.COATI_E2E_BROKER_LOG && existsSync(process.env.COATI_E2E_BROKER_LOG)
    ? readFileSync(process.env.COATI_E2E_BROKER_LOG, "utf8")
    : brokerLog;

// What the ChatGPT stand-in issued and saw. `problems` collects contract violations it met.
const CHATGPT_CLIENT_ID = "oaiapp_e2e";
const CHATGPT_CODE = "e2e-chatgpt-code";
const CHATGPT_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const CHATGPT_ANSWER = ["E2E Chat", "GPT answer"];
const BANNED_RESPONSES_FIELDS = ["previous_response_id", "temperature", "top_p", "max_output_tokens", "metadata", "user", "truncation", "prompt"];
const chatgpt = { nonce: "", challenge: "", redirectUri: "", idToken: "", access: [], refresh: [], responses: [], problems: [] };
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "e2e-key", alg: "RS256", use: "sig" };
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function signIdToken() {
  const head = b64({ alg: "RS256", kid: jwk.kid, typ: "JWT" });
  const claims = b64({
    iss: "https://auth.openai.com",
    aud: CHATGPT_CLIENT_ID,
    sub: "e2e-subject",
    email: "e2e@example.com",
    nonce: chatgpt.nonce,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `${head}.${claims}.${sign("sha256", Buffer.from(`${head}.${claims}`), rsa.privateKey).toString("base64url")}`;
}

/** A new access token and a rotated refresh token (and an ID token on the first grant). */
function issueChatGPTTokens(withIdToken) {
  const n = chatgpt.access.length + 1;
  chatgpt.access.push(`e2e-access-${n}`);
  chatgpt.refresh.push(`e2e-refresh-${n}`);
  if (withIdToken) chatgpt.idToken = signIdToken();
  return {
    access_token: chatgpt.access.at(-1),
    refresh_token: chatgpt.refresh.at(-1),
    ...(withIdToken ? { id_token: chatgpt.idToken } : {}),
    scope: CHATGPT_SCOPE,
    expires_in: 3600,
    token_type: "Bearer",
  };
}

function responsesBodyProblems(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return ["body is not JSON"];
  }
  const out = [];
  if (body.store !== false) out.push("store is not false");
  if (body.stream !== true) out.push("stream is not true");
  if (typeof body.instructions !== "string" || !body.instructions.trim()) out.push("no instructions");
  for (const field of BANNED_RESPONSES_FIELDS) if (Object.hasOwn(body, field)) out.push(`banned field ${field}`);
  if (!Array.isArray(body.input) || body.input.some((item) => item?.role === "system")) out.push("input missing or has a system item");
  return out;
}

function createFakeChatGPT() {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = (status, value) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(value));
      };
      const { pathname } = new URL(req.url, "http://127.0.0.1");
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (pathname === "/api/accounts/oauth/token") {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") === "authorization_code") {
          const pkce = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === chatgpt.challenge;
          if (form.get("code") !== CHATGPT_CODE || form.get("client_id") !== CHATGPT_CLIENT_ID || form.get("redirect_uri") !== chatgpt.redirectUri || !pkce) {
            chatgpt.problems.push(`bad code exchange (pkce ${pkce}): ${body.replace(/code=[^&]*/, "code=…")}`);
            return json(400, { error: "invalid_grant" });
          }
          return json(200, issueChatGPTTokens(true));
        }
        if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === chatgpt.refresh.at(-1) && form.get("client_id") === CHATGPT_CLIENT_ID) {
          return json(200, issueChatGPTTokens(false));
        }
        chatgpt.problems.push(`bad token request: grant_type=${form.get("grant_type")} client_id=${form.get("client_id")}`);
        return json(400, { error: "invalid_grant" });
      }
      if (pathname === "/.well-known/jwks.json") return json(200, { keys: [jwk] });
      if (pathname === "/.well-known/openid-configuration") return json(200, { revocation_endpoint: `http://${req.headers.host}/oauth/revoke` });
      if (pathname === "/v1/models" && chatgpt.access.includes(bearer)) {
        return json(200, {
          models: [
            { slug: "e2e-gpt", display_name: "E2E GPT", visibility: "list" },
            { slug: "e2e-hidden", display_name: "Hidden", visibility: "hide" },
          ],
        });
      }
      if (pathname === "/v1/responses" && req.method === "POST") {
        const call = { auth: bearer, body };
        chatgpt.responses.push(call);
        chatgpt.problems.push(...responsesBodyProblems(body).map((p) => `/v1/responses #${chatgpt.responses.length}: ${p}`));
        // The first call is refused: the broker must refresh and retry once, with the new token.
        if (chatgpt.responses.length === 1) return json(401, { error: { code: "token_expired", message: "expired" } });
        res.setHeader("content-type", "text/event-stream");
        for (const delta of CHATGPT_ANSWER) res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`);
        return res.end(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 3 } } })}\n\n`);
      }
      json(chatgpt.access.includes(bearer) ? 404 : 401, { error: { message: "unexpected" } });
    });
  });
}

if (!ATTACH) {
  mkdirSync(path.join(home, ".config", "coati"), { recursive: true });
  writeFileSync(
    path.join(home, ".config", "coati", "config.json"),
    JSON.stringify(
      {
        port: 8787,
        allowedExtensionIds: [PINNED_ID],
        provider: "e2e-fixture",
        modules: [{ path: FIXTURE, options: { id: "e2e-fixture", label: "E2E Fixture" } }],
      },
      null,
      2,
    ),
  );

  // Where Chromium looks for a NativeMessagingHosts manifest for a custom
  // --user-data-dir isn't pinned down (see the module doc comment above) — the
  // manifest is written to every plausible candidate, all pointing at the same
  // binary, so whichever one the CI runner's Chromium actually reads works.
  const manifestTemplate = JSON.parse(
    readFileSync(path.join(ROOT, "packaging", "native-host", "com.getcoati.broker.chromium.json"), "utf8"),
  );
  manifestTemplate.path = BINARY;
  const manifestJson = JSON.stringify(manifestTemplate, null, 2);
  const candidateDirs = [
    path.join(userDataDir, "NativeMessagingHosts"),
    path.join(home, ".config", "google-chrome", "NativeMessagingHosts"),
    path.join(home, ".config", "chromium", "NativeMessagingHosts"),
  ];
  for (const dir of candidateDirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "com.getcoati.broker.json"), manifestJson);
  }

  // Local stand-ins: OpenRouter's code-for-key exchange (one-click sign-in step below) and an
  // OpenAI-compatible model that answers only once its key is saved (first-run step below).
  fakeOpenRouter = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url === "/auth/keys") {
        exchangeBody = body;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ key: SIGNED_IN_KEY }));
      }
      if (req.url === "/key") {
        res.statusCode = req.headers.authorization === `Bearer ${SIGNED_IN_KEY}` ? 200 : 401;
        return res.end("{}");
      }
      if (req.headers.authorization !== `Bearer ${FAKE_MODEL_KEY}`) {
        res.statusCode = 401;
        return res.end("{}");
      }
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: [{ id: "e2e-model" }] }));
      }
      res.setHeader("content-type", "text/event-stream");
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "echo: fake model" } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((r) => fakeOpenRouter.listen(0, "127.0.0.1", r));
  childEnv.COATI_OPENROUTER_API_BASE = `http://127.0.0.1:${fakeOpenRouter.address().port}`;
  // Start like a new user: an online service chosen, its key not saved yet.
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(
    configPath,
    JSON.stringify({ ...config, provider: "openai-compat", baseUrl: `http://127.0.0.1:${fakeOpenRouter.address().port}/v1`, model: "e2e-model" }, null, 2),
  );

  fakeChatGPT = createFakeChatGPT();
  await new Promise((r) => fakeChatGPT.listen(0, "127.0.0.1", r));
  childEnv.COATI_CHATGPT_AUTH_BASE = `http://127.0.0.1:${fakeChatGPT.address().port}`;
  childEnv.COATI_CHATGPT_API_BASE = `${childEnv.COATI_CHATGPT_AUTH_BASE}/v1`;

  broker = spawn(BINARY, ["--serve"], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  broker.stdout.on("data", (d) => (brokerLog += d));
  broker.stderr.on("data", (d) => (brokerLog += d));
}

let ctx;
function cleanup() {
  if (ATTACH) return;
  broker.kill();
  fakeOpenRouter.close();
  fakeChatGPT.close();
  rmSync(home, { recursive: true, force: true });
  if (ownProfile) rmSync(userDataDir, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${label}`);
}

try {
  await waitFor(() => existsSync(path.join(dataDir, "broker-key.json")), ATTACH ? 30000 : 10000, "broker-key.json");
  pass(`broker ${ATTACH ? "(started by the installer)" : "started"} on the real port 8787, key file written`);

  // `channel: "chromium"` forces Playwright's full Chrome binary rather than
  // its default, lighter `chromium-headless-shell` for headless runs — the
  // shell build does NOT support extensions at all (verified locally: with
  // it, ctx.serviceWorkers() simply stays empty, no error). The full binary
  // in headless:true uses Chromium's "new" headless mode, which does support
  // extensions. xvfb-run + headless:false is the fallback if a future
  // Chromium/Playwright bump regresses that (see this file's header).
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: CHANNEL,
    // The native host is launched BY Chromium and inherits its environment:
    // without the test HOME/COATI_DATA_DIR it would read the key file of
    // whatever broker belongs to the real account (none on a CI runner →
    // "no-host"; a developer's real broker locally → "broker-untrusted").
    env: childEnv,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  if (extensionId !== PINNED_ID) {
    throw new Error(
      `extension loaded under id ${extensionId}, expected the pinned id ${PINNED_ID} — ` +
        `did dist/stage/chrome/manifest.json lose its "key" field?`,
    );
  }
  pass(`extension loaded, pinned id confirmed (${extensionId})`);

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extensionId}/panel/panel.html`);

  await waitFor(
    async () => {
      const cls = await page.locator("#status").getAttribute("class").catch(() => "");
      return (cls || "").includes("status--connected");
    },
    20000,
    "status--connected",
  ).catch(async (err) => {
    const cls = await page.locator("#status").getAttribute("class").catch(() => "?");
    const text = await page.locator("#status").textContent().catch(() => "?");
    const banner = await page.locator("body").innerText().catch(() => "?");
    throw new Error(
      `${err.message}\nstatus class="${cls}" text="${text}"\n--- panel text ---\n${banner.slice(0, 800)}` +
        `\n--- broker log ---\n${brokerLogTail()}`,
    );
  });
  pass("panel reached status--connected (Native Messaging handshake succeeded)");

  let options;
  const optionsErrors = [];
  if (!ATTACH) {
    // The first-run card says the model does not answer; saving the key in the settings page
    // must close it in the open panel, with no reload.
    const modelStep = page.locator('#firstRun:not([hidden]) .first-run-step[data-check="model"][data-status="missing"]');
    await waitFor(async () => (await modelStep.count()) > 0, 15_000, "first-run card: model missing");
    options = await ctx.newPage();
    options.on("pageerror", (e) => optionsErrors.push(String(e)));
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    // A loopback address counts as "on this computer", where the settings page shows no key
    // field: send exactly what the key field sends (lib/key-input.js submit()).
    await options.waitForFunction(() => document.getElementById("status")?.className.includes("status--connected"));
    await options.evaluate(
      (key) => chrome.runtime.sendMessage({ type: "coati:client-message", payload: { type: "settings.set", id: "e2e-key", provider: "openai-compat", apiKey: key } }),
      FAKE_MODEL_KEY,
    );
    await waitFor(async () => await page.locator("#firstRun").isHidden(), 10_000, "first-run card closing after the key is saved").catch(
      async (err) => {
        const card = await page.locator("#firstRun").innerText().catch(() => "?");
        throw new Error(`${err.message}\n--- card ---\n${card}\n--- broker log ---\n${brokerLogTail()}`);
      },
    );
    pass("key saved in the settings page: the open panel's first-run card closed without a reload");
  }
  // Attach mode starts with a working model, so the card closes by itself. Either way, the card
  // closing starts the guided tour once, and the tour covers the composer.
  await page.locator(".tour .tour-skip").click({ timeout: 15_000 });

  // The panel is opened as a plain tab, so there is no page Coati may read:
  // the question must still go out, without the page (no switch to turn page
  // reading off any more — an unreadable tab never blocks a question).
  async function askPanel(question, expected) {
    await page.locator("#input").fill(question);
    await page.locator("#send").click();
    await waitFor(
      async () => {
        const bubble = page.locator(".message--assistant").last();
        if ((await bubble.count()) === 0) return false;
        const streaming = await page.locator(".message--assistant.message--streaming").count();
        const text = await bubble.textContent().catch(() => "");
        return streaming === 0 && !!text && text.includes(expected);
      },
      30000,
      `assistant answer containing "${expected}"`,
    ).catch(async (err) => {
      const panel = await page.locator("body").innerText().catch(() => "?");
      const html = await page.locator("#messages, main, body").first().innerHTML().catch(() => "?");
      throw new Error(
        `${err.message}\n--- panel text ---\n${panel.slice(0, 800)}\n--- markup ---\n${html.slice(0, 1500)}` +
          `\n--- broker log ---\n${brokerLogTail()}`,
      );
    });
    return page.locator(".message--assistant").last().textContent();
  }
  const answerText = await askPanel(`coati extension e2e ${Date.now()}`, "echo:");
  pass(`assistant answer received from the fake provider: ${answerText.slice(0, 80)}`);

  // The settings page loads as a module graph the lab bundle never exercises.
  if (!options) {
    options = await ctx.newPage();
    options.on("pageerror", (e) => optionsErrors.push(String(e)));
  }
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await waitFor(
    async () => (await options.locator("#setupLocal .setup-step").count()) > 0,
    15_000,
    "settings page renders the local setup guide",
  );
  if (optionsErrors.length) throw new Error(`settings page errors:\n${optionsErrors.join("\n")}`);
  pass("settings page rendered the local setup guide without errors");

  if (!ATTACH) {
    // One-click sign-in: the guide asks the program for the sign-in address and opens it; the
    // provider then sends the browser back to the program, which exchanges the code for a key.
    const pickService = async (id, name) => {
      const row = options.locator(`.setup-service[data-service="${id}"]:visible`);
      await waitFor(
        async () => {
          if ((await row.count()) > 0) return true;
          if ((await options.locator("#tabOnline").getAttribute("aria-expanded")) !== "true") await options.locator("#tabOnline").click();
          // A service already chosen folds the list behind its "Change" button.
          const change = options.locator(".setup-service-chosen:visible button");
          if ((await change.count()) > 0) await change.click();
          await options.locator("#addService").evaluate((d) => (d.open = true));
          return false;
        },
        10_000,
        "the online side's service list",
      );
      await row.click();
      if (!(await options.locator(".setup-service-chosen:visible", { hasText: name }).count())) throw new Error(`the service list did not fold to ${name}`);
    };
    // Clicks the guide's sign-in button and returns the tab the extension opened on `prefix`.
    const openSignInTab = async (prefix) => {
      await options.locator(".setup-oauth button:visible").click();
      // The real site may already have bounced the tab to its sign-up page, which carries the
      // sign-in address as `redirect_url`.
      const find = () => ctx.pages().find((p) => p.url().startsWith(prefix));
      await waitFor(async () => Boolean(find()), 10_000, "the sign-in tab").catch(async (err) => {
        const status = await options.locator(".setup-oauth").innerText().catch(() => "?");
        throw new Error(`${err.message}\ntabs: ${ctx.pages().map((p) => p.url()).join(" | ")}\nguide: ${status}\n--- broker log ---\n${brokerLogTail()}`);
      });
      return find();
    };
    await pickService("openrouter", "OpenRouter");
    const signIn = await openSignInTab("https://openrouter.ai/");
    const opened = new URL(signIn.url());
    const authUrl = opened.pathname === "/auth" ? opened : new URL(opened.searchParams.get("redirect_url"));
    await signIn.close();
    const callback = new URL(authUrl.searchParams.get("callback_url"));
    if (authUrl.host !== "openrouter.ai" || callback.hostname !== "localhost") throw new Error(`unexpected sign-in address ${authUrl}`);
    callback.search = new URLSearchParams({ code: "e2e-code", state: authUrl.searchParams.get("state") }).toString();
    const back = await ctx.newPage();
    const response = await back.goto(callback.toString());
    if (response.status() !== 200) throw new Error(`callback answered ${response.status()}: ${await back.locator("body").innerText()}`);
    if (!exchangeBody.includes('"code":"e2e-code"')) throw new Error(`exchange not received: ${exchangeBody}`);
    const saved = JSON.parse(readFileSync(path.join(home, ".config", "coati", "config.json"), "utf8"));
    if (saved.provider !== "openai-compat" || saved.baseUrl !== "https://openrouter.ai/api/v1" || !saved.apiKeys?.["openai-compat"]?.["https://openrouter.ai"]) {
      throw new Error(`OpenRouter not active after sign-in: provider=${saved.provider} baseUrl=${saved.baseUrl}`);
    }
    // The guide then checks the key on screen; no model is chosen for the user, the list is offered.
    if (saved.model !== undefined) throw new Error(`a model was chosen for the user: ${saved.model}`);
    const modelInGuide = options.locator("#setupOnline #modelField:not([hidden])");
    await waitFor(async () => (await modelInGuide.count()) > 0, 15_000, "the guide offers the model list under the key").catch(async (err) => {
      const block = await options.locator("#setupOnline").innerText();
      throw new Error(`${err.message}\nguide:\n${block.slice(-600)}\n--- broker log ---\n${brokerLogTail()}`);
    });
    const focused = await options.evaluate(() => document.activeElement?.id);
    if (focused !== "modelSearch" && focused !== "modelInput") throw new Error(`model field not focused (${focused})`);
    if ((await options.locator('#serviceList a[href="https://openrouter.ai/settings/keys"]').count()) !== 1) {
      throw new Error("the configured OpenRouter row has no link to its keys page");
    }
    pass("one-click OpenRouter sign-in: callback on localhost, code exchanged, key saved and checked, model list focused");

    // Sign in with ChatGPT: the browser tab is held on a stub (the real site is never reached),
    // the redirect goes to the broker, and the tokens stay in the broker's own file.
    const consoleLines = [];
    ctx.on("console", (m) => consoleLines.push(m.text()));
    await ctx.route("https://auth.openai.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>sign-in</title>" }));
    const chatgptFailure = async (err) => {
      throw new Error(`${err.message}\nfake ChatGPT problems: ${chatgpt.problems.join(" | ") || "none"}\n--- broker log ---\n${brokerLogTail()}`);
    };
    await pickService("chatgpt", "ChatGPT");
    const chatgptTab = await openSignInTab("https://auth.openai.com/api/accounts/authorize?");
    const authorize = new URL(chatgptTab.url());
    await chatgptTab.close();
    const q = (name) => authorize.searchParams.get(name);
    const redirectUri = `http://127.0.0.1:${PORT}/auth/callback`;
    const scopes = (q("scope") ?? "").split(" ");
    const authorizeChecks = {
      redirect_uri: q("redirect_uri") === redirectUri,
      client_id: q("client_id") === "dynamic_agent_client",
      agent_name_hint: q("agent_name_hint") === "Coati",
      ext_agent_host_id: (q("ext_agent_host_id") ?? "").startsWith("urn:uuid:"),
      scope: scopes.includes("chatgpt.tokens.use.direct"),
      resource: Boolean(q("resource")),
      code_challenge_method: q("code_challenge_method") === "S256",
      code_challenge: Boolean(q("code_challenge")),
      state: Boolean(q("state")),
      nonce: Boolean(q("nonce")),
      "no id_token_hint": !authorize.searchParams.has("id_token_hint"),
    };
    const badChecks = Object.keys(authorizeChecks).filter((name) => !authorizeChecks[name]);
    if (badChecks.length) throw new Error(`authorize address fails ${badChecks.join(", ")}: ${authorize}`);
    chatgpt.nonce = q("nonce");
    chatgpt.challenge = q("code_challenge");
    chatgpt.redirectUri = redirectUri;
    pass("ChatGPT sign-in opened the authorize address with the expected parameters and no id_token_hint");

    const chatgptCallback = new URL(redirectUri);
    chatgptCallback.search = new URLSearchParams({ code: CHATGPT_CODE, state: q("state"), client_id: CHATGPT_CLIENT_ID, scope: CHATGPT_SCOPE }).toString();
    const chatgptBack = await ctx.newPage();
    const chatgptResponse = await chatgptBack.goto(chatgptCallback.toString());
    const chatgptPage = `${await chatgptBack.content()}\n${await chatgptBack.locator("body").innerText()}`;
    if (chatgptResponse.status() !== 200) await chatgptFailure(new Error(`ChatGPT callback answered ${chatgptResponse.status()}: ${chatgptPage.slice(0, 300)}`));
    if (/eyJ/.test(chatgptPage) || [...chatgpt.access, ...chatgpt.refresh].some((tok) => chatgptPage.includes(tok))) throw new Error("the callback page carries a token");
    await chatgptBack.close();
    const authFile = path.join(home, ".config", "coati", "chatgpt-auth.json");
    if (!existsSync(authFile)) await chatgptFailure(new Error("chatgpt-auth.json was not written"));
    const authMode = statSync(authFile).mode & 0o777;
    if (authMode !== 0o600) throw new Error(`chatgpt-auth.json mode is ${authMode.toString(8)}, expected 600`);
    const chatgptSaved = JSON.parse(readFileSync(configPath, "utf8"));
    if (chatgptSaved.provider !== "chatgpt") throw new Error(`ChatGPT not active after sign-in: provider=${chatgptSaved.provider}`);
    if (chatgptSaved.model !== undefined) throw new Error(`a model was chosen for the user: ${chatgptSaved.model}`);
    pass("ChatGPT callback: 200, no token in the page, chatgpt-auth.json is 0600, provider chatgpt, no model chosen");

    // The one-time welcome line sits in the guide's access block; its button is the only one there.
    const welcomeButton = options.locator(".setup-online-access .setup-text button:visible");
    await waitFor(async () => (await welcomeButton.count()) > 0, 15_000, "the ChatGPT welcome line").catch(async (err) => {
      const block = await options.locator("#setupOnline").innerText().catch(() => "?");
      return chatgptFailure(new Error(`${err.message}\nguide:\n${block.slice(-600)}`));
    });
    await welcomeButton.click();
    await waitFor(() => JSON.parse(readFileSync(authFile, "utf8")).welcomed === true, 10_000, "the welcome flag saved");
    await waitFor(async () => (await welcomeButton.count()) === 0, 10_000, "the welcome line closing");
    const picker = options.locator("#setupOnline #modelField:not([hidden]) #modelPickerList");
    await waitFor(async () => (await picker.locator('[data-model="e2e-gpt"]').count()) > 0, 15_000, "the guide offers E2E GPT").catch(async (err) => {
      const block = await options.locator("#setupOnline").innerText().catch(() => "?");
      return chatgptFailure(new Error(`${err.message}\nguide:\n${block.slice(-600)}`));
    });
    const listText = await picker.innerText();
    if (!listText.includes("E2E GPT") || listText.includes("Hidden") || (await picker.locator('[data-model="e2e-hidden"]').count()) !== 0) {
      throw new Error(`the model list must offer "E2E GPT" and not "Hidden":\n${listText}`);
    }
    await picker.locator('[data-model="e2e-gpt"]').click();
    await waitFor(() => JSON.parse(readFileSync(configPath, "utf8")).model === "e2e-gpt", 10_000, "model e2e-gpt saved");
    pass("ChatGPT guide: welcome line dismissed, model list shows E2E GPT without the hidden model, e2e-gpt chosen");

    const chatgptAnswer = await askPanel(`coati chatgpt e2e ${Date.now()}`, CHATGPT_ANSWER.join("")).catch(chatgptFailure);
    const [refused, retried] = chatgpt.responses;
    if (chatgpt.responses.length !== 2 || chatgpt.access.length !== 2 || retried.auth !== chatgpt.access[1] || refused.auth === retried.auth) {
      throw new Error(
        `expected a 401 then one retry with the refreshed token: calls=${chatgpt.responses.length} tokens issued=${chatgpt.access.length} ` +
          `retry used refreshed=${retried?.auth === chatgpt.access[1]}\n--- broker log ---\n${brokerLogTail()}`,
      );
    }
    if (chatgpt.problems.length) throw new Error(`fake ChatGPT saw contract violations:\n${chatgpt.problems.join("\n")}`);
    pass(`ChatGPT answer in the panel (${chatgptAnswer.slice(0, 40)}); the 401 triggered one refresh and one retry with the new token; request bodies stateless and minimal`);

    // No token reaches the extension: not its storage, not its consoles.
    const stored = await options.evaluate(async () => JSON.stringify({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
    const secrets = [...chatgpt.access, ...chatgpt.refresh, chatgpt.idToken, CHATGPT_CODE];
    for (const [where, text] of [["chrome.storage", stored], ["console", consoleLines.join("\n")]]) {
      if (/eyJ/.test(text) || secrets.some((secret) => text.includes(secret))) throw new Error(`a ChatGPT token or code shows up in ${where}`);
    }
    pass(`no ChatGPT token in chrome.storage.local/session or in ${consoleLines.length} console messages`);
  }

  console.log("== scripts/ci/extension-e2e.mjs: ALL PASS ==");
} catch (err) {
  console.error(`FAIL: ${err.stack || err}`);
  if (process.env.GITHUB_ACTIONS) {
    // Job logs need a signed-in account; annotations are public.
    const enc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");
    const body = `${err.stack || err}\n--- broker log (tail) ---\n${brokerLogTail().split("\n").slice(-25).join("\n")}`;
    console.log(`::error title=scripts/ci/extension-e2e.mjs::${enc(body).slice(0, 6000)}`);
  }
  process.exitCode = 1;
} finally {
  if (ctx) await ctx.close().catch(() => {});
  cleanup();
}
